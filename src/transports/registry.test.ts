import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getTransport,
    isTransportStarted,
    listTransports,
    registerTransport,
    resetTransportRegistry,
    startAllTransports,
    stopAllTransports,
} from './registry';
import { MINIMAL_TRANSPORT_CAPABILITIES } from './types';
import type { TransportAdapter, TransportRuntimeContext } from './types';

const context: TransportRuntimeContext = {
    messageGateway: { handleIncoming: vi.fn(async () => {}) },
};

function createAdapter(name: string, overrides?: Partial<TransportAdapter>): TransportAdapter {
    return {
        name,
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        send: vi.fn(async () => ({ status: 'sent' as const })),
        getCapabilities: vi.fn(async () => MINIMAL_TRANSPORT_CAPABILITIES),
        ...overrides,
    };
}

describe('transports/registry', () => {
    beforeEach(() => {
        resetTransportRegistry();
        vi.restoreAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('registers, looks up, and lists adapters', () => {
        const telegram = createAdapter('telegram');
        const web = createAdapter('web');

        registerTransport(telegram);
        registerTransport(web);

        expect(getTransport('telegram')).toBe(telegram);
        expect(getTransport('missing')).toBeUndefined();
        expect(listTransports().map((adapter) => adapter.name)).toEqual(['telegram', 'web']);
    });

    it('rejects a duplicate registration instead of silently replacing one', () => {
        registerTransport(createAdapter('telegram'));

        expect(() => registerTransport(createAdapter('telegram'))).toThrow(/already registered/);
    });

    it('starts every registered adapter once', async () => {
        const telegram = createAdapter('telegram');
        registerTransport(telegram);

        const first = await startAllTransports(context);
        const second = await startAllTransports(context);

        expect(first.started).toEqual(['telegram']);
        expect(second.started).toEqual([]);
        expect(telegram.start).toHaveBeenCalledTimes(1);
        expect(telegram.start).toHaveBeenCalledWith(context);
        expect(isTransportStarted('telegram')).toBe(true);
    });

    it('keeps healthy transports running when an optional one fails to start', async () => {
        const telegram = createAdapter('telegram');
        const discord = createAdapter('discord', {
            start: vi.fn(async () => {
                throw new Error('bad token');
            }),
        });

        registerTransport(telegram);
        registerTransport(discord);

        const report = await startAllTransports(context);

        expect(report.started).toEqual(['telegram']);
        expect(report.failed).toHaveLength(1);
        expect(report.failed[0].name).toBe('discord');
        expect(report.failed[0].error.message).toBe('bad token');
        expect(isTransportStarted('telegram')).toBe(true);
        expect(isTransportStarted('discord')).toBe(false);
    });

    it('aborts and unwinds when a required transport fails to start', async () => {
        const web = createAdapter('web');
        const telegram = createAdapter('telegram', {
            start: vi.fn(async () => {
                throw new Error('missing token');
            }),
        });

        registerTransport(web);
        registerTransport(telegram, { required: true });

        await expect(startAllTransports(context)).rejects.toThrow('missing token');
        expect(web.stop).toHaveBeenCalledTimes(1);
        expect(isTransportStarted('web')).toBe(false);
    });

    it('stops started adapters and never lets one failure block the rest of shutdown', async () => {
        const telegram = createAdapter('telegram', {
            stop: vi.fn(async () => {
                throw new Error('socket already gone');
            }),
        });
        const web = createAdapter('web');

        registerTransport(telegram);
        registerTransport(web);
        await startAllTransports(context);

        await expect(stopAllTransports()).resolves.toBeUndefined();
        expect(telegram.stop).toHaveBeenCalledTimes(1);
        expect(web.stop).toHaveBeenCalledTimes(1);
        expect(isTransportStarted('telegram')).toBe(false);
        expect(isTransportStarted('web')).toBe(false);
    });

    it('does not stop an adapter that never started', async () => {
        const discord = createAdapter('discord', {
            start: vi.fn(async () => {
                throw new Error('bad token');
            }),
        });
        registerTransport(discord);
        await startAllTransports(context);

        await stopAllTransports();

        expect(discord.stop).not.toHaveBeenCalled();
    });
});
