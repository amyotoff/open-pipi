import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModules() {
    vi.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-memory-backfill-${Date.now()}`,
        HOUSEHOLD_CHAT_ID: 'chat-1',
    };

    const db = await import('../db');
    db.initDatabase();
    return {
        db,
        memoryBackfill: await import('./memory-backfill'),
        memoryContext: await import('./memory-context'),
    };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/memory-backfill', () => {
    it('backfills legacy notes, diary, and insights into structured memory without duplicating entries', async () => {
        const { db, memoryBackfill, memoryContext } = await loadModules();

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        db.upsertChat({ jid: 'chat-1', type: 'group' });

        db.getDb().exec(`
            CREATE TABLE IF NOT EXISTS resident_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resident_tg_id TEXT,
                resident_name TEXT,
                fact TEXT NOT NULL,
                category TEXT DEFAULT 'general',
                source TEXT DEFAULT 'observation',
                created_at TEXT,
                updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS house_diary (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                entry TEXT NOT NULL,
                type TEXT DEFAULT 'daily',
                token_count INTEGER DEFAULT 0,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS daily_insights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                resident_tg_id TEXT,
                insight TEXT NOT NULL,
                created_at TEXT
            );
        `);

        db.getDb()
            .prepare(
                `
            INSERT INTO resident_notes (resident_tg_id, resident_name, fact, category, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                '111',
                'Alice',
                'prefers tea in the morning',
                'preference',
                '2026-03-20T09:00:00.000Z',
                '2026-03-20T09:00:00.000Z'
            );
        db.getDb()
            .prepare(
                `
            INSERT INTO resident_notes (resident_tg_id, resident_name, fact, category, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                null,
                'household',
                'quiet hours begin after 22:00',
                'general',
                '2026-03-21T10:00:00.000Z',
                '2026-03-21T10:00:00.000Z'
            );
        db.getDb()
            .prepare(
                `
            INSERT INTO resident_notes (resident_tg_id, resident_name, fact, category, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                '111',
                'Alice',
                'birthday on 14 May',
                'important_date',
                '2026-03-21T11:00:00.000Z',
                '2026-03-21T11:00:00.000Z'
            );

        db.getDb()
            .prepare(
                `
            INSERT INTO house_diary (date, entry, type, created_at)
            VALUES (?, ?, ?, ?), (?, ?, ?, ?)
        `
            )
            .run(
                '2026-03-18',
                'The team finished the sprint review.',
                'daily',
                '2026-03-18T19:00:00.000Z',
                '2026-03-16',
                'A calm week with a clean wrap-up.',
                'weekly_summary',
                '2026-03-16T20:00:00.000Z'
            );

        db.getDb()
            .prepare(
                `
            INSERT INTO daily_insights (date, resident_tg_id, insight, created_at)
            VALUES (?, ?, ?, ?), (?, ?, ?, ?)
        `
            )
            .run(
                '2026-03-20',
                '111',
                'Alice sounded tired after lunch.',
                '2026-03-20T15:00:00.000Z',
                '2026-03-20',
                null,
                'The group kept circling around the same blocker.',
                '2026-03-20T16:00:00.000Z'
            );

        const first = memoryBackfill.backfillLegacyMemory();
        const second = memoryBackfill.backfillLegacyMemory();

        expect(first).toEqual({
            resident_notes: 3,
            house_diary: 2,
            daily_insights: 2,
        });
        expect(second).toEqual({
            resident_notes: 0,
            house_diary: 0,
            daily_insights: 0,
        });

        const personMemory = db.getMemoryEntries('person', '111', undefined, 20);
        const spaceMemory = db.getMemoryEntries('space', db.buildTelegramSpaceId('chat-1'), undefined, 20);
        const workMemory = db.getMemoryEntries('work', db.buildTelegramSpaceId('chat-1'), undefined, 20);

        expect(personMemory.some((entry) => entry.kind === 'preference' && entry.content.includes('prefers tea'))).toBe(
            true
        );
        expect(personMemory.some((entry) => entry.kind === 'important_date' && entry.content.includes('14 May'))).toBe(
            true
        );
        expect(
            personMemory.some((entry) => entry.kind === 'insight' && entry.content.includes('tired after lunch'))
        ).toBe(true);
        expect(spaceMemory.some((entry) => entry.kind === 'general' && entry.content.includes('quiet hours'))).toBe(
            true
        );
        expect(spaceMemory.some((entry) => entry.kind === 'diary' && entry.content.includes('sprint review'))).toBe(
            true
        );
        expect(
            spaceMemory.some(
                (entry) => entry.kind === 'recollection' && entry.content.includes('Legacy diary recollection')
            )
        ).toBe(true);
        expect(workMemory.some((entry) => entry.kind === 'insight' && entry.content.includes('same blocker'))).toBe(
            true
        );

        const importantDates = memoryContext.getImportantDatesContext();
        const context = memoryContext.getMemoryContext({ residentId: '111', chatId: 'chat-1' });

        expect(importantDates).toContain('birthday on 14 May');
        expect(context).toContain('prefers tea in the morning');
    });

    it('preserves scoped legacy DM notes when backfilling into structured memory', async () => {
        const { db, memoryBackfill, memoryContext } = await loadModules();

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        db.upsertChat({ jid: 'chat-1', type: 'group' });
        db.upsertChat({ jid: 'chat-2', type: 'private' });

        db.getDb().exec(`
            CREATE TABLE IF NOT EXISTS resident_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resident_tg_id TEXT,
                resident_name TEXT,
                fact TEXT NOT NULL,
                category TEXT DEFAULT 'general',
                source TEXT DEFAULT 'observation',
                chat_jid TEXT,
                scope TEXT DEFAULT 'global',
                created_at TEXT,
                updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS daily_insights (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                resident_tg_id TEXT,
                insight TEXT NOT NULL,
                chat_jid TEXT,
                scope TEXT DEFAULT 'global',
                created_at TEXT
            );
        `);

        db.getDb()
            .prepare(
                `
            INSERT INTO resident_notes (resident_tg_id, resident_name, fact, category, chat_jid, scope, created_at, updated_at)
            VALUES
            ('111', 'Alice', 'global note survives everywhere', 'general', NULL, 'global', ?, ?),
            ('111', 'Alice', 'chat-1 note stays in chat one', 'general', 'chat-1', 'private', ?, ?),
            ('111', 'Alice', 'chat-2 note stays in chat two', 'general', 'chat-2', 'private', ?, ?)
        `
            )
            .run(
                '2026-03-20T09:00:00.000Z',
                '2026-03-20T09:00:00.000Z',
                '2026-03-20T10:00:00.000Z',
                '2026-03-20T10:00:00.000Z',
                '2026-03-20T11:00:00.000Z',
                '2026-03-20T11:00:00.000Z'
            );

        db.getDb()
            .prepare(
                `
            INSERT INTO daily_insights (date, resident_tg_id, insight, chat_jid, scope, created_at)
            VALUES
            ('2026-03-20', '111', 'chat-1 daily insight stays private', 'chat-1', 'private', ?),
            ('2026-03-20', '111', 'chat-2 daily insight stays private', 'chat-2', 'private', ?)
        `
            )
            .run('2026-03-20T12:00:00.000Z', '2026-03-20T13:00:00.000Z');

        expect(memoryBackfill.backfillLegacyMemory()).toMatchObject({
            resident_notes: 3,
            daily_insights: 2,
        });

        const chatOneContext = memoryContext.getMemoryContext({ residentId: '111', chatId: 'chat-1' });
        const chatTwoContext = memoryContext.getMemoryContext({ residentId: '111', chatId: 'chat-2' });

        expect(chatOneContext).toContain('global note survives everywhere');
        expect(chatOneContext).toContain('chat-1 note stays in chat one');
        expect(chatOneContext).toContain('chat-1 daily insight stays private');
        expect(chatOneContext).not.toContain('chat-2 note stays in chat two');
        expect(chatOneContext).not.toContain('chat-2 daily insight stays private');

        expect(chatTwoContext).toContain('global note survives everywhere');
        expect(chatTwoContext).toContain('chat-2 note stays in chat two');
        expect(chatTwoContext).toContain('chat-2 daily insight stays private');
        expect(chatTwoContext).not.toContain('chat-1 note stays in chat one');
        expect(chatTwoContext).not.toContain('chat-1 daily insight stays private');
    });
});
