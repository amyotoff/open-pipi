import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadRuntimeContext(options?: {
    getSpaceByChannelRef?: (channel: string, channelRef: string) => any;
    getSpace?: (spaceId: string) => any;
}) {
    vi.resetModules();

    vi.doMock('../db', () => ({
        buildSpaceId: vi.fn((channel: string, externalRef: string) => `${channel}:${externalRef}`),
        buildTelegramSpaceId: vi.fn((chatId: string) => `telegram:${chatId}`),
        getSpaceByChannelRef: vi.fn(options?.getSpaceByChannelRef || (() => undefined)),
        getSpace: vi.fn(options?.getSpace || (() => undefined)),
    }));

    return await import('./runtime-context');
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/runtime-context', () => {
    it('resolves space ids from explicit, channel, and telegram chat context', async () => {
        const runtime = await loadRuntimeContext({
            getSpaceByChannelRef: (channel, channelRef) =>
                channel === 'discord' && channelRef === 'room-1' ? { id: 'discord:known-room' } : undefined,
        });

        expect(
            runtime.resolveSpaceIdFromExecutionContext({
                userId: '111',
                spaceId: 'telegram:explicit',
            })
        ).toBe('telegram:explicit');

        expect(
            runtime.resolveSpaceIdFromExecutionContext({
                userId: '111',
                channel: 'discord',
                channelRef: 'room-1',
            })
        ).toBe('discord:known-room');

        expect(
            runtime.resolveSpaceIdFromExecutionContext({
                userId: '111',
                channel: 'discord',
                channelRef: 'room-2',
            })
        ).toBe('discord:room-2');

        expect(
            runtime.resolveSpaceIdFromExecutionContext({
                userId: '111',
                chatId: 'chat-7',
            })
        ).toBe('telegram:chat-7');
    });

    it('resolves channel and space details from the backing space when direct context is absent', async () => {
        const runtime = await loadRuntimeContext({
            getSpace: (spaceId) =>
                spaceId === 'telegram:chat-1'
                    ? { id: spaceId, channel: 'telegram', external_ref: 'chat-1' }
                    : undefined,
        });

        expect(
            runtime.resolveRuntimeSpace({
                userId: '111',
                spaceId: 'telegram:chat-1',
            })
        ).toEqual({ id: 'telegram:chat-1', channel: 'telegram', external_ref: 'chat-1' });

        expect(
            runtime.resolveChannelFromExecutionContext({
                userId: '111',
                spaceId: 'telegram:chat-1',
            })
        ).toBe('telegram');

        expect(
            runtime.resolveChannelRefFromExecutionContext({
                userId: '111',
                spaceId: 'telegram:chat-1',
            })
        ).toBe('chat-1');
    });
});
