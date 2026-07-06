import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadDbModule() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...process.env };
    return await import('./db');
}

afterEach(async () => {
    try {
        const db = await import('./db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
});

describe('db module', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-db-tests-${Date.now()}` };
    });

    it('initializes the database with WAL mode and passes integrity check', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        const db = dbModule.getDb();
        const journalMode = db.pragma('journal_mode', { simple: true });
        const integrity = db.pragma('integrity_check(1)', { simple: true });

        expect(journalMode).toBe('wal');
        expect(integrity).toBe('ok');
    });

    it('upserts and retrieves residents', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });

        dbModule.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice A.',
            habits: 'likes coffee',
        });

        const resident = dbModule.getResident('111');
        expect(resident?.display_name).toBe('Alice A.');
        expect(resident?.habits).toBe('likes coffee');
    });

    it('stores chats, auto-creates spaces, and trims old messages', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertChat({ jid: 'chat-1', type: 'private' });
        dbModule.storeMessage({
            id: 'old',
            chat_jid: 'chat-1',
            sender_tg_id: '111',
            content: 'old',
            timestamp: new Date(Date.now() - 10 * 24 * 3600_000).toISOString(),
            is_bot: 0,
        });
        dbModule.storeMessage({
            id: 'new',
            chat_jid: 'chat-1',
            sender_tg_id: '111',
            content: 'new',
            timestamp: new Date().toISOString(),
            is_bot: 0,
        });

        const deleted = dbModule.deleteOldMessages('chat-1', 7);
        const remaining = dbModule.getRecentMessages('chat-1', 10);
        const space = dbModule.getSpace(dbModule.buildTelegramSpaceId('chat-1'));

        expect(dbModule.getChat('chat-1')?.type).toBe('private');
        expect(space?.channel).toBe('telegram');
        expect(space?.external_ref).toBe('chat-1');
        expect(space?.grounding_pack_id).toBe('jeeves_personal');
        expect(deleted).toBe(1);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].content).toBe('new');
        expect(remaining[0].space_id).toBe(dbModule.buildTelegramSpaceId('chat-1'));
    });

    it('uses the provided channel when storeMessage needs to infer a space id', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.storeMessage({
            id: 'discord-1',
            channel: 'discord',
            channel_ref: 'room-42',
            sender_id: 'discord:user-1',
            content: 'hello from discord',
            timestamp: new Date().toISOString(),
            is_bot: 0,
        });

        const message = dbModule.getRecentMessages('room-42', 10)[0];
        expect(message.space_id).toBe('discord:room-42');
    });

    it('reads direct-message continuity by participant without mixing group messages', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();
        const now = new Date().toISOString();

        dbModule.ensureSpace('telegram', '111', { kind: 'direct_chat', title: 'Alice DM' });
        dbModule.ensureSpace('telegram', '222', { kind: 'direct_chat', title: 'Kristina DM' });
        dbModule.ensureSpace('telegram', 'group-1', { kind: 'group_chat', title: 'Household' });

        dbModule.storeMessage({
            id: 'dm-111',
            space_id: 'telegram:111',
            channel_ref: '111',
            sender_id: '111',
            content: 'private hello',
            timestamp: now,
            is_bot: 0,
        });
        dbModule.storeMessage({
            id: 'dm-222',
            space_id: 'telegram:222',
            channel_ref: '222',
            sender_id: '222',
            content: '[ACCESS_DENIED_DIRECT_CONTACT]',
            timestamp: now,
            is_bot: 0,
        });
        dbModule.storeMessage({
            id: 'group-222',
            space_id: 'telegram:group-1',
            channel_ref: 'group-1',
            sender_id: '222',
            content: 'group hello',
            timestamp: now,
            is_bot: 0,
        });

        expect(dbModule.getRecentDirectMessagesForPerson('telegram', '111', 5).map((m) => m.content)).toEqual([
            'private hello',
        ]);
        expect(dbModule.getDirectContactStatuses('telegram', ['111', '222'])).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ person_id: '111', inbound_count: 1 }),
                expect.objectContaining({ person_id: '222', inbound_count: 1 }),
            ])
        );
    });

    it('searches prior messages, recollections, and lists memory sprint history', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        dbModule.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'group_chat',
            title: 'Office Team',
            channel: 'telegram',
            external_ref: 'chat-1',
            assistant_pack_id: 'office',
            policy_json: JSON.stringify({ memory_sprint_days: 7, external_group_aliases: ['deck-room'] }),
        });
        dbModule.storeMessage({
            id: 'm-1',
            space_id: 'telegram:chat-1',
            chat_jid: 'chat-1',
            sender_tg_id: '111',
            content: 'The board deck needs a cleaner summary.',
            timestamp: '2026-03-25T09:00:00.000Z',
            is_bot: 0,
        });
        dbModule
            .getDb()
            .prepare(
                `
            INSERT INTO memory_sprints (id, space_id, opened_at, closes_at, status, cadence_days, summary, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                'sprint:telegram:chat-1:2026-03-01',
                'telegram:chat-1',
                '2026-03-01T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z',
                'compacted',
                7,
                'A short reflective summary.',
                '2026-03-01T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z'
            );
        dbModule
            .getDb()
            .prepare(
                `
            INSERT INTO memory_entries (scope_type, scope_id, memory_sprint_id, kind, content, salience, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                'work',
                'telegram:chat-1',
                null,
                'recollection',
                'Work recollection (2026-03-01 -> 2026-03-08): the board deck needed a cleaner executive summary.',
                0.8,
                'sprint_compaction',
                '2026-03-08T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z'
            );

        const hits = dbModule.searchMessages('board deck', { limit: 5 });
        const recollections = dbModule.searchRecollections('board deck', { limit: 5 });
        const sprints = dbModule.listMemorySprints('telegram:chat-1', 5);

        expect(hits).toHaveLength(1);
        expect(hits[0].space_title).toBe('Office Team');
        expect(hits[0].sender_name).toBe('Alice');
        expect(dbModule.searchMessages('deck-room', { limit: 5 })).toHaveLength(1);
        expect(recollections).toHaveLength(1);
        expect(recollections[0].scope_type).toBe('work');
        expect(recollections[0].content).toContain('executive summary');
        expect(sprints).toHaveLength(1);
        expect(sprints[0].status).toBe('compacted');
        expect(sprints[0].summary).toContain('reflective');
    });

    it('stores memberships with authority defaults per space', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        dbModule.upsertChat({ jid: 'chat-1', type: 'private' });

        const spaceId = dbModule.buildTelegramSpaceId('chat-1');
        const membership = dbModule.ensureSpaceMembership(spaceId, '111', 'owner');
        const participants = dbModule.getSpaceParticipants(spaceId);

        expect(membership.base_authority).toBe(1000);
        expect(dbModule.memberHasTrustFlag(spaceId, '111', 'can_change_policies')).toBe(true);
        expect(dbModule.getMemberEffectiveAuthority(spaceId, '111')).toBe(1000);
        expect(participants).toHaveLength(1);
        expect(participants[0].effective_authority).toBe(1000);
        expect(participants[0].membership_role).toBe('owner');
    });

    it('updates space pack and policy overrides', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        const spaceId = dbModule.buildTelegramSpaceId('chat-1');

        dbModule.updateSpaceAssistantPack(spaceId, 'office');
        dbModule.updateSpaceGroundingPack(spaceId, 'jeeves_personal');
        dbModule.updateSpacePolicy(spaceId, {
            browser: false,
            tasks: false,
        });

        const space = dbModule.getSpace(spaceId);

        expect(space?.assistant_pack_id).toBe('office');
        expect(space?.grounding_pack_id).toBe('jeeves_personal');
        expect(JSON.parse(space?.policy_json || '{}')).toEqual(
            expect.objectContaining({
                browser: false,
                tasks: false,
                onboarding_state: 'new',
                setup_version: 1,
                channel_mode: 'full',
            })
        );
    });

    it('creates new spaces with KISS operational defaults and backfills existing ones on policy update', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        const newSpace = dbModule.ensureSpace('discord', 'ops-room', {
            kind: 'group_chat',
            title: 'Ops Room',
        });
        expect(JSON.parse(newSpace.policy_json || '{}')).toEqual(
            expect.objectContaining({
                onboarding_state: 'new',
                setup_version: 1,
                channel_mode: 'full',
            })
        );

        dbModule
            .getDb()
            .prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            )
            .run(
                'discord:legacy-room',
                'group_chat',
                'Legacy Room',
                'discord',
                'legacy-room',
                'ACTIVE',
                'office',
                'jeeves_personal',
                JSON.stringify({ browser: true, custom_flag: 'keep' }),
                new Date().toISOString(),
                new Date().toISOString()
            );

        dbModule.updateSpacePolicy('discord:legacy-room', { tasks: false });
        const legacySpace = dbModule.getSpace('discord:legacy-room');
        expect(JSON.parse(legacySpace?.policy_json || '{}')).toEqual(
            expect.objectContaining({
                browser: true,
                tasks: false,
                custom_flag: 'keep',
                onboarding_state: 'active',
                setup_version: 1,
                channel_mode: 'full',
            })
        );
    });

    it('creates projects, links them to long-running objects, and tracks active focus per space', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        const spaceId = dbModule.buildTelegramSpaceId('chat-1');
        dbModule.updateSpaceAssistantPack(spaceId, 'office');

        const project = dbModule.createProject({
            title: 'Firebreak',
            goal: 'Stabilize the board update.',
            next_step: 'Draft the shortlist note.',
            active_pack_id: 'office',
        });

        dbModule.setSpaceActiveProject(spaceId, project.id);
        dbModule.upsertTask({
            id: 'task-1',
            space_id: spaceId,
            title: 'Shortlist digest',
            prompt: 'Write the digest.',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
        });
        dbModule.linkProjectTarget(project.id, 'task', 'task-1');
        dbModule.linkProjectTarget(project.id, 'artifact', '.pipi/office/firebreak.md');

        const resolved = dbModule.resolveProjectSelector('firebreak');
        const active = dbModule.getActiveProjectForSpace(spaceId);

        expect(resolved?.id).toBe(project.id);
        expect(active?.title).toBe('Firebreak');
        expect(active?.linked_spaces).toEqual([spaceId]);
        expect(active?.linked_tasks).toEqual(['task-1']);
        expect(active?.linked_artifacts).toEqual(['.pipi/office/firebreak.md']);

        const completed = dbModule.updateProject(project.id, { state: 'done', next_step: 'none' });
        dbModule.setSpaceActiveProject(spaceId, null);

        expect(completed?.state).toBe('done');
        expect(completed?.next_step).toBe('none');
        expect(dbModule.getActiveProjectForSpace(spaceId)).toBeUndefined();
    });

    it('stores grounding packs on spaces and keeps active overrides per subject', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        const spaceId = dbModule.buildTelegramSpaceId('chat-1');

        dbModule.updateSpaceGroundingPack(spaceId, 'jeeves_personal');
        const first = dbModule.upsertGroundingOverride({
            space_id: spaceId,
            kind: 'person',
            subject: 'Alice',
            content: 'Alice is no longer part of this household.',
            created_by: '111',
        });
        const updated = dbModule.upsertGroundingOverride({
            space_id: spaceId,
            kind: 'person',
            subject: 'Alice',
            content: 'Alice moved abroad and is no longer part of this household.',
            created_by: '111',
        });
        const second = dbModule.upsertGroundingOverride({
            space_id: spaceId,
            kind: 'place',
            subject: 'Family home',
            content: 'The family now lives in Tbilisi.',
            created_by: '111',
        });

        const active = dbModule.listGroundingOverrides(spaceId);
        const disabled = dbModule.disableGroundingOverride(second.id);
        const all = dbModule.listGroundingOverrides(spaceId, { includeInactive: true });
        const space = dbModule.getSpace(spaceId);

        expect(space?.grounding_pack_id).toBe('jeeves_personal');
        expect(first.id).toBe(updated.id);
        expect(active).toHaveLength(2);
        expect(active[0].content).toContain('Tbilisi');
        expect(active[1].content).toContain('moved abroad');
        expect(disabled?.status).toBe('inactive');
        expect(all.some((override) => override.status === 'inactive')).toBe(true);
    });

    it('lists spaces and can filter by status', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'group_chat',
            title: 'Active Team',
            channel: 'telegram',
            external_ref: 'chat-1',
            status: 'ACTIVE',
        });
        dbModule.upsertSpace({
            id: 'telegram:chat-2',
            kind: 'group_chat',
            title: 'Paused Team',
            channel: 'telegram',
            external_ref: 'chat-2',
            status: 'PAUSED',
        });

        expect(dbModule.listSpaces()).toHaveLength(2);
        expect(dbModule.listSpaces('ACTIVE').map((space) => space.id)).toEqual(['telegram:chat-1']);
    });

    it('updates membership role, reputation, and trust flags', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        const spaceId = dbModule.buildTelegramSpaceId('chat-1');
        dbModule.ensureSpaceMembership(spaceId, '111', 'member');

        dbModule.updateMembershipRole(spaceId, '111', 'manager');
        dbModule.updateMembershipReputation(spaceId, '111', 75);
        dbModule.updateMembershipTrustFlag(spaceId, '111', 'can_change_policies', true);

        const participant = dbModule.getSpaceParticipants(spaceId)[0];

        expect(participant.membership_role).toBe('manager');
        expect(participant.base_authority).toBe(500);
        expect(participant.reputation_delta).toBe(75);
        expect(participant.effective_authority).toBe(575);
        expect(participant.trust_flags.can_change_policies).toBe(true);
    });

    it('logs events and token usage', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.logEvent('reboot', { reason: 'test' });
        dbModule.logTokenUsage('gemini-2.5-flash', 1000, 500);

        const db = dbModule.getDb();
        const event = db.prepare('SELECT * FROM event_log WHERE event_type = ?').get('reboot') as any;
        const usage = dbModule.getDailyTokenCost();

        expect(event).toBeDefined();
        expect(usage.calls).toBe(1);
        expect(usage.input_tokens).toBe(1000);
    });

    it('prices gemini-3-pro-preview token usage with the correct tier', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.logTokenUsage('gemini-3-pro-preview', 150000, 10000);
        dbModule.logTokenUsage('gemini-3-pro-preview', 250000, 10000);

        const rows = dbModule
            .getDb()
            .prepare('SELECT input_tokens, output_tokens, cost_usd FROM token_usage WHERE model = ? ORDER BY id ASC')
            .all('gemini-3-pro-preview') as Array<{ input_tokens: number; output_tokens: number; cost_usd: number }>;

        expect(rows).toHaveLength(2);
        expect(rows[0]?.cost_usd).toBeCloseTo((150000 * 2 + 10000 * 12) / 1_000_000);
        expect(rows[1]?.cost_usd).toBeCloseTo((250000 * 4 + 10000 * 18) / 1_000_000);
    });

    it('stores tasks and task runs', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        const spaceId = dbModule.buildTelegramSpaceId('chat-1');

        dbModule.upsertTask({
            id: 'task-1',
            space_id: spaceId,
            title: 'Morning briefing',
            prompt: 'Write a briefing.',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
        });

        dbModule.recordTaskRun({
            task_id: 'task-1',
            started_at: '2026-03-25T09:00:00.000Z',
            finished_at: '2026-03-25T09:00:05.000Z',
            status: 'success',
            result: 'sent',
            error: null,
            duration_ms: 5000,
        });
        dbModule.updateTaskLastRun('task-1', '2026-03-25T09:00:05.000Z');

        const task = dbModule.getTask('task-1');
        const tasks = dbModule.listTasks(spaceId, 'active');
        const runs = dbModule.getTaskRuns('task-1');

        expect(task?.title).toBe('Morning briefing');
        expect(task?.last_run_at).toBe('2026-03-25T09:00:05.000Z');
        expect(tasks).toHaveLength(1);
        expect(runs).toHaveLength(1);
        expect(runs[0].result).toBe('sent');
    });

    it('merges tool execution log arrays and preserves first non-null sandbox metadata', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        const logId = dbModule.beginToolExecutionLog({
            space_id: 'telegram:chat-1',
            task_id: 'task-1',
            tool_name: 'browse_web',
            run_mode: 'sidecar',
            audit_mode: 'all',
            capabilities: ['web_browse', 'external_http', 'web_browse'],
            args: { url: 'https://example.com' },
            workspace_root: '/tmp/project',
            sandbox_backend: 'docker',
        });

        dbModule.appendToolExecutionLogData(logId, {
            network_targets: ['example.com', 'example.com'],
            files_read: ['README.md'],
            files_written: ['notes.md'],
            artifacts: ['notes.md'],
            sandbox_image: 'node:24-slim',
        });
        dbModule.appendToolExecutionLogData(logId, {
            network_targets: ['cdn.example.com'],
            files_read: ['README.md', 'docs/spec.md'],
            files_written: ['notes.md', 'summary.md'],
            artifacts: ['summary.md'],
            sandbox_backend: null,
            sandbox_container_id: 'abc123',
        });
        dbModule.finishToolExecutionLog(logId, {
            status: 'success',
            result_preview: 'ok',
            duration_ms: 42,
        });

        const log = dbModule.getToolExecutionLog(logId);

        expect(log?.status).toBe('success');
        expect(log?.sandbox_backend).toBe('docker');
        expect(log?.sandbox_image).toBe('node:24-slim');
        expect(log?.sandbox_container_id).toBe('abc123');
        expect(JSON.parse(log?.network_targets_json || '[]')).toEqual(['example.com', 'cdn.example.com']);
        expect(JSON.parse(log?.files_read_json || '[]')).toEqual(['README.md', 'docs/spec.md']);
        expect(JSON.parse(log?.files_written_json || '[]')).toEqual(['notes.md', 'summary.md']);
        expect(JSON.parse(log?.artifacts_json || '[]')).toEqual(['notes.md', 'summary.md']);
    });

    it('cleans up tool execution logs older than the retention window', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule
            .getDb()
            .prepare(
                `
            INSERT INTO tool_execution_log (
                space_id, tool_name, run_mode, audit_mode, started_at, status
            ) VALUES (?, ?, ?, ?, ?, ?)
        `
            )
            .run(
                'telegram:chat-1',
                'browse_web',
                'inline',
                'errors',
                new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
                'completed'
            );
        dbModule
            .getDb()
            .prepare(
                `
            INSERT INTO tool_execution_log (
                space_id, tool_name, run_mode, audit_mode, started_at, status
            ) VALUES (?, ?, ?, ?, ?, ?)
        `
            )
            .run('telegram:chat-1', 'browse_web', 'inline', 'errors', new Date().toISOString(), 'completed');

        const deleted = dbModule.cleanupToolExecutionLogs(30);
        const remaining = dbModule.getDb().prepare('SELECT COUNT(*) as cnt FROM tool_execution_log').get() as {
            cnt: number;
        };

        expect(deleted).toBe(1);
        expect(remaining.cnt).toBe(1);
    });

    it('stores tool logs with full result text and cleans them up by retention window', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        const fullResult = 'x'.repeat(600);
        dbModule.insertToolLog({
            space_id: 'telegram:chat-1',
            task_id: 'task-1',
            tool_name: 'browse_web',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { url: 'https://example.com' },
            result_text: fullResult,
            status: 'success',
            started_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
            finished_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000 + 500).toISOString(),
            duration_ms: 500,
        });
        dbModule.insertToolLog({
            space_id: 'telegram:chat-1',
            task_id: 'task-1',
            tool_name: 'browse_web',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { url: 'https://example.com/recent' },
            result_text: 'recent',
            status: 'success',
            started_at: new Date().toISOString(),
            finished_at: new Date(Date.now() + 10).toISOString(),
            duration_ms: 10,
        });

        const rows = dbModule.getToolLogsForTask('task-1');
        expect(rows).toHaveLength(2);
        expect(rows[0].result_text).toBe('recent');
        expect(rows[1].result_text).toBe(fullResult);
        expect(JSON.parse(rows[1].args_json)).toEqual({ url: 'https://example.com' });

        const deleted = dbModule.cleanupToolLogs(30);
        const remaining = dbModule.getDb().prepare('SELECT COUNT(*) as cnt FROM tool_logs').get() as {
            cnt: number;
        };

        expect(deleted).toBe(1);
        expect(remaining.cnt).toBe(1);
    });

    it('queries and summarizes tool logs with filters, paging, and text search', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.insertToolLog({
            space_id: 'telegram:chat-1',
            task_id: 'task-1',
            tool_name: 'browse_web',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { query: 'rome weather' },
            result_text: 'Sunny in Rome',
            status: 'success',
            started_at: '2026-04-14T08:00:00.000Z',
            finished_at: '2026-04-14T08:00:01.000Z',
            duration_ms: 1000,
        });
        dbModule.insertToolLog({
            space_id: 'telegram:chat-1',
            task_id: 'task-2',
            tool_name: 'browse_web',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { query: 'milan trains' },
            result_text: null,
            status: 'error',
            error: 'timeout',
            started_at: '2026-04-14T09:00:00.000Z',
            finished_at: '2026-04-14T09:00:03.000Z',
            duration_ms: 3000,
        });
        dbModule.insertToolLog({
            space_id: 'telegram:chat-2',
            task_id: 'task-3',
            tool_name: 'workspace_read_text',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { path: 'README.md' },
            result_text: 'README body',
            status: 'blocked',
            started_at: '2026-04-14T10:00:00.000Z',
            finished_at: '2026-04-14T10:00:00.500Z',
            duration_ms: 500,
        });

        const filtered = dbModule.queryToolLogs({
            tool_name: 'browse_web',
            q: 'rome',
            limit: 1,
            offset: 0,
        });
        const summary = dbModule.summarizeToolLogs({ space_id: 'telegram:chat-1' });

        expect(filtered.total).toBe(1);
        expect(filtered.items).toHaveLength(1);
        expect(filtered.items[0].tool_name).toBe('browse_web');
        expect(filtered.items[0].result_text).toBe('Sunny in Rome');
        expect(filtered.has_more).toBe(false);

        expect(summary.total).toBe(2);
        expect(summary.by_status).toEqual({ error: 1, success: 1 });
        expect(summary.by_tool).toEqual([{ tool_name: 'browse_web', count: 2 }]);
    });

    it('stores and queries generic memory entries', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.rememberMemoryEntry({
            scope_type: 'person',
            scope_id: '111',
            kind: 'preference',
            content: 'prefers tea in the morning',
            salience: 0.8,
            source: 'memory_remember',
        });
        dbModule.rememberMemoryEntry({
            scope_type: 'space',
            scope_id: 'telegram:chat-1',
            kind: 'diary',
            content: 'A productive day.',
            salience: 0.4,
            source: 'diary_write',
        });

        const personEntries = dbModule.getMemoryEntries('person', '111');
        const deleted = dbModule.deleteMemoryEntriesByContent('productive');
        const remaining = dbModule.getMemoryEntries();

        expect(personEntries).toHaveLength(1);
        expect(personEntries[0].content).toContain('prefers tea');
        expect(deleted).toBe(1);
        expect(remaining).toHaveLength(1);
    });

    it('searches project recollections alongside space and work recollections', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        const project = dbModule.createProject({
            title: 'Travel reset',
            goal: 'Plan the move.',
            next_step: 'Book the train.',
        });
        dbModule.rememberMemoryEntry({
            scope_type: 'project',
            scope_id: project.id,
            kind: 'recollection',
            content: 'Project recollection: booked the train and narrowed the apartment shortlist.',
            salience: 0.85,
            source: 'test',
        });

        const recollections = dbModule.searchRecollections('train', { limit: 5 });

        expect(recollections).toHaveLength(1);
        expect(recollections[0].scope_type).toBe('project');
        expect(recollections[0].space_title).toBe('Travel reset');
    });

    it('deduplicates memory entries by prefix and updates their latest content', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.rememberMemoryEntry({
            scope_type: 'person',
            scope_id: '111',
            kind: 'preference',
            content: 'prefers green tea in the morning with lemon',
            salience: 0.4,
        });
        dbModule.rememberMemoryEntry({
            scope_type: 'person',
            scope_id: '111',
            kind: 'preference',
            content: 'prefers green tea in the morning with lemon and honey',
            salience: 0.9,
            source: 'memory_update',
        });

        const personEntries = dbModule.getMemoryEntries('person', '111', 'preference', 10);

        expect(personEntries).toHaveLength(1);
        expect(personEntries[0].content).toContain('lemon and honey');
        expect(personEntries[0].salience).toBe(0.9);
        expect(personEntries[0].source).toBe('memory_update');
    });

    it('deduplicates memory entries within the same space boundary only', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.rememberMemoryEntry({
            scope_type: 'person',
            scope_id: '111',
            kind: 'preference',
            content: 'prefers green tea in the morning with lemon',
            salience: 0.4,
        });
        dbModule.rememberMemoryEntry({
            scope_type: 'person',
            scope_id: '111',
            kind: 'preference',
            content: 'prefers green tea in the morning with lemon',
            salience: 0.6,
            space_bound_id: 'telegram:chat-1',
        });
        dbModule.rememberMemoryEntry({
            scope_type: 'person',
            scope_id: '111',
            kind: 'preference',
            content: 'prefers green tea in the morning with lemon and honey',
            salience: 0.9,
            source: 'memory_update',
            space_bound_id: 'telegram:chat-1',
        });
        dbModule.rememberMemoryEntry({
            scope_type: 'person',
            scope_id: '111',
            kind: 'preference',
            content: 'prefers green tea in the morning with lemon',
            salience: 0.7,
            space_bound_id: 'telegram:chat-2',
        });

        const rows = dbModule
            .getDb()
            .prepare(
                `
                SELECT content, salience, source, space_bound_id
                FROM memory_entries
                WHERE scope_type = 'person' AND scope_id = '111' AND kind = 'preference'
                ORDER BY COALESCE(space_bound_id, '')
            `
            )
            .all() as Array<{ content: string; salience: number; source: string; space_bound_id: string | null }>;

        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({
            content: 'prefers green tea in the morning with lemon',
            space_bound_id: null,
        });
        expect(rows[1]).toMatchObject({
            content: 'prefers green tea in the morning with lemon and honey',
            salience: 0.9,
            source: 'memory_update',
            space_bound_id: 'telegram:chat-1',
        });
        expect(rows[2]).toMatchObject({
            content: 'prefers green tea in the morning with lemon',
            space_bound_id: 'telegram:chat-2',
        });
    });

    it('normalizes sender fields consistently when storing modern channel messages', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.storeMessage({
            id: 'discord-modern-1',
            channel: 'discord',
            channel_ref: 'room-77',
            sender_id: 'discord:user-9',
            content: 'hello from modern runtime',
            timestamp: new Date().toISOString(),
            is_bot: 0,
        });

        const row = dbModule
            .getDb()
            .prepare(
                `
            SELECT * FROM messages WHERE id = ?
        `
            )
            .get('discord-modern-1') as any;

        expect(row.space_id).toBe('discord:room-77');
        expect(row.chat_jid).toBe('room-77');
        expect(row.sender_tg_id).toBe('discord:user-9');
    });

    it('stores Atelier capability-gap requests by space and pack with dedupe', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        const spaceId = dbModule.buildTelegramSpaceId('chat-1');
        dbModule.updateSpaceAssistantPack(spaceId, 'office');

        const first = dbModule.createCapabilityGapRequest({
            space_id: spaceId,
            assistant_pack_id: 'office',
            capability_gap: 'gmail_thread_actions',
            description: 'Need to archive and triage Gmail threads from the office pack.',
            requested_by: '111',
            user_request: 'Please triage this shared inbox automatically.',
        });
        const second = dbModule.createCapabilityGapRequest({
            space_id: spaceId,
            assistant_pack_id: 'office',
            capability_gap: 'gmail_thread_actions',
            description: 'Need to archive and triage Gmail threads from the office pack.',
            requested_by: '222',
            user_request: 'Also handle follow-up labels and archiving.',
        });

        const bySpace = dbModule.listSkillRequests({ spaceId });
        const byPack = dbModule.listSkillRequests({ assistantPackId: 'office' });

        expect(first.deduped).toBe(false);
        expect(second.deduped).toBe(true);
        expect(bySpace).toHaveLength(1);
        expect(byPack).toHaveLength(1);
        expect(bySpace[0].assistant_pack_id).toBe('office');
        expect(bySpace[0].capability_gap).toBe('gmail_thread_actions');
        expect(bySpace[0].votes).toBe(2);
    });

    it('stores a minimal implementation ticket on an Atelier request', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        dbModule.upsertChat({ jid: 'chat-1', type: 'group' });
        const spaceId = dbModule.buildTelegramSpaceId('chat-1');
        dbModule.updateSpaceAssistantPack(spaceId, 'office');

        const created = dbModule.createCapabilityGapRequest({
            space_id: spaceId,
            assistant_pack_id: 'office',
            capability_gap: 'gmail_thread_actions',
            description: 'Need to archive and triage Gmail threads from the office pack.',
            requested_by: '111',
            user_request: 'Please triage this shared inbox automatically.',
        });

        const updated = dbModule.saveImplementationTicket({
            request_id: created.request.id!,
            ticket: '[IMPLEMENTATION_TICKET ATL-1]\nTitle: office / gmail_thread_actions',
            created_by: '111',
            status: 'draft',
        });

        expect(updated?.implementation_ticket_status).toBe('draft');
        expect(updated?.implementation_ticket_created_by).toBe('111');
        expect(updated?.implementation_ticket).toContain('gmail_thread_actions');
    });

    it('closes the database cleanly', async () => {
        const dbModule = await loadDbModule();
        dbModule.initDatabase();

        const db = dbModule.getDb();
        expect(() => db.prepare('SELECT 1')).not.toThrow();

        dbModule.closeDatabase();
        expect(() => db.prepare('SELECT 1')).toThrow();
    });
});
