import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadTasksModule() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-tasks-${Date.now()}` };

    const handleButlerMessage = vi.fn(async () => undefined);
    const sendMessageToChat = vi.fn(async () => undefined);

    vi.doMock('../agents/butler', () => ({ handleButlerMessage }));
    vi.doMock('../channels/telegram', () => ({ sendMessageToChat }));

    const db = await import('../db');
    db.initDatabase();
    const tasks = await import('./tasks');

    return { db, tasks, mocks: { handleButlerMessage, sendMessageToChat } };
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

describe('core/tasks', () => {
    it('seeds default assistant tasks for a telegram space', async () => {
        const { db, tasks } = await loadTasksModule();

        tasks.ensureDefaultAssistantTasks('chat-1');

        const seeded = db.listTasks(db.buildTelegramSpaceId('chat-1'), 'active');
        expect(seeded.length).toBeGreaterThanOrEqual(5);
        expect(seeded.map((task) => task.id)).toContain('task:telegram:chat-1:briefing_morning');
        expect(seeded.map((task) => task.id)).toContain('task:telegram:chat-1:weekly_reset');
        expect(seeded.map((task) => task.kind)).toContain('atelier_summary');
    });

    it('seeds tasks from the current assistant pack and removes stale system seeds after a pack switch', async () => {
        const { db, tasks } = await loadTasksModule();

        tasks.ensureDefaultAssistantTasks('chat-1');
        db.updateSpaceAssistantPack(db.buildTelegramSpaceId('chat-1'), 'office');

        tasks.ensureDefaultAssistantTasksForSpace(db.buildTelegramSpaceId('chat-1'));

        const seeded = db.listTasks(db.buildTelegramSpaceId('chat-1'));
        expect(seeded.map((task) => task.id)).toContain('task:telegram:chat-1:followup_digest');
        expect(seeded.map((task) => task.id)).not.toContain('task:telegram:chat-1:consideration_afternoon');
        expect(seeded.map((task) => task.id)).not.toContain('task:telegram:chat-1:wrapup_evening');
    });

    it('does not keep seeded system tasks when task policy is disabled for the space', async () => {
        const { db, tasks } = await loadTasksModule();

        tasks.ensureDefaultAssistantTasks('chat-1');
        db.updateSpacePolicy(db.buildTelegramSpaceId('chat-1'), { tasks: false });

        tasks.ensureDefaultAssistantTasksForSpace(db.buildTelegramSpaceId('chat-1'));

        expect(db.listTasks(db.buildTelegramSpaceId('chat-1'))).toHaveLength(0);
    });

    it('reseeds only active spaces with task policy enabled', async () => {
        const { db, tasks } = await loadTasksModule();

        db.ensureTelegramSpace('chat-1', 'group', 'chat-1');
        db.ensureTelegramSpace('chat-2', 'group', 'chat-2');
        db.upsertSpace({
            id: 'telegram:chat-3',
            kind: 'group_chat',
            title: 'Paused',
            channel: 'telegram',
            external_ref: 'chat-3',
            status: 'PAUSED',
            assistant_pack_id: 'reporter',
            policy_json: JSON.stringify({ tasks: true }),
        });
        db.updateSpaceAssistantPack(db.buildTelegramSpaceId('chat-1'), 'office');
        db.updateSpacePolicy(db.buildTelegramSpaceId('chat-1'), { tasks: true });
        db.updateSpacePolicy(db.buildTelegramSpaceId('chat-2'), { tasks: false });

        const reseeded = tasks.ensureDefaultAssistantTasksForActiveSpaces();

        expect(reseeded).toBe(1);
        expect(db.listTasks(db.buildTelegramSpaceId('chat-1')).map((task) => task.id)).toContain(
            'task:telegram:chat-1:followup_digest'
        );
        expect(db.listTasks(db.buildTelegramSpaceId('chat-2'))).toHaveLength(0);
        expect(db.listTasks('telegram:chat-3')).toHaveLength(0);
    });

    it('runs assistant prompt tasks through Butler and records task runs', async () => {
        const { db, tasks, mocks } = await loadTasksModule();

        tasks.ensureDefaultAssistantTasks('chat-1');
        await tasks.runAssistantTask('task:telegram:chat-1:briefing_morning');

        expect(mocks.handleButlerMessage).toHaveBeenCalledTimes(1);
        const [request] = mocks.handleButlerMessage.mock.calls[0] as unknown as [Record<string, string>];

        expect(request.channel).toBe('telegram');
        expect(request.channelRef).toBe('chat-1');
        expect(request.senderId).toBe('system_cron');
        expect(request.text).toContain('[SYSTEM TASK] Morning team briefing.');

        const messages = db.getRecentMessages('chat-1', 10);
        const taskRuns = db.getTaskRuns('task:telegram:chat-1:briefing_morning');
        const workMemory = db.getMemoryEntries('work', db.buildTelegramSpaceId('chat-1'), 'task_outcome', 10);

        expect(messages.some((message) => message.sender_tg_id === 'system_cron')).toBe(true);
        expect(taskRuns).toHaveLength(1);
        expect(taskRuns[0].status).toBe('success');
        expect(workMemory.some((entry) => entry.content.includes('Morning team briefing'))).toBe(true);
    });

    it('skips assistant prompt delivery when the space channel mode is off', async () => {
        const { db, tasks, mocks } = await loadTasksModule();

        const created = tasks.createAssistantTask(
            'chat-off',
            'Quiet digest',
            'Write a short digest for the quiet room.',
            '0 8 * * 1',
            '111'
        );
        db.updateSpacePolicy(db.buildTelegramSpaceId('chat-off'), { channel_mode: 'off' });

        await tasks.runAssistantTask(created.id);

        const taskRuns = db.getTaskRuns(created.id);
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
        expect(taskRuns).toHaveLength(1);
        expect(taskRuns[0].status).toBe('success');
        expect(taskRuns[0].result).toBe('skipped:channel-off');
    });

    it('runs atelier summary tasks as direct operational notices', async () => {
        const { db, tasks, mocks } = await loadTasksModule();

        tasks.ensureDefaultAssistantTasks('chat-1');
        db.getDb()
            .prepare(
                `
            INSERT INTO skill_requests (space_id, skill_name, description, requested_by, user_request, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                db.buildTelegramSpaceId('chat-1'),
                'group_digest',
                'Build a group digest skill',
                '111',
                'Need a digest for the team',
                'pending',
                '2026-03-20T10:00:00.000Z'
            );

        await tasks.runAssistantTask('task:telegram:chat-1:atelier_review');

        expect(mocks.sendMessageToChat).toHaveBeenCalledWith(
            'chat-1',
            expect.stringContaining('Atelier has 1 open request(s)')
        );

        const runs = db.getTaskRuns('task:telegram:chat-1:atelier_review');
        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('success');
    });

    it('creates, pauses, resumes, and cancels assistant tasks', async () => {
        const { db, tasks } = await loadTasksModule();

        const created = tasks.createAssistantTask(
            'chat-1',
            'Weekly digest',
            'Write a short digest for the team.',
            '0 8 * * 1',
            '111'
        );

        expect(created.title).toBe('Weekly digest');
        expect(db.getTask(created.id)?.status).toBe('active');

        tasks.pauseAssistantTask(created.id);
        expect(db.getTask(created.id)?.status).toBe('paused');

        tasks.resumeAssistantTask(created.id);
        expect(db.getTask(created.id)?.status).toBe('active');

        expect(tasks.cancelAssistantTask(created.id)).toBe(true);
        expect(db.getTask(created.id)).toBeUndefined();
    });

    it('preserves ritual schedule overrides across seeded task reseeds', async () => {
        const { db, tasks } = await loadTasksModule();

        tasks.ensureDefaultAssistantTasks('chat-1');

        const original = db.getTask('task:telegram:chat-1:briefing_morning');
        expect(original).toBeDefined();

        db.upsertTask({
            ...original!,
            schedule_value: '30 8 * * *',
            config_json: JSON.stringify({
                ritual: {
                    custom_schedule: true,
                },
            }),
            created_at: original!.created_at,
        });

        tasks.ensureDefaultAssistantTasksForSpace(db.buildTelegramSpaceId('chat-1'));

        expect(db.getTask('task:telegram:chat-1:briefing_morning')?.schedule_value).toBe('30 8 * * *');
    });

    it('preserves weekday-based office ritual schedules when only the time changes', async () => {
        const { db, tasks } = await loadTasksModule();
        const rituals = await import('./rituals');

        tasks.ensureDefaultAssistantTasks('chat-1');
        db.updateSpaceAssistantPack(db.buildTelegramSpaceId('chat-1'), 'office');
        tasks.ensureDefaultAssistantTasksForSpace(db.buildTelegramSpaceId('chat-1'));

        rituals.configureRitualForSpace(db.buildTelegramSpaceId('chat-1'), 'morning', {
            time_local: '08:30',
        });

        expect(db.getTask('task:telegram:chat-1:briefing_morning')?.schedule_value).toBe('30 8 * * 1-5');
    });

    it('stores normalized audit config for custom assistant tasks', async () => {
        const { db, tasks } = await loadTasksModule();

        const created = tasks.createAssistantTask(
            'chat-1',
            'Weekly digest',
            'Write a short digest for the team.',
            '0 8 * * 1',
            '111',
            { audit_trail: 'all' }
        );

        expect(db.getTask(created.id)?.config_json).toBe('{"audit_trail":"all"}');
    });

    it('checks task deadlines and notifies only once per phase', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));

        try {
            const { db, tasks, mocks } = await loadTasksModule();

            const created = tasks.createAssistantTask(
                'chat-1',
                'Board packet',
                'Prepare the board packet.',
                '0 8 * * 1',
                '111',
                { deadline_at: '2026-03-31T08:00:00.000Z' }
            );

            await tasks.checkTaskDeadlines();
            expect(mocks.sendMessageToChat).toHaveBeenCalledWith(
                'chat-1',
                expect.stringContaining('is due by 2026-03-31 08:00')
            );

            await tasks.checkTaskDeadlines();
            expect(mocks.sendMessageToChat).toHaveBeenCalledTimes(1);

            vi.setSystemTime(new Date('2026-03-31T08:05:00.000Z'));
            await tasks.checkTaskDeadlines();
            expect(mocks.sendMessageToChat).toHaveBeenCalledWith(
                'chat-1',
                expect.stringContaining('was due by 2026-03-31 08:00')
            );
            expect(mocks.sendMessageToChat).toHaveBeenCalledTimes(2);

            const config = JSON.parse(db.getTask(created.id)?.config_json || '{}');
            expect(config.deadline.at).toBe('2026-03-31T08:00:00.000Z');
            expect(config.deadline.last_alert_kind).toBe('overdue');
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs a custom assistant task immediately when requested', async () => {
        const { db, tasks, mocks } = await loadTasksModule();

        const created = tasks.createAssistantTask(
            'chat-1',
            'Custom digest',
            'Write a custom digest for the team.',
            '0 8 * * 1',
            '111'
        );

        await tasks.runAssistantTask(created.id);

        expect(mocks.handleButlerMessage).toHaveBeenCalledTimes(1);
        const [request] = mocks.handleButlerMessage.mock.calls[0] as unknown as [Record<string, string>];
        expect(request.text).toContain('Write a custom digest for the team.');
        expect(db.getTaskRuns(created.id)).toHaveLength(1);
        expect(
            db
                .getMemoryEntries('work', db.buildTelegramSpaceId('chat-1'), 'task_outcome', 10)
                .some((entry) => entry.content.includes('Custom digest'))
        ).toBe(true);
    });

    it('seeds the daily_initiative task for jeeves pack', async () => {
        const { db, tasks } = await loadTasksModule();

        db.ensureTelegramSpace('chat-init', 'group', 'chat-init');
        db.updateSpaceAssistantPack(db.buildTelegramSpaceId('chat-init'), 'jeeves');
        tasks.ensureDefaultAssistantTasksForSpace(db.buildTelegramSpaceId('chat-init'));

        const task = db.getTask('task:telegram:chat-init:daily_initiative');
        expect(task).toBeDefined();
        expect(task!.title).toBe('Daily self-directed work');
        expect(task!.schedule_value).toBe('30 10 * * 1-5');
        expect(task!.kind).toBe('assistant_prompt');
    });

    it('seeds the daily_initiative task for office pack', async () => {
        const { db, tasks } = await loadTasksModule();

        db.ensureTelegramSpace('chat-office-init', 'group', 'chat-office-init');
        db.updateSpaceAssistantPack(db.buildTelegramSpaceId('chat-office-init'), 'office');
        tasks.ensureDefaultAssistantTasksForSpace(db.buildTelegramSpaceId('chat-office-init'));

        const task = db.getTask('task:telegram:chat-office-init:daily_initiative');
        expect(task).toBeDefined();
        expect(task!.title).toBe('Daily self-directed work');
        expect(task!.schedule_value).toBe('30 10 * * 1-5');
        expect(task!.prompt).toContain('self-directed office coordination session');
    });

    it('collectInitiativeSignals returns empty array for a clean space', async () => {
        const { db, tasks } = await loadTasksModule();

        db.ensureTelegramSpace('chat-sig', 'group', 'chat-sig');
        // Insert a recent human message so the "quiet" signal does not fire
        db.storeMessage({
            id: 'msg-human-recent',
            space_id: db.buildTelegramSpaceId('chat-sig'),
            channel_ref: 'chat-sig',
            sender_id: '111',
            content: 'hello',
            timestamp: new Date().toISOString(),
            is_bot: 0,
        });

        const signals = tasks.collectInitiativeSignals(db.buildTelegramSpaceId('chat-sig'));
        expect(signals).toEqual([]);
    });

    it('collectInitiativeSignals detects pending todos', async () => {
        const { db, tasks } = await loadTasksModule();

        db.ensureTelegramSpace('chat-sig2', 'group', 'chat-sig2');
        const spaceId = db.buildTelegramSpaceId('chat-sig2');

        // Insert a recent message to suppress the "quiet" signal
        db.storeMessage({
            id: 'msg-human-recent-2',
            space_id: spaceId,
            channel_ref: 'chat-sig2',
            sender_id: '111',
            content: 'working',
            timestamp: new Date().toISOString(),
            is_bot: 0,
        });

        // Insert a pending todo (column is 'task', not 'content')
        db.getDb()
            .prepare(
                `INSERT INTO todos (space_id, task, status, added_at)
                 VALUES (?, ?, 'pending', datetime('now'))`
            )
            .run(spaceId, 'Buy groceries');

        const signals = tasks.collectInitiativeSignals(spaceId);
        expect(signals.some((s) => s.includes('pending todo'))).toBe(true);
    });

    it('collectInitiativeSignals detects quiet space', async () => {
        const { db, tasks } = await loadTasksModule();

        db.ensureTelegramSpace('chat-sig3', 'group', 'chat-sig3');
        const spaceId = db.buildTelegramSpaceId('chat-sig3');

        // No messages at all → should detect silence
        const signals = tasks.collectInitiativeSignals(spaceId);
        expect(signals.some((s) => s.includes('quiet'))).toBe(true);
    });

    it('initiative task prompt includes CURRENT SIGNALS block', async () => {
        const { db, tasks, mocks } = await loadTasksModule();

        db.ensureTelegramSpace('chat-init2', 'group', 'chat-init2');
        db.updateSpaceAssistantPack(db.buildTelegramSpaceId('chat-init2'), 'jeeves');
        tasks.ensureDefaultAssistantTasksForSpace(db.buildTelegramSpaceId('chat-init2'));
        await tasks.runAssistantTask('task:telegram:chat-init2:daily_initiative');

        expect(mocks.handleButlerMessage).toHaveBeenCalledTimes(1);
        const [request] = mocks.handleButlerMessage.mock.calls[0] as unknown as [Record<string, string>];
        expect(request.text).toContain('[SYSTEM TASK] Proactive initiative session.');
        expect(request.text).toContain('CURRENT SIGNALS:');
    });
});
