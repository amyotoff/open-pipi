import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadJeevesModule() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-jeeves-mvp-${Date.now()}` };

    const processWithLLM = vi.fn(async () => ({ text: 'A compact Jeeves note.' }));
    const composeConversationContext = vi.fn(() => ({
        llmMessages: [{ role: 'system', content: 'System prompt' }],
        systemPrompt: 'System prompt',
        spaceId: 'telegram:chat-1',
        assistantPackId: 'jeeves',
        groundingPackId: 'jeeves_personal',
    }));
    vi.doMock('./llm', () => ({ processWithLLM }));
    vi.doMock('./context-composer', () => ({ composeConversationContext }));

    const db = await import('../db');
    db.initDatabase();
    const jeeves = await import('./jeeves-mvp');

    return {
        db,
        jeeves,
        mocks: {
            processWithLLM,
            composeConversationContext,
        },
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
    vi.doUnmock('./llm');
    vi.doUnmock('./context-composer');
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/jeeves-mvp', () => {
    it('reports the PA Jeeves MVP status for the current space', async () => {
        const { db, jeeves } = await loadJeevesModule();

        db.upsertResident({ tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
        db.upsertChat({ jid: 'chat-1', type: 'private' });
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-1'), '111', 'owner');
        db.updateSpacePolicy(db.buildTelegramSpaceId('chat-1'), { workspace_path: '/tmp/project' });
        db.getDb().exec(`
            CREATE TABLE IF NOT EXISTS todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                space_id TEXT,
                task TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                added_at TEXT,
                completed_at TEXT
            )
        `);
        db.upsertChat({ jid: 'chat-2', type: 'private' });
        db.getDb()
            .prepare(`INSERT INTO todos (space_id, task, status, added_at) VALUES (?, ?, 'pending', ?)`)
            .run(db.buildTelegramSpaceId('chat-1'), 'Pay electricity bill', new Date().toISOString());
        db.getDb()
            .prepare(`INSERT INTO todos (space_id, task, status, added_at) VALUES (?, ?, 'pending', ?)`)
            .run(db.buildTelegramSpaceId('chat-2'), 'Other chat task', new Date().toISOString());
        db.getDb()
            .prepare(
                `
            INSERT INTO reminders (chat_jid, sender_tg_id, content, remind_at, status, created_at)
            VALUES (?, ?, ?, ?, 'pending', ?)
        `
            )
            .run(
                'chat-1',
                '111',
                'Call Marco',
                new Date(Date.now() + 3600_000).toISOString(),
                new Date().toISOString()
            );
        db.upsertTask({
            id: 'task:telegram:chat-1:briefing_morning',
            space_id: db.buildTelegramSpaceId('chat-1'),
            title: 'Morning briefing',
            kind: 'assistant_prompt',
            prompt: 'Write a briefing.',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            status: 'active',
            created_by: 'system',
        });
        db.upsertTask({
            id: 'task:telegram:chat-1:weekly_digest',
            space_id: db.buildTelegramSpaceId('chat-1'),
            title: 'Weekly digest',
            kind: 'assistant_prompt',
            prompt: 'Write a digest.',
            schedule_type: 'cron',
            schedule_value: '0 8 * * 1',
            status: 'active',
            created_by: '111',
        });

        const result = jeeves.getJeevesMvpStatus('chat-1');

        expect(result).toContain('PA Jeeves MVP');
        expect(result).toContain('Pack: jeeves');
        expect(result).toContain('Grounding: jeeves_personal');
        expect(result).toContain('Pending: 1 todos, 1 reminders');
        expect(result).toContain('Scheduled tasks: 2 active (1 system, 1 custom)');
        expect(result).toContain('/brief, /focus, /review');
    });

    it('applies Jeeves defaults and reseeds assistant tasks', async () => {
        const { db, jeeves } = await loadJeevesModule();

        db.upsertChat({ jid: 'chat-1', type: 'group' });
        db.updateSpaceAssistantPack(db.buildTelegramSpaceId('chat-1'), 'office');
        db.updateSpacePolicy(db.buildTelegramSpaceId('chat-1'), {
            browser: false,
            tasks: false,
            memory_sprint_days: 30,
        });

        const result = await jeeves.applyJeevesDefaults('chat-1');
        const space = db.getSpace(db.buildTelegramSpaceId('chat-1'));
        const policy = JSON.parse(space?.policy_json || '{}');
        const seededTasks = db.listTasks(db.buildTelegramSpaceId('chat-1'), 'active');

        expect(result).toContain('Jeeves defaults are active');
        expect(space?.assistant_pack_id).toBe('jeeves');
        expect(space?.grounding_pack_id).toBe('jeeves_personal');
        expect(policy).toEqual(
            expect.objectContaining({
                browser: true,
                tasks: true,
                memory_sprint_days: 7,
            })
        );
        expect(seededTasks.map((task) => task.id)).toContain('task:telegram:chat-1:briefing_morning');
        expect(seededTasks.map((task) => task.id)).toContain('task:telegram:chat-1:atelier_review');
    });

    it('runs an on-demand Jeeves action and stores the result in history and work memory', async () => {
        const { db, jeeves, mocks } = await loadJeevesModule();

        db.upsertResident({ tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
        db.upsertChat({ jid: 'chat-1', type: 'private' });
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-1'), '111', 'owner');

        const result = await jeeves.runJeevesMvpAction({
            chatId: 'chat-1',
            senderId: '111',
            action: 'brief',
        });

        expect(result).toBe('A compact Jeeves note.');
        expect(mocks.processWithLLM).toHaveBeenCalledTimes(1);
        const firstCall = mocks.processWithLLM.mock.calls[0] as unknown as [
            Array<{ role: string; content: string }>,
            unknown,
        ];
        const llmMessages = firstCall[0];
        expect(llmMessages[1].content).toContain('on-demand Jeeves personal briefing');

        const messages = db.getRecentMessages('chat-1', 10);
        const workMemory = db.getMemoryEntries('work', 'telegram:chat-1', 'jeeves_brief', 10);

        expect(
            messages.some((message) => message.is_bot === 1 && message.content.includes('compact Jeeves note'))
        ).toBe(true);
        expect(workMemory).toHaveLength(1);
        expect(workMemory[0].content).toContain('Generated brief note');
    });
});
