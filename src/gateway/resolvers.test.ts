/**
 * Resolver behavior against real SQLite: what these do is decide which rows a
 * message belongs to, so a mock schema would only test the mock.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, TransportEndpointType } from '../transports/types';

const ORIGINAL_ENV = { ...process.env };

let dataDir: string;

function buildMessage(overrides: {
    transport?: string;
    endpointId?: string;
    endpointType?: TransportEndpointType;
    endpointTitle?: string | null;
    threadId?: string;
    senderId?: string;
    username?: string | null;
    displayName?: string | null;
}): IncomingMessage {
    return {
        id: `${overrides.transport ?? 'telegram'}:${overrides.endpointId ?? '-100'}:1`,
        transportMessageId: '1',
        transport: overrides.transport ?? 'telegram',
        endpoint: {
            id: overrides.endpointId ?? '-100',
            type: overrides.endpointType ?? 'group',
            title: overrides.endpointTitle ?? 'Household',
        },
        ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
        sender: {
            transportUserId: overrides.senderId ?? '777',
            username: overrides.username ?? 'alex',
            displayName: overrides.displayName ?? 'Alex',
        },
        content: { text: 'hello' },
        timestamp: new Date().toISOString(),
        correlationId: 'test-correlation',
    };
}

async function loadModules() {
    vi.resetModules();
    const db = await import('../db');
    db.initDatabase();
    const bindingResolver = await import('./binding-resolver');
    const participantResolver = await import('./participant-resolver');
    return { db, ...bindingResolver, ...participantResolver };
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-resolvers-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, OWNER_TG_IDS: '777' };
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

describe('binding resolver', () => {
    it('routes through an explicit binding', async () => {
        const { db, resolveTransportBinding } = await loadModules();
        db.ensureSpace('telegram', 'office', { kind: 'group_chat' });
        db.ensureTransportBinding({
            transport: 'telegram',
            endpointId: '-100',
            endpointType: 'group',
            spaceId: 'telegram:office',
        });

        const resolution = resolveTransportBinding(buildMessage({ endpointId: '-100' }));

        expect(resolution.source).toBe('binding');
        expect(resolution.space?.id).toBe('telegram:office');
    });

    it('lets a re-pointed binding win over the legacy columns', async () => {
        const { db, resolveTransportBinding } = await loadModules();
        // A space still claiming the endpoint on its own row...
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.ensureSpace('telegram', 'moved', { kind: 'group_chat' });
        // ...and a binding that says it now belongs elsewhere.
        db.getDb()
            .prepare("UPDATE transport_bindings SET space_id = 'telegram:moved' WHERE endpoint_id = '-100'")
            .run();

        const resolution = resolveTransportBinding(buildMessage({ endpointId: '-100' }));

        expect(resolution.source).toBe('binding');
        expect(resolution.space?.id).toBe('telegram:moved');
    });

    it('falls back to the legacy columns when a space has no binding', async () => {
        const { db, resolveTransportBinding } = await loadModules();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.getDb().prepare('DELETE FROM transport_bindings').run();

        const resolution = resolveTransportBinding(buildMessage({ endpointId: '-100' }));

        expect(resolution.source).toBe('legacy_space');
        expect(resolution.space?.id).toBe('telegram:-100');
    });

    it('connects an unknown chat on first contact, as it always has', async () => {
        const { resolveTransportBinding, db } = await loadModules();

        const resolution = resolveTransportBinding(buildMessage({ endpointId: '-555', endpointTitle: 'New group' }));

        expect(resolution.source).toBe('bootstrapped');
        expect(resolution.space?.title).toBe('New group');
        expect(resolution.space?.kind).toBe('group_chat');
        expect(db.getTransportBinding('telegram', '-555')?.space_id).toBe(resolution.space?.id);
    });

    it('creates a direct space for a direct endpoint', async () => {
        const { resolveTransportBinding } = await loadModules();

        const resolution = resolveTransportBinding(
            buildMessage({ endpointId: '777', endpointType: 'direct', endpointTitle: null })
        );

        expect(resolution.space?.kind).toBe('direct_chat');
    });

    it('refuses to invent a space for an unknown Web room', async () => {
        const { resolveTransportBinding } = await loadModules();

        const resolution = resolveTransportBinding(buildMessage({ transport: 'web', endpointId: 'room-404' }));

        // A Web room is created by an owner in the UI, so an unknown id is a
        // mistake worth surfacing rather than a space to conjure.
        expect(resolution.source).toBe('none');
        expect(resolution.space).toBeNull();
    });

    it('keeps a thread inside its parent space instead of splitting one off', async () => {
        const { db, resolveTransportBinding } = await loadModules();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });

        const resolution = resolveTransportBinding(buildMessage({ endpointId: '-100', threadId: '42' }));

        expect(resolution.space?.id).toBe('telegram:-100');
        expect(resolution.binding?.normalized_thread_id).toBe('');
    });

    it('honours a binding created for a specific thread', async () => {
        const { db, resolveTransportBinding } = await loadModules();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.ensureSpace('telegram', 'topic', { kind: 'group_chat' });
        db.ensureTransportBinding({
            transport: 'telegram',
            endpointId: '-100',
            endpointType: 'thread',
            threadId: '42',
            spaceId: 'telegram:topic',
        });

        const resolution = resolveTransportBinding(buildMessage({ endpointId: '-100', threadId: '42' }));

        expect(resolution.space?.id).toBe('telegram:topic');
    });
});

describe('participant resolver', () => {
    it('recognizes a known account and keeps its participant', async () => {
        const { db, resolveParticipant } = await loadModules();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.upsertResident({ tg_id: '777', display_name: 'Alex', role: 'owner' });

        const resolution = resolveParticipant(buildMessage({}), 'telegram:-100');

        expect(resolution.participantId).toBe('777');
        expect(resolution.created).toBe(false);
        expect(resolution.membership.role).toBe('owner');
    });

    it('mints a person id with the legacy convention for an unseen account', async () => {
        const { db, resolveParticipant } = await loadModules();
        db.ensureSpace('discord', 'guild', { kind: 'group_chat' });

        const resolution = resolveParticipant(
            buildMessage({ transport: 'discord', senderId: '5150', displayName: 'Sam' }),
            'discord:guild'
        );

        // Existing person ids must keep their shape, so a brand new Discord
        // account still becomes "discord:<id>".
        expect(resolution.participantId).toBe('discord:5150');
        expect(resolution.created).toBe(true);
        expect(resolution.identity.transport).toBe('discord');
        expect(resolution.identity.external_user_id).toBe('5150');
        expect(db.getResident('discord:5150')?.display_name).toBe('Sam');
    });

    it('resolves a linked identity to the participant it belongs to', async () => {
        const { db, resolveParticipant } = await loadModules();
        db.ensureSpace('web', 'general', { kind: 'group_chat' });
        db.upsertResident({ tg_id: '777', display_name: 'Alex', role: 'owner' });
        // The human links their Web login to their Telegram participant.
        db.ensureParticipantIdentity({
            participantId: '777',
            transport: 'web',
            externalUserId: 'local-alex',
        });

        const resolution = resolveParticipant(
            buildMessage({ transport: 'web', senderId: 'local-alex', displayName: 'Alex on web' }),
            'web:general'
        );

        // Same person, same memory, same authority — arriving over another wire.
        expect(resolution.participantId).toBe('777');
        expect(resolution.created).toBe(false);
        expect(resolution.membership.role).toBe('owner');
    });

    it('grants owner role only to a configured owner', async () => {
        const { db, resolveParticipant } = await loadModules();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });

        const owner = resolveParticipant(buildMessage({ senderId: '777' }), 'telegram:-100');
        const stranger = resolveParticipant(buildMessage({ senderId: '999' }), 'telegram:-100');

        expect(owner.membership.role).toBe('owner');
        expect(stranger.membership.role).toBe('member');
    });

    it('does not downgrade an existing membership on a later message', async () => {
        const { db, resolveParticipant } = await loadModules();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.upsertResident({ tg_id: '999', display_name: 'Sam', role: 'member' });
        db.ensureSpaceMembership('telegram:-100', '999', 'admin');

        const resolution = resolveParticipant(buildMessage({ senderId: '999' }), 'telegram:-100');

        expect(resolution.membership.role).toBe('admin');
    });
});
