import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, makeDbModuleMock, seedResident } from '../test-helpers/mock-db';

let db: Database.Database;

async function loadOperatorCommands(options?: {
    handlers?: Record<string, any>;
    assistantPack?: Record<string, any>;
    runtimeBackup?: Record<string, any>;
}) {
    vi.resetModules();
    vi.doMock('../db', () => makeDbModuleMock(db));
    vi.doMock('../skills/_registry', () => ({
        getRegisteredHandlers: () => ({
            pipi_status: vi.fn(async () => '[TOOL_RESULT] setup status body'),
            pipi_apply_defaults: vi.fn(async () => '[TOOL_RESULT] defaults applied'),
            pipi_smoke: vi.fn(async () => '[TOOL_RESULT] smoke body'),
            ...options?.handlers,
        }),
    }));
    vi.doMock('./_registry', () => ({
        getChannel: vi.fn(() => ({ isConnected: () => true })),
    }));
    vi.doMock('../core/assistant-pack', () => ({
        getAssistantPack: vi.fn((id: string) => ({ id, persona_id: `${id}_persona` })),
        getAssistantPackIds: vi.fn(() => ['jeeves', 'tutor']),
        materializeAgentForPack: vi.fn((id: string) => ({
            id,
            persona_id: `${id}_persona`,
            source: id === 'missing' ? 'static' : 'installable',
        })),
        ...options?.assistantPack,
    }));
    vi.doMock('../core/runtime-backup', () => ({
        createRuntimeBackup: vi.fn(async () => ({
            id: 'backup-123',
            file_count: 4,
            counts: { spaces: 2, memory_entries: 7, tasks: 3, artifacts: 0, grounding_overrides: 0 },
            warnings: [],
        })),
        getLatestRuntimeBackup: vi.fn(() => null),
        listRuntimeBackups: vi.fn(() => []),
        ...options?.runtimeBackup,
    }));

    return await import('./operator-commands');
}

