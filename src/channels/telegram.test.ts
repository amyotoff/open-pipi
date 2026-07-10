import { afterEach, describe, expect, it, vi } from 'vitest';

const setMyCommands = vi.fn(() => Promise.resolve(true));
const launch = vi.fn();
const stop = vi.fn();
const pinChatMessage = vi.fn(async () => true);
const unpinChatMessage = vi.fn(async () => true);
const sendDocument = vi.fn(async () => ({ message_id: 43 }));
const fromLocalFile = vi.fn((path: string, filename?: string) => ({ source: path, filename }));
const executeChannelCommand = vi.fn(async () => true);

vi.mock('telegraf', () => {
    class Telegraf {
        telegram = {
            setMyCommands,
            sendMessage: vi.fn(async () => ({ message_id: 42 })),
            sendChatAction: vi.fn(),
            pinChatMessage,
            unpinChatMessage,
            sendDocument,
        };
        command = vi.fn();
        action = vi.fn();
        on = vi.fn();
        launch = launch;
        stop = stop;

        constructor(_token: string) {}
    }

    return {
        Telegraf,
        Markup: {},
        Input: { fromLocalFile },
    };
});

vi.mock('../config', () => ({
    TELEGRAM_BOT_TOKEN: 'test-token',
    HOUSEHOLD_CHAT_ID: null,
    isOwner: vi.fn(() => true),
}));

vi.mock('../db', () => ({
    buildTelegramSpaceId: vi.fn((chatId: string) => `telegram:${chatId}`),
    ensureSpaceMembership: vi.fn(),
    ensureTelegramSpace: vi.fn(),
    getResident: vi.fn(() => null),
    upsertResident: vi.fn(),
    logEvent: vi.fn(),
}));

vi.mock('../core/channel-commands', () => ({
    executeChannelCommand,
}));

vi.mock('./members-command', () => ({
    MEMBERS_USAGE: 'usage',
    parseMembersCommandRequest: vi.fn(),
}));

vi.mock('./operator-commands', () => ({
    runApprovalTelegramCommand: vi.fn(),
    runBackupTelegramCommand: vi.fn(),
    runChannelTelegramCommand: vi.fn(),
    runPackTelegramCommandAsync: vi.fn(),
    runSetupTelegramCommand: vi.fn(),
    stripToolResultPrefix: vi.fn((value: string) => value),
}));

describe('channels/telegram', () => {
    afterEach(() => {
        setMyCommands.mockClear();
        launch.mockClear();
        stop.mockClear();
        pinChatMessage.mockClear();
        unpinChatMessage.mockClear();
        sendDocument.mockClear();
        fromLocalFile.mockClear();
        executeChannelCommand.mockClear();
        vi.resetModules();
    });

    it('registers only the compact everyday Telegram menu', async () => {
        const telegram = await import('./telegram');

        telegram.startTelegramBot();

        expect(setMyCommands).toHaveBeenCalledTimes(1);

        const firstCall = setMyCommands.mock.calls.at(0) as unknown[] | undefined;
        expect(firstCall).toBeDefined();

        const commands = (firstCall?.[0] ?? []) as Array<{ command: string; description: string }>;
        expect(commands.map((item) => item.command)).toEqual(['start', 'today', 'tasks', 'help', 'setup']);
        expect(commands.map((item) => item.command)).not.toContain('pack');
        expect(commands.map((item) => item.command)).not.toContain('backup');
        expect(commands.map((item) => item.command)).not.toContain('brief');
        expect(telegram.bot.command).toHaveBeenCalledWith('help', expect.any(Function));
        const action = telegram.bot.action as unknown as ReturnType<typeof vi.fn>;
        expect(action.mock.calls.some((call: unknown[]) => String(call[0]).includes('daily:'))).toBe(true);
        expect(launch).toHaveBeenCalledTimes(1);
    });

    it('runs daily dashboard actions as their existing commands', async () => {
        const telegram = await import('./telegram');
        const action = telegram.bot.action as unknown as ReturnType<typeof vi.fn>;
        const registration = action.mock.calls.find((call: unknown[]) => String(call[0]).includes('daily:'));
        const handler = registration?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
        const answerCbQuery = vi.fn(async () => true);

        expect(handler).toBeDefined();
        await handler?.({
            from: { id: 111 },
            chat: { id: 222, type: 'private' },
            match: ['daily:focus', 'focus'],
            answerCbQuery,
        });

        expect(answerCbQuery).toHaveBeenCalledWith('Working…');
        expect(executeChannelCommand).toHaveBeenCalledWith(expect.objectContaining({ rawText: '/focus' }));
    });

    it('sends formatted HTML with a plain-text fallback', async () => {
        const telegram = await import('./telegram');
        const sendMessage = telegram.bot.telegram.sendMessage as ReturnType<typeof vi.fn>;

        sendMessage.mockRejectedValueOnce(new Error('bad html'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await telegram.sendMessageToChat('chat-1', '**Сводка**\n- **Kristina:** проверить <link>');

        expect(sendMessage).toHaveBeenNthCalledWith(
            1,
            'chat-1',
            '<b>Сводка</b>\n• <b>Kristina:</b> проверить &lt;link&gt;',
            {
                parse_mode: 'HTML',
            }
        );
        expect(sendMessage).toHaveBeenNthCalledWith(2, 'chat-1', 'Сводка\n• Kristina: проверить <link>');

        consoleSpy.mockRestore();
    });

    it('pins a sent Telegram message when requested', async () => {
        const telegram = await import('./telegram');

        const result = await telegram.sendMessageToChat('chat-1', 'Daily brief: https://example.test/briefs/a.html', {
            pin: true,
            unpinAfterHours: 24,
            pinDisableNotification: true,
        });

        expect(result).toEqual({ success: true, messageId: '42' });
        expect(pinChatMessage).toHaveBeenCalledWith('chat-1', 42, { disable_notification: true });
    });

    it('sends a local file as a Telegram document', async () => {
        const telegram = await import('./telegram');

        const result = await telegram.sendFileToChat('chat-1', '/tmp/brief.html', {
            filename: 'brief.html',
            caption: 'Brief HTML',
            pin: true,
        });

        expect(result).toEqual({ success: true, messageId: '43' });
        expect(fromLocalFile).toHaveBeenCalledWith('/tmp/brief.html', 'brief.html');
        expect(sendDocument).toHaveBeenCalledWith(
            'chat-1',
            { source: '/tmp/brief.html', filename: 'brief.html' },
            {
                caption: 'Brief HTML',
            }
        );
        expect(pinChatMessage).toHaveBeenCalledWith('chat-1', 43, { disable_notification: true });
    });
});
