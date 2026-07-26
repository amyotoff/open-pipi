/**
 * Server-sent events for the web client.
 *
 * One event type, on purpose: `space_activity { space_id }`. The client's whole
 * contract is "something happened here, refetch that space". Streaming the
 * message content would duplicate history that the client can already read, and
 * would need reconnection state to avoid gaps; a refetch trigger needs none —
 * EventSource reconnects on its own and the client refetches on open.
 *
 * SSE rather than WebSocket because the only need is server to client. It costs
 * no dependency, survives naive proxies, and reconnects natively.
 */

import type { Response } from 'express';
import { isSpaceMember } from '../db';
import { logInfo } from '../utils/logging';

/** Nudges proxies and load balancers to keep an idle stream open. */
const KEEPALIVE_MS = 25_000;

interface Subscriber {
    id: number;
    participantId: string;
    res: Response;
}

const subscribers = new Map<number, Subscriber>();
let nextSubscriberId = 1;
let keepalive: NodeJS.Timeout | null = null;

function write(res: Response, payload: string): void {
    try {
        res.write(payload);
    } catch {
        // A client that vanished mid-write is not an error; the close handler
        // removes it.
    }
}

function startKeepalive(): void {
    if (keepalive) return;

    keepalive = setInterval(() => {
        for (const subscriber of subscribers.values()) {
            write(subscriber.res, ': keepalive\n\n');
        }
    }, KEEPALIVE_MS);
    keepalive.unref?.();
}

function stopKeepaliveIfIdle(): void {
    if (subscribers.size > 0 || !keepalive) return;
    clearInterval(keepalive);
    keepalive = null;
}

/**
 * Attach a signed-in client to the stream.
 *
 * Returns a detach function; the caller wires it to the request's close event.
 */
export function subscribe(participantId: string, res: Response): () => void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Nginx buffers event streams by default, which makes them useless.
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const id = nextSubscriberId;
    nextSubscriberId += 1;
    subscribers.set(id, { id, participantId, res });
    startKeepalive();

    return () => {
        subscribers.delete(id);
        stopKeepaliveIfIdle();
    };
}

/**
 * Tell everyone who belongs to a space that it moved.
 *
 * Membership is re-checked per subscriber rather than trusted from connect
 * time, so revoking someone's membership stops their stream immediately rather
 * than at their next reconnect.
 */
export function publishSpaceActivity(spaceId: string): void {
    if (subscribers.size === 0) return;

    const payload = `event: space_activity\ndata: ${JSON.stringify({ space_id: spaceId })}\n\n`;
    let delivered = 0;

    for (const subscriber of subscribers.values()) {
        if (!isSpaceMember(spaceId, subscriber.participantId)) continue;
        write(subscriber.res, payload);
        delivered += 1;
    }

    if (delivered > 0) {
        logInfo('WEB', 'space_activity_published', { space_id: spaceId, subscribers: delivered });
    }
}

export function countSubscribers(): number {
    return subscribers.size;
}

/** Test seam, and the shutdown path: drop every stream. */
export function closeAllSubscribers(): void {
    for (const subscriber of subscribers.values()) {
        try {
            subscriber.res.end();
        } catch {
            // Already gone.
        }
    }
    subscribers.clear();
    stopKeepaliveIfIdle();
}
