/**
 * Outbox behavior against real SQLite. The whole point of this table is that it
 * survives a process dying, so the tests open and close real databases.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutgoingMessage, TransportDestination } from '../transports/types';

const ORIGINAL_ENV = { ...process.env };

let dataDir: string;

const destination: TransportDestination = { endpointId: '-100', endpointType: 'group' };
const payload: OutgoingMessage = { id: 'msg-1', content: { text: 'hello' } };

async function loadOutbox() {
    vi.resetModules();
    const db = await import('../db');
    db.initDatabase();
    const outbox = await import('./outbox');
    return { db, ...outbox };
}

/** Close and reopen: the shape of a restart. */
async function restart() {
    const db = await import('../db');
    db.closeDatabase();
    return loadOutbox();
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-outbox-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir };
});

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('outbox', () => {
    it('queues a delivery before anything is sent', async () => {
        const { enqueueDelivery, readOutboxPayload } = await loadOutbox();

        const entry = enqueueDelivery({ transport: 'telegram', destination, payload });

        expect(entry.status).toBe('queued');
        expect(entry.attempts).toBe(0);
        expect(entry.endpoint_id).toBe('-100');
        expect(readOutboxPayload(entry)).toEqual(payload);
    });

    it('treats a repeated idempotency key as the delivery it already holds', async () => {
        const { enqueueDelivery, countOutboxByStatus } = await loadOutbox();

        const first = enqueueDelivery({
            transport: 'telegram',
            destination,
            payload,
            idempotencyKey: 'task:42:deadline',
        });
        const second = enqueueDelivery({
            transport: 'telegram',
            destination,
            payload: { id: 'msg-2', content: { text: 'different text' } },
            idempotencyKey: 'task:42:deadline',
        });

        // A scheduler that runs twice must not produce two alerts.
        expect(second.id).toBe(first.id);
        expect(countOutboxByStatus()).toEqual({ queued: 1 });
    });

    it('claims an entry once, so a second worker pass finds nothing', async () => {
        const { enqueueDelivery, claimNextDelivery } = await loadOutbox();
        enqueueDelivery({ transport: 'telegram', destination, payload });

        const claimed = claimNextDelivery();
        const again = claimNextDelivery();

        expect(claimed?.status).toBe('processing');
        expect(again).toBeUndefined();
    });

    it('retries with a growing delay and gives up at the budget', async () => {
        const { enqueueDelivery, markDeliveryFailed, MAX_DELIVERY_ATTEMPTS } = await loadOutbox();
        const entry = enqueueDelivery({ transport: 'telegram', destination, payload });

        let current = markDeliveryFailed(entry.id, 'network down');
        expect(current.status).toBe('queued');
        expect(current.attempts).toBe(1);
        expect(Date.parse(current.next_retry_at!)).toBeGreaterThan(Date.now());

        for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
            current = markDeliveryFailed(entry.id, 'still down');
        }

        // Bounded on purpose: a destination that never recovers must not spin.
        expect(current.status).toBe('failed');
        expect(current.next_retry_at).toBeNull();
        expect(current.last_error).toBe('still down');
    });

    it('gives up immediately on a permanent failure', async () => {
        const { enqueueDelivery, markDeliveryFailed } = await loadOutbox();
        const entry = enqueueDelivery({ transport: 'telegram', destination, payload });

        const failed = markDeliveryFailed(entry.id, 'chat not found', { permanent: true });

        expect(failed.status).toBe('failed');
        expect(failed.attempts).toBe(1);
    });

    it('does not hand out an entry whose retry is still in the future', async () => {
        const { enqueueDelivery, markDeliveryFailed, claimNextDelivery } = await loadOutbox();
        const entry = enqueueDelivery({ transport: 'telegram', destination, payload });
        markDeliveryFailed(entry.id, 'network down');

        expect(claimNextDelivery()).toBeUndefined();

        const later = new Date(Date.now() + 60_000).toISOString();
        expect(claimNextDelivery(later)?.id).toBe(entry.id);
    });

    it('marks a sent delivery with the id the transport gave back', async () => {
        const { enqueueDelivery, claimNextDelivery, markDeliverySent, getOutboxEntry } = await loadOutbox();
        const entry = enqueueDelivery({ transport: 'telegram', destination, payload });
        claimNextDelivery();

        markDeliverySent(entry.id, '5150');

        const sent = getOutboxEntry(entry.id)!;
        expect(sent.status).toBe('sent');
        expect(sent.message_id).toBe('5150');
        expect(sent.sent_at).not.toBeNull();
    });
});

