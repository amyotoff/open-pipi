import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const briefTool = require('../packs/jeeves/tools/brief_note.tool.js').packTool;
const reviewTool = require('../packs/jeeves/tools/review_note.tool.js').packTool;
const focusTool = require('../packs/jeeves/tools/focus_plan.tool.js').packTool;
const googleDocTool = require('../packs/office/tools/office_read_google_doc.tool.js').packTool;
const kanbanTool = require('../packs/office/tools/office_kanban_board.tool.js').packTool;
let currentPackTools = [briefTool, reviewTool, focusTool];

describe('core/pack-tool-runtime', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = {
            ...ORIGINAL_ENV,
            DATA_DIR: `/tmp/open-pipi-pack-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
        currentPackTools = [briefTool, reviewTool, focusTool];
        vi.doMock('./agent-kernel', () => ({
            materializeAgentForSpace: vi.fn(() => ({
                pack_tools: currentPackTools,
            })),
        }));
    });

    afterEach(async () => {
        try {
            const db = await import('../db');
            db.closeDatabase();
        } catch {}
        process.env = { ...ORIGINAL_ENV };
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('executes installable Jeeves pack tools against the current space snapshot', async () => {
        const db = await import('../db');
        const runtime = await import('./pack-tool-runtime');

        db.initDatabase();
        db.getDb().exec(`
            CREATE TABLE IF NOT EXISTS todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                space_id TEXT,
                task TEXT NOT NULL,
                status TEXT DEFAULT 'pending'
            );
        `);

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        db.upsertChat({ jid: 'chat-pack', type: 'group' });
        const space = db.ensureTelegramSpace('chat-pack', 'group', 'Pack Chat');
        db.ensureSpaceMembership(space.id, '111', 'owner');
        db.upsertChat({ jid: 'chat-other', type: 'group' });
        const otherSpace = db.ensureTelegramSpace('chat-other', 'group', 'Other Chat');
        db.getDb()
            .prepare(`INSERT INTO todos (space_id, task, status) VALUES (?, ?, 'pending')`)
            .run(space.id, 'Call the bank');
        db.getDb()
            .prepare(`INSERT INTO todos (space_id, task, status) VALUES (?, ?, 'pending')`)
            .run(otherSpace.id, 'Book the dentist');
        db.getDb()
            .prepare(
                `
            INSERT INTO reminders (chat_jid, sender_tg_id, content, remind_at, status, created_at)
            VALUES (?, ?, ?, ?, 'pending', ?)
        `
            )
            .run(
                'chat-pack',
                '111',
                'Call back',
                new Date(Date.now() + 3600_000).toISOString(),
                new Date().toISOString()
            );
        db.upsertTask({
            id: 'task:chat-pack:morning',
            space_id: space.id,
            title: 'Morning briefing',
            prompt: 'brief',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            created_by: 'system',
        });

        const context = {
            chatId: 'chat-pack',
            userId: '111',
            spaceId: space.id,
            channel: 'telegram',
            channelRef: 'chat-pack',
        };

        const brief = await runtime.executePackTool('jeeves_brief_note', {}, context);
        expect(brief).toContain('Jeeves brief');
        expect(brief).toContain('Pending: 1 todos, 1 reminders');
        expect(brief).toContain('Active tasks: 1');

        const review = await runtime.executePackTool('jeeves_review_note', {}, context);
        expect(review).toContain('Jeeves review');
        expect(review).toContain('Reflection: keep tomorrow pointed at the smallest useful next step');
    });

    it('reads an accessible Google Doc through the office pack tool', async () => {
        currentPackTools = [googleDocTool];
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            text: async () => 'Team priorities\n- Ship the launch brief\n- Confirm owner for support rota',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const db = await import('../db');
        const runtime = await import('./pack-tool-runtime');

        db.initDatabase();
        const space = db.ensureTelegramSpace('chat-office-docs', 'group', 'Office Docs');
        db.updateSpaceAssistantPack(space.id, 'office');

        const result = await runtime.executePackTool(
            'office_read_google_doc',
            {
                url: 'https://docs.google.com/document/d/doc-123/edit?usp=sharing',
                max_chars: 2000,
            },
            {
                chatId: 'chat-office-docs',
                userId: '111',
                spaceId: space.id,
                channel: 'telegram',
                channelRef: 'chat-office-docs',
            }
        );

        expect(fetchMock).toHaveBeenCalledWith(
            'https://docs.google.com/document/d/doc-123/export?format=txt',
            expect.objectContaining({ headers: { accept: 'text/plain' } })
        );
        expect(result).toContain('Google Docs reading result');
        expect(result).toContain('Document ID: doc-123');
        expect(result).toContain('Ship the launch brief');
        expect(result).toContain('Confirm owner for support rota');
    });

    it('returns a friendly fallback when a pack tool finishes without text', async () => {
        currentPackTools = [
            {
                id: 'quiet_tool',
                run: vi.fn(async () => '   '),
            },
        ];

        const db = await import('../db');
        const runtime = await import('./pack-tool-runtime');

        db.initDatabase();
        db.getDb().exec(`
            CREATE TABLE IF NOT EXISTS todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                space_id TEXT,
                task TEXT NOT NULL,
                status TEXT DEFAULT 'pending'
            );
        `);

        const space = db.ensureTelegramSpace('chat-quiet', 'group', 'Quiet Chat');
        const result = await runtime.executePackTool(
            'quiet_tool',
            {},
            {
                chatId: 'chat-quiet',
                userId: '111',
                spaceId: space.id,
                channel: 'telegram',
                channelRef: 'chat-quiet',
            }
        );

        expect(result).toBe('Pack tool "quiet_tool" completed without a textual result.');
    });

    it('drafts an office kanban board from explicit status columns', async () => {
        currentPackTools = [kanbanTool];

        const db = await import('../db');
        const runtime = await import('./pack-tool-runtime');

        db.initDatabase();
        const space = db.ensureTelegramSpace('chat-kanban', 'group', 'Kanban Chat');
        db.updateSpaceAssistantPack(space.id, 'office');

        const result = await runtime.executePackTool(
            'office_kanban_board',
            {
                title: 'Launch Board',
                todo: 'Write copy',
                doing: 'Review contract',
                done: 'Create request',
            },
            {
                chatId: 'chat-kanban',
                userId: '111',
                spaceId: space.id,
                channel: 'telegram',
                channelRef: 'chat-kanban',
            }
        );

        expect(result).toContain('Office kanban board draft');
        expect(result).toContain('kind "kanban_board"');
        expect(result).toContain('## To do');
        expect(result).toContain('- Review contract');
    });
});
