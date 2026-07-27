/**
 * The worker end to end, against real SQLite and a fake transport.
 *
 * What matters here is that a delivery survives a failing transport and a
 * restart, so the queue is real and only the wire is faked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINIMAL_TRANSPORT_CAPABILITIES } from '../transports/types';
import type { DeliveryResult, OutgoingMessage, TransportAdapter, TransportDestination } from '../transports/types';

const ORIGINAL_ENV = { ...process.env };

let dataDir: string;

const destination: TransportDestination = { endpointId: '-100', endpointType: 'group' };
const payload: OutgoingMessage = { id: 'msg-1', content: { text: 'hello' } };

interface FakeTransport extends TransportAdapter {
    sent: Array<{ destination: TransportDestination; message: OutgoingMessage }>;
    results: DeliveryResult[];
}

function createFakeTransport(results: DeliveryResult[] = []): FakeTransport {
    const sent: FakeTransport['sent'] = [];

    return {
        name: 'telegram',
        sent,
        results,
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        getCapabilities: vi.fn(async () => MINIMAL_TRANSPORT_CAPABILITIES),
        send: vi.fn(async (dest: TransportDestination, message: OutgoingMessage) => {
            sent.push({ destination: dest, message });
            return results.shift() ?? { status: 'sent' as const, transportMessageId: `tg-${sent.length}` };
        }),
    };
}

async function loadWorker(transport?: TransportAdapter) {
    vi.resetModules();
    const db = await import('../db');
    db.initDatabase();

    const registry = await import('../transports/registry');
    registry.resetTransportRegistry();
    if (transport) registry.registerTransport(transport);

    const outbox = await import('./outbox');
    const worker = await import('./delivery-worker');
    return { db, outbox, worker };
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-worker-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    try {
        const worker = await import('./delivery-worker');
        worker.stopDeliveryWorker();
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('delivery worker', () => {
    it('delivers a queued message and marks it sent', async () => {
        const transport = createFakeTransport();
        const { outbox, worker } = await loadWorker(transport);
        const entry = outbox.enqueueDelivery({ transport: 'telegram', destination, payload });

        expect(await worker.processNextDelivery()).toBe(true);

        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0].message.content.text).toBe('hello');
        const stored = outbox.getOutboxEntry(entry.id)!;
        expect(stored.status).toBe('sent');
        expect(stored.message_id).toBe('tg-1');
    });

    it('reports nothing to do on an empty queue', async () => {
        const { worker } = await loadWorker(createFakeTransport());

        expect(await worker.processNextDelivery()).toBe(false);
    });

    it('retries a transient failure and succeeds on the next attempt', async () => {
        const transport = createFakeTransport([
            { status: 'retryable_error', error: 'rate limited' },
            { status: 'sent', transportMessageId: 'tg-2' },
        ]);
        const { outbox, worker } = await loadWorker(transport);
        const entry = outbox.enqueueDelivery({ transport: 'telegram', destination, payload });

        await worker.processNextDelivery();
        expect(outbox.getOutboxEntry(entry.id)!.status).toBe('queued');

        // Move past the backoff the way the clock would.
        const { getDb } = await import('../db');
        getDb().prepare('UPDATE outbox SET next_retry_at = ? WHERE id = ?').run(new Date(0).toISOString(), entry.id);

        await worker.processNextDelivery();

        const stored = outbox.getOutboxEntry(entry.id)!;
        expect(stored.status).toBe('sent');
        expect(stored.attempts).toBe(2);
        expect(transport.sent).toHaveLength(2);
    });

    it('stops retrying a permanent rejection', async () => {
        const transport = createFakeTransport([{ status: 'permanent_error', error: 'chat not found' }]);
        const { outbox, worker } = await loadWorker(transport);
        const entry = outbox.enqueueDelivery({ transport: 'telegram', destination, payload });

        await worker.processNextDelivery();

        expect(outbox.getOutboxEntry(entry.id)!.status).toBe('failed');
        expect(outbox.getOutboxEntry(entry.id)!.attempts).toBe(1);
    });

    it('treats an adapter that throws as a transient fault instead of dying', async () => {
        const transport = createFakeTransport();
        transport.send = vi.fn(async () => {
            throw new Error('socket exploded');
        });
        const { outbox, worker } = await loadWorker(transport);
        const entry = outbox.enqueueDelivery({ transport: 'telegram', destination, payload });

        await expect(worker.processNextDelivery()).resolves.toBe(true);

        const stored = outbox.getOutboxEntry(entry.id)!;
        expect(stored.status).toBe('queued');
        expect(stored.last_error).toContain('socket exploded');
    });

    it('keeps a message for a transport that is not connected yet', async () => {
        const { outbox, worker } = await loadWorker();
        const entry = outbox.enqueueDelivery({ transport: 'discord', destination, payload });

        await worker.processNextDelivery();

        // A channel that failed to start may come back, and the message is
        // still wanted when it does.
        const stored = outbox.getOutboxEntry(entry.id)!;
        expect(stored.status).toBe('queued');
        expect(stored.last_error).toContain('not available');
    });

    it('drains everything due in one pass', async () => {
        const transport = createFakeTransport();
        const { outbox, worker } = await loadWorker(transport);
        for (let i = 0; i < 3; i += 1) {
            outbox.enqueueDelivery({ transport: 'telegram', destination, payload, idempotencyKey: `m-${i}` });
        }

        const delivered = await worker.drainOutbox();

        expect(delivered).toBe(3);
        expect(outbox.countOutboxByStatus()).toEqual({ sent: 3 });
    });

    it('delivers in order within one conversation', async () => {
        const transport = createFakeTransport();
        const { outbox, worker } = await loadWorker(transport);
        outbox.enqueueDelivery({
            transport: 'telegram',
            destination,
            payload: { id: 'a', content: { text: 'first' } },
            idempotencyKey: 'a',
        });
        outbox.enqueueDelivery({
            transport: 'telegram',
            destination,
            payload: { id: 'b', content: { text: 'second' } },
            idempotencyKey: 'b',
        });

        await worker.drainOutbox();

        expect(transport.sent.map((call) => call.message.content.text)).toEqual(['first', 'second']);
    });
});

describe('delivery worker restart recovery', () => {
    it('sends a message that was queued before the process died', async () => {
        const first = await loadWorker();
        first.outbox.enqueueDelivery({ transport: 'telegram', destination, payload });
        first.db.closeDatabase();

        const transport = createFakeTransport();
        const second = await loadWorker(transport);
        second.worker.startDeliveryWorker({ intervalMs: 60_000 });
        await second.worker.drainOutbox();

        expect(transport.sent).toHaveLength(1);
        expect(second.outbox.countOutboxByStatus()).toEqual({ sent: 1 });
    });

    it('re-sends a delivery whose claim died with the process', async () => {
        const first = await loadWorker();
        first.outbox.enqueueDelivery({ transport: 'telegram', destination, payload });
        first.outbox.claimNextDelivery();
        first.db.closeDatabase();

        const transport = createFakeTransport();
        const second = await loadWorker(transport);
        // Without recovery this entry would sit in `processing` forever, held
        // by a process that no longer exists.
        second.worker.startDeliveryWorker({ intervalMs: 60_000 });
        await second.worker.drainOutbox();

        expect(transport.sent).toHaveLength(1);
    });

    it('does not re-send something that already went out', async () => {
        const transport = createFakeTransport();
        const first = await loadWorker(transport);
        first.outbox.enqueueDelivery({ transport: 'telegram', destination, payload });
        await first.worker.drainOutbox();
        first.db.closeDatabase();

        const secondTransport = createFakeTransport();
        const second = await loadWorker(secondTransport);
        second.worker.startDeliveryWorker({ intervalMs: 60_000 });
        await second.worker.drainOutbox();

        expect(secondTransport.sent).toHaveLength(0);
    });
});
