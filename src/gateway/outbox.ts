/**
 * The durable outbound queue.
 *
 * An entry is written before any send is attempted, so a crash mid-delivery
 * loses nothing: whatever was queued is still queued after a restart.
 *
 * The runtime is a single process and better-sqlite3 is synchronous, so
 * claiming an entry is one conditional UPDATE with a changes check. No broker,
 * no advisory locks, no second service.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import type { OutgoingMessage, TransportDestination } from '../transports/types';

export type OutboxStatus = 'queued' | 'processing' | 'sent' | 'failed' | 'expired';

export interface OutboxEntry {
    id: string;
    idempotency_key: string;
    space_id: string | null;
    message_id: string | null;
    transport: string;
    endpoint_id: string;
    endpoint_type: string;
    thread_id: string | null;
    payload_json: string;
    correlation_id: string | null;
    status: OutboxStatus;
    attempts: number;
    next_retry_at: string | null;
    last_error: string | null;
    claimed_at: string | null;
    created_at: string;
    updated_at: string;
    sent_at: string | null;
}

/**
 * Backoff for a transport that is unhappy right now: immediate, then seconds,
 * then minutes. Bounded on purpose — after the last attempt an entry is failed
 * and never looked at again, so a permanently broken destination cannot spin
 * forever.
 */
export const RETRY_DELAYS_MS = [0, 5_000, 30_000, 5 * 60_000, 30 * 60_000];
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length;

/** A claim older than this is assumed abandoned by a process that died holding it. */
const STUCK_CLAIM_MS = 10 * 60_000;

function nowIso(): string {
    return new Date().toISOString();
}

export interface EnqueueDeliveryInput {
    transport: string;
    destination: TransportDestination;
    payload: OutgoingMessage;
    spaceId?: string | null;
    messageId?: string | null;
    /**
     * A caller with a natural key passes it and gets exactly-once delivery for
     * free — a task deadline alert keyed on the deadline cannot be sent twice
     * even if the scheduler runs again. Callers without one get a fresh id.
     */
    idempotencyKey?: string;
    /** The inbound turn this delivery answers, for end-to-end tracing. */
    correlationId?: string | null;
}

export function getOutboxEntry(id: string): OutboxEntry | undefined {
    return getDb().prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxEntry | undefined;
}

export function getOutboxEntryByKey(idempotencyKey: string): OutboxEntry | undefined {
    return getDb().prepare('SELECT * FROM outbox WHERE idempotency_key = ?').get(idempotencyKey) as
        | OutboxEntry
        | undefined;
}

/**
 * Queue a delivery, or return the one already queued under the same key.
 *
 * Re-enqueueing an existing key is a no-op rather than an error: the caller's
 * intent ("this should be delivered") is already satisfied.
 */
export function enqueueDelivery(input: EnqueueDeliveryInput): OutboxEntry {
    const idempotencyKey = input.idempotencyKey || `outbox:${randomUUID()}`;
    const existing = getOutboxEntryByKey(idempotencyKey);
    if (existing) return existing;

    const now = nowIso();
    const id = randomUUID();

    getDb()
        .prepare(
            `
        INSERT INTO outbox (
            id, idempotency_key, space_id, message_id, transport,
            endpoint_id, endpoint_type, thread_id, payload_json, correlation_id,
            status, attempts, next_retry_at, created_at, updated_at
        )
        VALUES (
            @id, @idempotency_key, @space_id, @message_id, @transport,
            @endpoint_id, @endpoint_type, @thread_id, @payload_json, @correlation_id,
            'queued', 0, @next_retry_at, @created_at, @updated_at
        )
        ON CONFLICT(idempotency_key) DO NOTHING
    `
        )
        .run({
            id,
            idempotency_key: idempotencyKey,
            space_id: input.spaceId ?? null,
            message_id: input.messageId ?? null,
            transport: input.transport,
            endpoint_id: input.destination.endpointId,
            endpoint_type: input.destination.endpointType,
            thread_id: input.destination.threadId ?? null,
            payload_json: JSON.stringify(input.payload),
            correlation_id: input.correlationId ?? null,
            next_retry_at: now,
            created_at: now,
            updated_at: now,
        });

    return getOutboxEntryByKey(idempotencyKey)!;
}

/**
 * Take the next deliverable entry, in arrival order, one endpoint at a time.
 *
 * Delivery is FIFO per endpoint and deliberately blocks at the head: while the
 * oldest entry for a conversation is waiting on a retry, nothing behind it in
 * that conversation goes out. A reordered answer is worse than a late one, and
 * the block is bounded because retries are. Other endpoints are unaffected.
 */
