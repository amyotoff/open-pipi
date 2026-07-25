/**
 * External account -> participant.
 *
 * A sender used to *be* their person id: a Telegram user was the bare id, and
 * everyone else was "<transport>:<id>". Identities replace that, so one person
 * can hold a Telegram account and a Web login and be recognized as themselves
 * on both.
 *
 * The old convention stays as the fallback that mints a person id when an
 * account is seen for the first time, which keeps every existing person id
 * exactly as it was.
 */

import {
    ensureParticipantIdentity,
    ensureSpaceMembership,
    getParticipantIdentity,
    getResident,
    upsertResident,
    type Membership,
    type ParticipantIdentity,
    type Resident,
} from '../db';
import { isOwner } from '../config';
import { buildChannelPersonId } from '../channels/runtime';
import type { IncomingMessage } from '../transports/types';

export interface ParticipantResolution {
    participantId: string;
    participant: Resident | undefined;
    identity: ParticipantIdentity;
    membership: Membership;
    /** True when this account had never been seen before. */
    created: boolean;
}

/**
 * Identify the sender, and make sure they are a member of the space.
 *
 * An identity row wins over the string convention: once a human links their
 * Web login to their Telegram participant, messages from either arrive as the
 * same person, with the same memory and the same authority.
 */
export function resolveParticipant(message: IncomingMessage, spaceId: string): ParticipantResolution {
    const transport = message.transport;
    const externalUserId = message.sender.transportUserId;

    const existingIdentity = getParticipantIdentity(transport, externalUserId);
    const participantId = existingIdentity?.participant_id ?? buildChannelPersonId(transport, externalUserId);
    const existingParticipant = getResident(participantId);
    const owner = isOwner(externalUserId, transport);

    if (!existingParticipant) {
        upsertResident({
            tg_id: participantId,
            username: message.sender.username || null,
            display_name: message.sender.displayName || null,
            role: owner ? 'owner' : 'member',
        });
    }

    // upsertResident already ensures the identity for a new participant; this
    // covers the case where the participant existed but the identity did not,
    // and refreshes a changed username without writing when nothing moved.
    const identity = ensureParticipantIdentity({
        participantId,
        transport,
        externalUserId,
        username: message.sender.username || null,
        displayName: message.sender.displayName || null,
    });

    const participant = getResident(participantId);
    const membership = ensureSpaceMembership(spaceId, participantId, participant?.role || (owner ? 'owner' : 'member'));

    return {
        participantId,
        participant,
        identity,
        membership,
        created: !existingParticipant,
    };
}
