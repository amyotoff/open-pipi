/**
 * Drains the outbox.
 *
 * One in-process loop, because the runtime is one process. It claims a
 * delivery, hands it to whichever transport owns the endpoint, and records
 * what happened. Nothing else in the system sends anything.
 */

import { logError, logInfo, logWarn, summarizeError } from '../utils/logging';
import { getTransport } from '../transports/registry';
import { wrapOutboundChannel } from '../transports/legacy-channel';
import {
    claimNextDelivery,
    markDeliveryFailed,
    markDeliverySent,
    readOutboxPayload,
    recoverStuckDeliveries,
    type OutboxEntry,
} from './outbox';
import type { TransportSender } from '../transports/legacy-channel';
import type { TransportDestination } from '../transports/types';

const DEFAULT_POLL_INTERVAL_MS = 1_000;

let timer: NodeJS.Timeout | null = null;
let draining = false;

/**
 * A registered transport first, then a legacy channel. Both know how to put a
 * message on a wire; only one of them knows how to receive.
 */
export function resolveSender(transport: string): TransportSender | null {
    return getTransport(transport) ?? wrapOutboundChannel(transport);
}

function destinationOf(entry: OutboxEntry): TransportDestination {
    return {
        endpointId: entry.endpoint_id,
        endpointType: (entry.endpoint_type || 'direct') as TransportDestination['endpointType'],
        ...(entry.thread_id ? { threadId: entry.thread_id } : {}),
    };
}

/**
 * Deliver at most one entry. Returns false when there was nothing to do, which
 * is how the drain loop knows to stop for this tick.
 */
export async function processNextDelivery(): Promise<boolean> {
    const entry = claimNextDelivery();
    if (!entry) return false;

    const sender = resolveSender(entry.transport);
    if (!sender) {
        // The transport is not connected right now. Worth retrying: a channel
        // that failed to start may come back, and the message is still wanted.
        markDeliveryFailed(entry.id, `Transport "${entry.transport}" is not available.`);
        logWarn('DELIVERY', 'transport_unavailable', { outbox_id: entry.id, transport: entry.transport });
        return true;
    }

    try {
        const result = await sender.send(destinationOf(entry), readOutboxPayload(entry));

        if (result.status === 'sent') {
            markDeliverySent(entry.id, result.transportMessageId);
            logInfo('DELIVERY', 'sent', {
                outbox_id: entry.id,
                transport: entry.transport,
                endpoint: entry.endpoint_id,
                attempts: entry.attempts + 1,
            });
            return true;
        }

        const permanent = result.status === 'permanent_error';
        const failed = markDeliveryFailed(entry.id, result.error || 'Unknown delivery error.', { permanent });
        logWarn('DELIVERY', failed.status === 'failed' ? 'failed' : 'retry', {
            outbox_id: entry.id,
            transport: entry.transport,
            endpoint: entry.endpoint_id,
            attempts: failed.attempts,
            next_retry_at: failed.next_retry_at,
        });
        return true;
    } catch (error) {
        // An adapter that throws is treated as a transient fault rather than
        // being allowed to kill the loop.
        const failed = markDeliveryFailed(entry.id, error instanceof Error ? error.message : 'Delivery threw.');
        logError('DELIVERY', 'threw', { outbox_id: entry.id, ...summarizeError(error) });
        return failed.status !== 'failed';
    }
}

/** Deliver everything currently due, then return. */
export async function drainOutbox(maxDeliveries = 50): Promise<number> {
    if (draining) return 0;
    draining = true;

    let delivered = 0;
    try {
        while (delivered < maxDeliveries) {
            const didWork = await processNextDelivery();
            if (!didWork) break;
            delivered += 1;
        }
    } finally {
        draining = false;
    }

    return delivered;
}

export function startDeliveryWorker(options?: { intervalMs?: number }): void {
    if (timer) return;

    // Every claim still held at boot belongs to a process that no longer
    // exists, so all of them go back on the queue.
    const recovered = recoverStuckDeliveries({ all: true });
    if (recovered > 0) {
        logInfo('DELIVERY', 'recovered_on_start', { entries: recovered });
    }

    timer = setInterval(() => {
        void drainOutbox().catch((error) => {
            logError('DELIVERY', 'drain_failed', summarizeError(error));
        });
    }, options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    timer.unref?.();
}

export function stopDeliveryWorker(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}