export function claimNextDelivery(now: string = nowIso()): OutboxEntry | undefined {
    const candidate = getDb()
        .prepare(
            `
        SELECT * FROM outbox AS o
        WHERE o.status = 'queued'
          AND (o.next_retry_at IS NULL OR o.next_retry_at <= @now)
          -- Nothing older in the same conversation may still be in flight or
          -- waiting, or this delivery would overtake it.
          --
          -- Ordering is by rowid, not created_at: two replies queued in the
          -- same millisecond share a timestamp, and breaking that tie on a
          -- random id would deliver them in arbitrary order. rowid is the
          -- insertion sequence, which is exactly what "older" should mean.
          AND NOT EXISTS (
              SELECT 1 FROM outbox AS blocker
              WHERE blocker.transport = o.transport
                AND blocker.endpoint_id = o.endpoint_id
                AND blocker.status IN ('queued', 'processing')
                AND blocker.rowid < o.rowid
          )
        ORDER BY o.rowid ASC
        LIMIT 1
    `
        )
        .get({ now }) as OutboxEntry | undefined;

    if (!candidate) return undefined;

    const claimed = getDb()
        .prepare(
            `
        UPDATE outbox
        SET status = 'processing', claimed_at = @now, updated_at = @now
        WHERE id = @id AND status = 'queued'
    `
        )
        .run({ id: candidate.id, now });

    return claimed.changes === 1 ? getOutboxEntry(candidate.id) : undefined;
}

export function markDeliverySent(id: string, transportMessageId?: string): void {
    const now = nowIso();
    getDb()
        .prepare(
            `
        UPDATE outbox
        SET status = 'sent', sent_at = @now, updated_at = @now, claimed_at = NULL,
            attempts = attempts + 1, last_error = NULL, message_id = COALESCE(@message_id, message_id)
        WHERE id = @id
    `
        )
        .run({ id, now, message_id: transportMessageId ?? null });
}

/**
 * Record a failed attempt: schedule the next one, or give up if the budget is
 * spent. Permanent failures skip the budget entirely — retrying a message the
 * transport has rejected outright only wastes attempts.
 */
export function markDeliveryFailed(id: string, error: string, options?: { permanent?: boolean }): OutboxEntry {
    const entry = getOutboxEntry(id);
    if (!entry) throw new Error(`Outbox entry ${id} does not exist.`);

    const attempts = entry.attempts + 1;
    const exhausted = options?.permanent || attempts >= MAX_DELIVERY_ATTEMPTS;
    const now = nowIso();

    getDb()
        .prepare(
            `
        UPDATE outbox
        SET status = @status,
            attempts = @attempts,
            last_error = @last_error,
            next_retry_at = @next_retry_at,
            claimed_at = NULL,
            updated_at = @now
        WHERE id = @id
    `
        )
        .run({
            id,
            status: exhausted ? 'failed' : 'queued',
            attempts,
            last_error: error.slice(0, 500),
            next_retry_at: exhausted ? null : new Date(Date.now() + RETRY_DELAYS_MS[attempts]).toISOString(),
            now,
        });

    return getOutboxEntry(id)!;
}

/**
 * Return abandoned claims to the queue.
 *
 * Called at boot, where every `processing` row is by definition stranded — the
 * only process that could have been delivering it is the one that just died.
 * Also called periodically, where a claim is only reclaimed once it is old
 * enough that a live attempt is implausible.
 */
export function recoverStuckDeliveries(options?: { all?: boolean }): number {
    const now = nowIso();
    const cutoff = new Date(Date.now() - STUCK_CLAIM_MS).toISOString();

    const result = getDb()
        .prepare(
            `
        UPDATE outbox
        SET status = 'queued', claimed_at = NULL, next_retry_at = @now, updated_at = @now
        WHERE status = 'processing'
          AND (@all = 1 OR claimed_at IS NULL OR claimed_at <= @cutoff)
    `
        )
        .run({ now, cutoff, all: options?.all ? 1 : 0 });

    return result.changes;
}

/**
 * Give a failed entry its attempt budget back.
 *
 * The retry budget exists so a broken destination cannot spin forever, which
 * means a delivery that failed for a reason since fixed — a bot re-added to a
 * group, a network back up — has no way back on its own. This is that way, and
 * it is deliberately a human decision.
 *
 * Only `failed` entries qualify: re-queueing something still in flight would
 * hand the same message to two attempts.
 */
export function requeueDelivery(id: string): OutboxEntry | undefined {
    const now = nowIso();
    const result = getDb()
        .prepare(
            `
        UPDATE outbox
        SET status = 'queued', attempts = 0, last_error = NULL,
            next_retry_at = @now, claimed_at = NULL, updated_at = @now
        WHERE id = @id AND status = 'failed'
    `
        )
        .run({ id, now });

    return result.changes > 0 ? getOutboxEntry(id) : undefined;
}

export function countOutboxByStatus(): Record<string, number> {
    const rows = getDb().prepare('SELECT status, COUNT(*) as count FROM outbox GROUP BY status').all() as Array<{
        status: string;
        count: number;
    }>;

    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export function readOutboxPayload(entry: OutboxEntry): OutgoingMessage {
    return JSON.parse(entry.payload_json) as OutgoingMessage;
}
