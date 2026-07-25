/**
 * Endpoint -> space.
 *
 * Routing used to read `spaces.channel` and `spaces.external_ref`, which let a
 * space hold exactly one endpoint. Bindings replace that, so a space can be
 * reachable from Telegram and the Web at once.
 *
 * The legacy columns stay readable for one release: a database that has not
 * been migrated, or a space created by an older build, still routes.
 */

import {
    ensureSpace,
    ensureTransportBinding,
    getSpace,
    getSpaceByChannelRef,
    getTransportBinding,
    type Space,
    type TransportBinding,
} from '../db';
import type { IncomingMessage, TransportEndpointType } from '../transports/types';

export type BindingSource = 'binding' | 'legacy_space' | 'bootstrapped' | 'none';

export interface BindingResolution {
    binding: TransportBinding | null;
    space: Space | null;
    source: BindingSource;
}

/**
 * Transports that must not create a space just because a message arrived.
 *
 * Every chat transport in the repo today auto-connects on first contact, and
 * that behavior is deliberately preserved — an operator adding the bot to a
 * group expects it to work. Web is the exception because a Web room is created
 * by an owner in the UI, so an unrecognized room id is a mistake to surface
 * rather than a space to invent.
 */
const TRANSPORTS_WITHOUT_AUTO_BOOTSTRAP = new Set(['web']);

export function canBootstrapTransport(transport: string): boolean {
    return !TRANSPORTS_WITHOUT_AUTO_BOOTSTRAP.has(transport);
}

function spaceKindForEndpoint(endpointType: TransportEndpointType): string {
    return endpointType === 'direct' ? 'direct_chat' : 'group_chat';
}

/**
 * Find the space this message belongs to, creating one only where that has
 * always been the behavior.
 *
 * Resolution order is deliberate: an explicit binding wins, then the legacy
 * columns, and only then does bootstrap run. That way a re-pointed binding
 * takes effect immediately even though the old columns still say otherwise.
 */
export function resolveTransportBinding(message: IncomingMessage): BindingResolution {
    const { transport, endpoint, threadId } = message;

    const binding = getTransportBinding(transport, endpoint.id, threadId);
    if (binding) {
        return { binding, space: getSpace(binding.space_id) ?? null, source: 'binding' };
    }

    // A thread with no binding of its own belongs to its parent endpoint —
    // otherwise every Telegram forum topic would become its own space.
    if (threadId) {
        const parent = getTransportBinding(transport, endpoint.id);
        if (parent) {
            return { binding: parent, space: getSpace(parent.space_id) ?? null, source: 'binding' };
        }
    }

    const legacySpace = getSpaceByChannelRef(transport, endpoint.id);
    if (legacySpace) {
        return { binding: null, space: legacySpace, source: 'legacy_space' };
    }

    if (!canBootstrapTransport(transport)) {
        return { binding: null, space: null, source: 'none' };
    }

    const space = ensureSpace(transport, endpoint.id, {
        kind: spaceKindForEndpoint(endpoint.type),
        title: endpoint.title || endpoint.id,
    });
    const created = ensureTransportBinding({
        transport,
        endpointId: endpoint.id,
        endpointType: endpoint.type,
        spaceId: space.id,
    });

    return { binding: created, space, source: 'bootstrapped' };
}