beforeEach(() => {
    db = createTestDb();
    seedResident(db, { tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
});

afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('channels/operator-commands', () => {
    it('shows a friendly one-tap setup screen for a new space', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runSetupTelegramCommand({
            chatId: 'chat-1',
            chatType: 'private',
            userId: '111',
            text: '/setup',
        });

        expect(result).toContain('Set up this chat');
        expect(result).toContain('Use recommended settings');
        expect(result).not.toContain('Setup state');
    });

    it('applies defaults and marks setup as active', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runSetupTelegramCommand({
            chatId: 'chat-2',
            chatType: 'private',
            userId: '111',
            text: '/setup apply',
        });

        const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:chat-2') as any;
        expect(result).toContain('Recommended settings applied');
        expect(result).toContain("You're ready");
        expect(JSON.parse(row.policy_json)).toEqual(
            expect.objectContaining({
                onboarding_state: 'active',
                setup_version: 1,
            })
        );
    });

    it('does not mark setup active when recommended settings are unavailable', async () => {
        const commands = await loadOperatorCommands({ handlers: { pipi_apply_defaults: undefined } });

        const result = await commands.runSetupTelegramCommand({
            chatId: 'chat-unavailable',
            chatType: 'private',
            userId: '111',
            text: '/setup apply',
        });

        const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:chat-unavailable') as any;
        expect(result).toContain('not available');
        expect(JSON.parse(row.policy_json || '{}').onboarding_state).not.toBe('active');
    });

    it('keeps technical setup details behind the explicit status action', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runSetupTelegramCommand({
            chatId: 'chat-status',
            chatType: 'private',
            userId: '111',
            text: '/setup status',
        });

        expect(result).toContain('Technical setup status');
        expect(result).toContain('State: new');
        expect(result).toContain('setup status body');
    });

    it('updates and reports channel mode for the current space', async () => {
        const commands = await loadOperatorCommands();

        expect(
            await commands.runChannelTelegramCommand({
                chatId: 'chat-3',
                chatType: 'group',
                userId: '111',
                text: '/channel mode inbox',
            })
        ).toContain('"inbox"');

        const status = await commands.runChannelTelegramCommand({
            chatId: 'chat-3',
            chatType: 'group',
            userId: '111',
            text: '/channel status',
        });

        expect(status).toContain('Mode: inbox');
        expect(status).toContain('Adapter: connected');
    });

    it('attaches a Telegram group as an external partner/client space', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runChannelTelegramCommand({
            chatId: 'partner-chat',
            chatType: 'group',
            userId: '111',
            text: '/channel attach',
        });

        const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:partner-chat') as any;
        const policy = JSON.parse(row.policy_json);

        expect(result).toContain('External group attached');
        expect(policy).toEqual(
            expect.objectContaining({
                channel_mode: 'full',
                external_group_enabled: true,
                external_group_mode: 'mention_only',
            })
        );
    });

    it('can switch an attached external group to auto mode', async () => {
        const commands = await loadOperatorCommands();

        await commands.runChannelTelegramCommand({
            chatId: 'partner-chat',
            chatType: 'group',
            userId: '111',
            text: '/channel attach',
        });
        const result = await commands.runChannelTelegramCommand({
            chatId: 'partner-chat',
            chatType: 'group',
            userId: '111',
            text: '/channel external auto',
        });

        const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:partner-chat') as any;
        expect(result).toContain('"auto"');
        expect(JSON.parse(row.policy_json)).toEqual(
            expect.objectContaining({
                external_group_enabled: true,
                external_group_mode: 'auto',
            })
        );
    });

    it('can attach an external group in watch mode without auto-replies', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runChannelTelegramCommand({
            chatId: 'partner-watch',
            chatType: 'supergroup',
            userId: '111',
            text: '/channel attach watch',
        });

        const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:partner-watch') as any;
        const policy = JSON.parse(row.policy_json);

        expect(result).toContain('Mode: watch');
        expect(result).toContain('Channel mode: inbox');
        expect(policy).toEqual(
            expect.objectContaining({
                channel_mode: 'inbox',
                external_group_enabled: true,
                external_group_watch_only: true,
            })
        );
    });

    it('stores aliases and reports message stats for external groups', async () => {
        const commands = await loadOperatorCommands();

        await commands.runChannelTelegramCommand({
            chatId: 'partner-chat',
            chatType: 'group',
            userId: '111',
            text: '/channel attach auto',
        });
        await commands.runChannelTelegramCommand({
            chatId: 'partner-chat',
            chatType: 'group',
            userId: '111',
            text: '/channel alias add AI-Duck Advertising',
        });
        db.prepare(
            `
            INSERT INTO messages (id, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `
        ).run('m1', 'telegram:partner-chat', 'partner-chat', '222', 'Реклама в Meta', '2026-06-01T14:49:57.474Z');

        const status = await commands.runChannelTelegramCommand({
            chatId: 'partner-chat',
            chatType: 'group',
            userId: '111',
            text: '/channel status',
        });
        const list = await commands.runChannelTelegramCommand({
            chatId: 'owner-chat',
            chatType: 'private',
            userId: '111',
            text: '/channel list',
        });

        expect(status).toContain('Aliases: AI-Duck Advertising');
        expect(status).toContain('Messages: 1');
        expect(status).toContain('Last message: 2026-06-01 14:49');
        expect(list).toContain('partner-chat');
        expect(list).toContain('mode=auto');
        expect(list).toContain('aliases=AI-Duck Advertising');
    });

    it('requires an explicit action when several approvals are pending', async () => {
        const commands = await loadOperatorCommands();
        const approvals = await import('../utils/approvals');

        approvals.requireToolApproval('browse_web', { chatId: 'chat-4', userId: '111' }, 'browse web');
        approvals.requireToolApproval('webrun_execute', { chatId: 'chat-4', userId: '111' }, 'deep research');

        const result = commands.runApprovalTelegramCommand('approve', {
            chatId: 'chat-4',
            chatType: 'private',
            userId: '111',
            text: '/approve',
        });

        expect(result).toContain('More than one approval is pending');
        expect(result).toContain('browse_web');
        expect(result).toContain('deep_research');
    });

    it('approves a single requested action class explicitly', async () => {
        const commands = await loadOperatorCommands();
        const approvals = await import('../utils/approvals');

        approvals.requireToolApproval('browse_web', { chatId: 'chat-5', userId: '111' }, 'browse web');
        const result = commands.runApprovalTelegramCommand('approve', {
            chatId: 'chat-5',
            chatType: 'private',
            userId: '111',
            text: '/approve browse_web',
        });

        expect(result).toContain('Approved: browse_web.');
        expect(approvals.listPendingApprovalActions({ chatId: 'chat-5', userId: '111' })).toEqual([]);
    });

    it('approves a newly registered action class without a command allowlist change', async () => {
        const commands = await loadOperatorCommands();
        const approvals = await import('../utils/approvals');

        approvals.requireToolApproval('publish_report', { chatId: 'chat-new', userId: '111' }, 'publish report');
        const result = commands.runApprovalTelegramCommand('approve', {
            chatId: 'chat-new',
            chatType: 'private',
            userId: '111',
            text: '/approve publish_report',
        });

        expect(result).toContain('Approved: publish_report.');
        expect(approvals.listPendingApprovalActions({ chatId: 'chat-new', userId: '111' })).toEqual([]);
    });

    it('shows current pack and available packs for /pack', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runPackTelegramCommandAsync({
            chatId: 'chat-6',
            chatType: 'private',
            userId: '111',
            text: '/pack',
        });

        expect(result).toContain('Current pack: jeeves (jeeves_persona)');
        expect(result).toContain('jeeves (jeeves_persona) ← current');
        expect(result).toContain('tutor (tutor_persona)');
        expect(result).toContain('/pack mutate <id>');
    });

    it('returns backup status hint when no backups exist yet', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runBackupTelegramCommand({
            chatId: 'chat-7',
            chatType: 'private',
            userId: '111',
            text: '/backup status',
        });

        expect(result).toContain('No backups yet.');
        expect(result).toContain('Create one: /backup');
        expect(result).toContain('always run /backup before upgrading the bot');
    });

    it('shows usage text for unsupported backup subcommands', async () => {
        const commands = await loadOperatorCommands();

        const result = await commands.runBackupTelegramCommand({
            chatId: 'chat-8',
            chatType: 'private',
            userId: '111',
            text: '/backup what',
        });

        expect(result).toContain('Usage:');
        expect(result).toContain('/backup — create a backup now');
        expect(result).toContain('/backup status — show latest backup');
    });
});
