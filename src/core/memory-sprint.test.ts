import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModules() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-memory-sprint-${Date.now()}` };
    const db = await import('../db');
    db.initDatabase();
    const sprints = await import('./memory-sprint');
    return { db, sprints };
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

describe('core/memory-sprint', () => {
    it('compacts a closed sprint into long-memory recollections', async () => {
        const { db, sprints } = await loadModules();

        db.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'group_chat',
            title: 'Office',
            channel: 'telegram',
            external_ref: 'chat-1',
            assistant_pack_id: 'office',
            policy_json: JSON.stringify({ memory_sprint_days: 7 }),
        });

        db.getDb()
            .prepare(
                `
            INSERT INTO memory_sprints (id, space_id, opened_at, closes_at, status, cadence_days, summary, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                'sprint:telegram:chat-1:old',
                'telegram:chat-1',
                '2026-03-01T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z',
                'closed',
                7,
                '',
                '2026-03-01T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z'
            );

        db.rememberMemoryEntry({
            scope_type: 'space',
            scope_id: 'telegram:chat-1',
            memory_sprint_id: 'sprint:telegram:chat-1:old',
            kind: 'diary',
            content: 'The team kept circling around the board update deadline.',
            salience: 0.7,
            source: 'test',
        });
        db.rememberMemoryEntry({
            scope_type: 'work',
            scope_id: 'telegram:chat-1',
            memory_sprint_id: 'sprint:telegram:chat-1:old',
            kind: 'workflow_artifact',
            content: 'Saved office_followup for pack "office": Hiring sync -> .pipi/office/hiring-sync.md',
            salience: 0.8,
            source: 'test',
        });

        const compacted = sprints.compactClosedSprints('telegram:chat-1', new Date('2026-03-10T10:00:00.000Z'));
        const sprint = db
            .getDb()
            .prepare('SELECT * FROM memory_sprints WHERE id = ?')
            .get('sprint:telegram:chat-1:old') as any;
        const recollections = db.getMemoryEntries(undefined, undefined, 'recollection', 10);

        expect(compacted).toBe(1);
        expect(sprint.status).toBe('compacted');
        expect(sprint.summary).toContain('Reflection:');
        expect(recollections.some((entry) => entry.content.includes('2026-03-01 -> 2026-03-08'))).toBe(true);
    });

    it('prefers compacted recollections over raw old sprint entries in long memory', async () => {
        const { db, sprints } = await loadModules();

        db.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'group_chat',
            title: 'Office',
            channel: 'telegram',
            external_ref: 'chat-1',
            assistant_pack_id: 'office',
            policy_json: JSON.stringify({ memory_sprint_days: 7 }),
        });

        db.getDb()
            .prepare(
                `
            INSERT INTO memory_sprints (id, space_id, opened_at, closes_at, status, cadence_days, summary, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                'sprint:telegram:chat-1:old',
                'telegram:chat-1',
                '2026-03-01T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z',
                'closed',
                7,
                '',
                '2026-03-01T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z'
            );
        db.rememberMemoryEntry({
            scope_type: 'work',
            scope_id: 'telegram:chat-1',
            memory_sprint_id: 'sprint:telegram:chat-1:old',
            kind: 'task_outcome',
            content: 'Task "Morning briefing" completed: sent:assistant_prompt',
            salience: 0.6,
            source: 'test',
        });

        sprints.compactClosedSprints('telegram:chat-1', new Date('2026-03-10T10:00:00.000Z'));
        const longMemory = sprints.getOlderLongMemoryEntries('telegram:chat-1', 4);

        expect(longMemory.length).toBeGreaterThan(0);
        expect(longMemory.every((entry) => entry.kind === 'recollection')).toBe(true);
    });
});
