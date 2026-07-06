import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadDiscordModule(commandHandled: boolean) {
    vi.resetModules();

    const dispatchIncomingChannelMessage = vi.fn(async () => undefined);
    const executeChannelCommand = vi.fn(async () => commandHandled);

    class MockClient {
        user = { username: 'pipi_bot', id: 'bot-1', tag: 'pipi_bot#0001' };
        constructor(_config?: unknown) {}
        on() {
            return this;
        }
        once() {
            return this;
        }
        async login() {
            return 'ok';
        }
        async destroy() {
            return undefined;
        }
        isReady() {
            return true;
        }
        channels = {
            fetch: vi.fn(async () => null),
        };
        users = {
            fetch: vi.fn(async () => null),
        };
    }

    vi.doMock('discord.js', () => ({
        ChannelType: {
            DM: 'DM',
        },
        Client: MockClient,
        GatewayIntentBits: {
            Guilds: 1,
            GuildMessages: 2,
            DirectMessages: 4,
            MessageContent: 8,
        },
        Partials: {
            Channel: 'Channel',
        },
        TextChannel: class {},
    }));
    vi.doMock('./runtime', () => ({
        dispatchIncomingChannelMessage,
    }));
    vi.doMock('../core/channel-commands', () => ({
        executeChannelCommand,
    }));

    const mod = await import('./discord');
    return {
        DiscordChannel: mod.DiscordChannel,
        mocks: {
            dispatchIncomingChannelMessage,
            executeChannelCommand,
        },
    };
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('channels/discord', () => {
    it('intercepts supported slash commands before they hit the shared router', async () => {
        const { DiscordChannel, mocks } = await loadDiscordModule(true);
        const channel = new DiscordChannel();

        await (channel as any).handleInboundMessage({
            author: { id: 'user-1', username: 'alice', globalName: 'Alice', bot: false },
            member: { displayName: 'Alice D' },
            content: '/brief',
            channelId: 'discord-primary',
            channel: {
                type: 'DM',
                isTextBased: () => true,
                sendTyping: vi.fn(async () => undefined),
            },
            reply: vi.fn(async () => undefined),
        });

        expect(mocks.executeChannelCommand).toHaveBeenCalledTimes(1);
        expect(mocks.dispatchIncomingChannelMessage).not.toHaveBeenCalled();
    });

    it('routes ordinary Discord messages into the shared inbound dispatcher', async () => {
        const { DiscordChannel, mocks } = await loadDiscordModule(false);
        const channel = new DiscordChannel();

        await (channel as any).handleInboundMessage({
            author: { id: 'user-1', username: 'alice', globalName: 'Alice', bot: false },
            member: { displayName: 'Alice D' },
            content: 'Need a plan',
            id: 'msg-1',
            channelId: 'discord-primary',
            channel: {
                type: 'DM',
                isTextBased: () => true,
                sendTyping: vi.fn(async () => undefined),
            },
            reply: vi.fn(async () => undefined),
            reference: null,
        });

        expect(mocks.executeChannelCommand).toHaveBeenCalledTimes(1);
        expect(mocks.dispatchIncomingChannelMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                channel: 'discord',
                channelRef: 'discord-primary',
                senderId: 'user-1',
                senderUsername: 'alice',
                senderDisplayName: 'Alice D',
                messageId: 'msg-1',
                text: 'Need a plan',
                isDirect: true,
                isPrimaryGroup: false,
                botUsername: 'pipi_bot',
                botUserId: 'bot-1',
                respond: expect.any(Function),
            })
        );
    });
});