describe('outbox ordering', () => {
    it('keeps one conversation in order, blocking behind a retrying message', async () => {
        const { enqueueDelivery, claimNextDelivery, markDeliveryFailed } = await loadOutbox();
        const first = enqueueDelivery({
            transport: 'telegram',
            destination,
            payload,
            idempotencyKey: 'first',
        });
        enqueueDelivery({ transport: 'telegram', destination, payload, idempotencyKey: 'second' });

        markDeliveryFailed(first.id, 'rate limited');

        // The second answer must not overtake the first: a reordered
        // conversation is worse than a late one.
        expect(claimNextDelivery()).toBeUndefined();
    });

    it('lets other conversations through while one is blocked', async () => {
        const { enqueueDelivery, claimNextDelivery, markDeliveryFailed } = await loadOutbox();
        const blocked = enqueueDelivery({
            transport: 'telegram',
            destination,
            payload,
            idempotencyKey: 'blocked',
        });
        enqueueDelivery({
            transport: 'telegram',
            destination: { endpointId: '-200', endpointType: 'group' },
            payload,
            idempotencyKey: 'other',
        });

        markDeliveryFailed(blocked.id, 'rate limited');

        expect(claimNextDelivery()?.endpoint_id).toBe('-200');
    });

    it('resumes the blocked conversation once the head goes through', async () => {
        const { enqueueDelivery, claimNextDelivery, markDeliverySent } = await loadOutbox();
        const first = enqueueDelivery({ transport: 'telegram', destination, payload, idempotencyKey: 'first' });
        const second = enqueueDelivery({ transport: 'telegram', destination, payload, idempotencyKey: 'second' });

        // The head must come out first even though both were queued in the
        // same millisecond, which is why ordering follows insertion, not time.
        expect(claimNextDelivery()?.id).toBe(first.id);
        markDeliverySent(first.id, '1');

        expect(claimNextDelivery()?.id).toBe(second.id);
    });
});

describe('outbox recovery', () => {
    it('resumes a queued delivery after a restart', async () => {
        const first = await loadOutbox();
        const entry = first.enqueueDelivery({ transport: 'telegram', destination, payload });

        const second = await restart();

        const claimed = second.claimNextDelivery();
        expect(claimed?.id).toBe(entry.id);
        expect(second.readOutboxPayload(claimed!)).toEqual(payload);
    });

    it('returns a claim stranded by a crash to the queue', async () => {
        const first = await loadOutbox();
        first.enqueueDelivery({ transport: 'telegram', destination, payload });
        first.claimNextDelivery();
        // The process dies here, holding the claim.

        const second = await restart();
        const recovered = second.recoverStuckDeliveries({ all: true });

        expect(recovered).toBe(1);
        expect(second.claimNextDelivery()).toBeDefined();
    });

    it('leaves a fresh claim alone during a periodic sweep', async () => {
        const { enqueueDelivery, claimNextDelivery, recoverStuckDeliveries } = await loadOutbox();
        enqueueDelivery({ transport: 'telegram', destination, payload });
        claimNextDelivery();

        // Mid-run, a claim taken seconds ago is a live attempt, not a corpse.
        expect(recoverStuckDeliveries()).toBe(0);
    });

    it('reclaims a claim old enough that no attempt could still be running', async () => {
        const { enqueueDelivery, claimNextDelivery, recoverStuckDeliveries, db } = await loadOutbox();
        enqueueDelivery({ transport: 'telegram', destination, payload });
        const claimed = claimNextDelivery()!;

        const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
        db.getDb().prepare('UPDATE outbox SET claimed_at = ? WHERE id = ?').run(longAgo, claimed.id);

        expect(recoverStuckDeliveries()).toBe(1);
    });

    it('does not resurrect a delivery that already went out', async () => {
        const first = await loadOutbox();
        const entry = first.enqueueDelivery({ transport: 'telegram', destination, payload });
        first.claimNextDelivery();
        first.markDeliverySent(entry.id, '1');

        const second = await restart();
        second.recoverStuckDeliveries({ all: true });

        expect(second.claimNextDelivery()).toBeUndefined();
        expect(second.countOutboxByStatus()).toEqual({ sent: 1 });
    });
});
