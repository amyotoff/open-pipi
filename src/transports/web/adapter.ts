/**
 * The Web transport.
 *
 * It receives nothing here — a browser posts to the HTTP routes, which call the
 * gateway directly — so this adapter exists for the outbound half: it is what
 * the delivery worker talks to when a space has a web binding.
 *
 * "Sending" means two things that have already happened by the time the worker
 * gets here: the message is in the space's history, and connected clients are
 * nudged to refetch. There is no wire to fail on, which is why a space nobody
 * is looking at still counts as delivered — the history is the source of truth,
 * and the next client to open it reads the message there.
 */

import { publishSpaceActivity } from '../../web/events';
import { MINIMAL_TRANSPORT_CAPABILITIES } from '../types';
import type {
    DeliveryResult,
    OutgoingMessage,
    TransportAdapter,
    TransportCapabilities,
    TransportDestination,
    TransportRuntimeContext,
} from '../types';

export const WEB_TRANSPORT = 'web';

export const WEB_CAPABILITIES: TransportCapabilities = {
    ...MINIMAL_TRANSPORT_CAPABILITIES,
    markdown: true,
    attachments: true,
    images: true,
    replies: true,
    // The client refetches on a nudge rather than consuming a token stream;
    // declaring streaming would promise something no producer delivers yet.
    streaming: false,
    messageEditing: false,
};

export class WebTransportAdapter implements TransportAdapter {
    readonly name = WEB_TRANSPORT;

    async start(_context: TransportRuntimeContext): Promise<void> {
        // Inbound arrives over HTTP, which the API server already serves.
    }

    async stop(): Promise<void> {
        // Streams are closed by the API server's own shutdown.
    }

    async send(destination: TransportDestination, _message: OutgoingMessage): Promise<DeliveryResult> {
        // A web endpoint id is the space id: the web has no chat namespace of
        // its own, so inventing one would be a second name for the same thing.
        publishSpaceActivity(destination.endpointId);
        return { status: 'sent' };
    }

    async getCapabilities(): Promise<TransportCapabilities> {
        return WEB_CAPABILITIES;
    }
}
