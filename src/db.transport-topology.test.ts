/**
 * Migration safety for the transport topology.
 *
 * These tests run against real SQLite and the real migration path, because the
 * risk being managed is "a live database opens and something is silently
 * wrong" — a hand-written mock schema cannot demonstrate that.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

let dataDir: string;

async function loadDbModule() {
    vi.resetModules();
    return await import('./db');
}

/** Open, migrate, close — the shape of a real restart. */
async function withFreshDbModule<T>(run: (dbModule: typeof import('./db')) => T): Promise<T> {
    const dbModule = await loadDbModule();
    dbModule.initDatabase();
    try {
        return run(dbModule);
    } finally {
        dbModule.closeDatabase();
    }
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-topology-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir };
});

afterEach(async () => {
    try {
        const dbModule = await import('./db');
        dbModule.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('transport topology migration', () => {
    it('creates the new tables and columns on an empty database', async () => {
        await withFreshDbModule((dbModule) => {
            const db = dbModule.getDb();
            const tables = new Set(
                (
                    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
                ).map((row) => row.name)
            );

            expect(tables.has('transport_bindings')).toBe(true);
            expect(tables.has('participant_identities')).toBe(true);
            expect(tables.has('outbox')).toBe(true);

            const messageColumns = new Set(
                (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((row) => row.name)
            );
            expect(messageColumns.has('transport')).toBe(true);
            expect(messageColumns.has('transport_message_id')).toBe(true);

            const spaceColumns = new Set(
                (db.prepare('PRAGMA table_info(spaces)').all() as Array<{ name: string }>).map((row) => row.name)
            );
            expect(spaceColumns.has('slug')).toBe(true);
        });
    });

    it('gives every legacy space a binding without touching the space row', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('telegram', '-1001234', { kind: 'group_chat', title: 'Household' });
            dbModule.ensureSpace('telegram', '55555', { kind: 'direct_chat', title: 'Alex' });
            dbModule.ensureSpace('discord', '99887766', { kind: 'group_chat', title: 'Guild' });
        });

        // Second open replays the migration, exactly like a restart after upgrade.
        await withFreshDbModule((dbModule) => {
            const group = dbModule.getTransportBinding('telegram', '-1001234');
            const direct = dbModule.getTransportBinding('telegram', '55555');
            const discord = dbModule.getTransportBinding('discord', '99887766');

            expect(group?.space_id).toBe('telegram:-1001234');
            expect(group?.endpoint_type).toBe('group');
            expect(group?.status).toBe('active');
            expect(group?.normalized_thread_id).toBe('');

            expect(direct?.endpoint_type).toBe('direct');
            expect(discord?.space_id).toBe('discord:99887766');

            // The legacy columns are untouched: routing may still fall back to them.
            const space = dbModule.getSpace('telegram:-1001234');
            expect(space?.channel).toBe('telegram');
            expect(space?.external_ref).toBe('-1001234');
        });
    });

    it('is idempotent across repeated migrations', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('telegram', '-1001234', { kind: 'group_chat' });
            dbModule.upsertResident({ tg_id: '777', username: 'alex', display_name: 'Alex' });
        });

        for (let restart = 0; restart < 3; restart += 1) {
            await withFreshDbModule(() => {});
        }

        await withFreshDbModule((dbModule) => {
            const report = dbModule.getTransportTopologyReport();

            expect(report.bindings).toBe(1);
            expect(report.identities).toBe(1);
            expect(report.spaces_without_binding).toEqual([]);
            expect(report.participants_without_identity).toEqual([]);
        });
    });

    it('splits legacy person ids into transport and external id without merging people', async () => {
        await withFreshDbModule((dbModule) => {
            // Telegram person ids are bare; every other channel is prefixed.
            dbModule.upsertResident({ tg_id: '777', username: 'alex', display_name: 'Alex' });
            dbModule.upsertResident({ tg_id: 'discord:12345', username: 'alex_d', display_name: 'Alex D' });
            dbModule.upsertResident({ tg_id: 'gmail:alex@example.com', display_name: 'Alex Mail' });
        });

        await withFreshDbModule((dbModule) => {
            const telegram = dbModule.getParticipantIdentity('telegram', '777');
            const discord = dbModule.getParticipantIdentity('discord', '12345');
            const gmail = dbModule.getParticipantIdentity('gmail', 'alex@example.com');

            expect(telegram?.participant_id).toBe('777');
            expect(telegram?.username).toBe('alex');
            expect(discord?.participant_id).toBe('discord:12345');
            expect(gmail?.participant_id).toBe('gmail:alex@example.com');

            // Three residents stay three participants. Same human, but only a
            // person can say so — the migration never guesses.
            expect(dbModule.listParticipantIdentities('777')).toHaveLength(1);
            expect(dbModule.getTransportTopologyReport().identities).toBe(3);
        });
    });

    it('preserves packs, groundings, memberships, and history through the migration', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('telegram', '-1001234', {
                kind: 'group_chat',
                assistant_pack_id: 'office',
                grounding_pack_id: 'jeeves_personal',
            });
            dbModule.upsertResident({ tg_id: '777', display_name: 'Alex', role: 'owner' });
            dbModule.ensureSpaceMembership('telegram:-1001234', '777', 'owner');
            dbModule.storeMessage({
                id: 'telegram:-1001234:1',
                space_id: 'telegram:-1001234',
                channel_ref: '-1001234',
                sender_id: '777',
                content: 'hello from before the upgrade',
                timestamp: new Date().toISOString(),
                is_bot: 0,
            });
        });

        await withFreshDbModule((dbModule) => {
            const space = dbModule.getSpace('telegram:-1001234');
            expect(space?.assistant_pack_id).toBe('office');
            expect(space?.grounding_pack_id).toBe('jeeves_personal');

            expect(dbModule.getMembership('telegram:-1001234', '777')?.role).toBe('owner');

            const history = dbModule.getRecentMessagesForSpace('telegram:-1001234', 10);
            expect(history.map((message) => message.content)).toContain('hello from before the upgrade');
        });
    });

    it('reports a space that has no binding instead of routing it silently', async () => {
        await withFreshDbModule((dbModule) => {
            const db = dbModule.getDb();
            // A space with no usable endpoint. The backfill skips it rather
            // than inventing a binding that could never receive anything.
            db.prepare(
                `INSERT INTO spaces (id, kind, title, channel, external_ref, status, created_at, updated_at)
                 VALUES ('orphan', 'direct_chat', 'Orphan', 'telegram', '', 'ACTIVE', datetime('now'), datetime('now'))`
            ).run();
        });

        await withFreshDbModule((dbModule) => {
            const report = dbModule.getTransportTopologyReport();
            expect(report.spaces_without_binding).toContain('orphan');
        });
    });
});

describe('upgrading a pre-transport database', () => {
    /**
     * Build a database with the schema as it shipped before this work: no
     * binding or identity tables, no transport columns, and rows that only
     * carry the old string conventions. This stands in for a real operator's
     * file, and unlike a manual rehearsal it runs on every CI job.
     */
    function writeLegacyDatabase(): void {
        const legacy = new Database(path.join(dataDir, 'open-pipi.db'));
        legacy.exec(`
            CREATE TABLE residents (
                tg_id TEXT PRIMARY KEY,
                username TEXT,
                display_name TEXT,
                nickname TEXT,
                role TEXT DEFAULT 'resident',
                last_seen TEXT,
                joined_at TEXT,
                habits TEXT DEFAULT ''
            );
            CREATE TABLE chats (jid TEXT PRIMARY KEY, type TEXT, status TEXT DEFAULT 'ACTIVE');
            CREATE TABLE spaces (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT,
                channel TEXT NOT NULL,
                external_ref TEXT NOT NULL,
                status TEXT DEFAULT 'ACTIVE',
                assistant_pack_id TEXT DEFAULT 'jeeves',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE memberships (
                space_id TEXT NOT NULL,
                person_id TEXT NOT NULL,
                role TEXT NOT NULL,
                base_authority INTEGER NOT NULL DEFAULT 100,
                reputation_delta INTEGER NOT NULL DEFAULT 0,
                trust_flags_json TEXT NOT NULL DEFAULT '{}',
                authority_note TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (space_id, person_id)
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                chat_jid TEXT,
                sender_tg_id TEXT,
                content TEXT,
                timestamp TEXT,
                is_bot INTEGER DEFAULT 0
            );

            INSERT INTO residents (tg_id, username, display_name, role, joined_at)
            VALUES ('777', 'alex', 'Alex', 'owner', '2025-01-01T00:00:00.000Z'),
                   ('discord:5150', 'alex_d', 'Alex D', 'member', '2025-01-02T00:00:00.000Z');

            INSERT INTO chats (jid, type, status) VALUES ('-1001234', 'household_group', 'ACTIVE');

            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, created_at, updated_at)
            VALUES ('telegram:-1001234', 'group_chat', 'Household', 'telegram', '-1001234', 'ACTIVE', 'office',
                    '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

            INSERT INTO memberships (space_id, person_id, role, created_at, updated_at)
            VALUES ('telegram:-1001234', '777', 'owner', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

            -- Legacy rows predate the space_id column entirely. The timestamp is
            -- recent because history readers apply a retention window, and this
            -- test is about the migration rather than that window.
            INSERT INTO messages (id, chat_jid, sender_tg_id, content, timestamp, is_bot)
            VALUES ('telegram:-1001234:1', '-1001234', '777', 'legacy history', '${new Date().toISOString()}', 0);
        `);
        legacy.close();
    }

    it('migrates an operator database without losing anything or needing a reconnect', async () => {
        writeLegacyDatabase();

        await withFreshDbModule((dbModule) => {
            // Behavior the operator must not have to redo.
            const space = dbModule.getSpace('telegram:-1001234');
            expect(space?.assistant_pack_id).toBe('office');
            expect(space?.grounding_pack_id).toBe('jeeves_personal');
            expect(dbModule.getMembership('telegram:-1001234', '777')?.role).toBe('owner');

            // Routing is now expressible without reading spaces.channel.
            const binding = dbModule.getTransportBinding('telegram', '-1001234');
            expect(binding?.space_id).toBe('telegram:-1001234');
            expect(binding?.endpoint_type).toBe('group');

            // Both person id conventions became identities, still two people.
            expect(dbModule.getParticipantIdentity('telegram', '777')?.participant_id).toBe('777');
            expect(dbModule.getParticipantIdentity('discord', '5150')?.participant_id).toBe('discord:5150');

            // History predating the space_id column is claimed by its space,
            // which is what lets the COALESCE fallback in the readers retire.
            const migrated = dbModule
                .getDb()
                .prepare('SELECT space_id FROM messages WHERE id = ?')
                .get('telegram:-1001234:1') as { space_id: string };
            expect(migrated.space_id).toBe('telegram:-1001234');

            const history = dbModule.getRecentMessagesForSpace('telegram:-1001234', 10);
            expect(history.map((message) => message.content)).toContain('legacy history');

            const report = dbModule.getTransportTopologyReport();
            expect(report.spaces_without_binding).toEqual([]);
            expect(report.participants_without_identity).toEqual([]);
        });
    });

    it('survives the upgrade being applied twice', async () => {
        writeLegacyDatabase();

        await withFreshDbModule(() => {});
        await withFreshDbModule((dbModule) => {
            const report = dbModule.getTransportTopologyReport();
            expect(report.bindings).toBe(1);
            expect(report.identities).toBe(2);
            expect(dbModule.getDb().pragma('integrity_check(1)', { simple: true })).toBe('ok');
        });
    });
});

describe('transport bindings and identities', () => {
    it('binds an endpoint to a space and refuses to steal it afterwards', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('web', 'general', { kind: 'group_chat' });
            dbModule.ensureSpace('web', 'other', { kind: 'group_chat' });

            const first = dbModule.ensureTransportBinding({
                transport: 'web',
                endpointId: 'room-1',
                endpointType: 'group',
                spaceId: 'web:general',
            });
            const second = dbModule.ensureTransportBinding({
                transport: 'web',
                endpointId: 'room-1',
                endpointType: 'group',
                spaceId: 'web:other',
            });

            expect(first.space_id).toBe('web:general');
            expect(second.id).toBe(first.id);
            expect(second.space_id).toBe('web:general');
        });
    });

    it('separates bindings by thread while keeping the threadless one addressable', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('telegram', '-100999', { kind: 'group_chat' });

            const root = dbModule.ensureTransportBinding({
                transport: 'telegram',
                endpointId: '-100999',
                endpointType: 'group',
                spaceId: 'telegram:-100999',
            });
            const thread = dbModule.ensureTransportBinding({
                transport: 'telegram',
                endpointId: '-100999',
                endpointType: 'thread',
                threadId: '42',
                spaceId: 'telegram:-100999',
            });

            expect(thread.id).not.toBe(root.id);
            expect(root.normalized_thread_id).toBe('');
            expect(thread.normalized_thread_id).toBe('42');
            expect(dbModule.listTransportBindingsForSpace('telegram:-100999')).toHaveLength(2);
        });
    });

    it('links several transports to one participant', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.upsertResident({ tg_id: '777', display_name: 'Alex' });

            dbModule.ensureParticipantIdentity({
                participantId: '777',
                transport: 'web',
                externalUserId: 'local-alex',
                displayName: 'Alex on web',
            });

            const identities = dbModule.listParticipantIdentities('777');
            expect(identities.map((identity) => identity.transport).sort()).toEqual(['telegram', 'web']);
        });
    });

    it('does not write when re-resolving an unchanged identity', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.upsertResident({ tg_id: '777', username: 'alex', display_name: 'Alex' });
            const before = dbModule.getParticipantIdentity('telegram', '777')!;

            // Jump the clock a minute, so a write cannot land on the same
            // timestamp by accident: comparing real timestamps would let this
            // pass spuriously whenever both calls fall in one millisecond.
            vi.useFakeTimers();
            vi.setSystemTime(new Date(Date.parse(before.updated_at) + 60_000));
            try {
                // Every command resolves its sender through upsertResident, so
                // a write here would mean disk traffic on each one.
                dbModule.upsertResident({ tg_id: '777', username: 'alex', display_name: 'Alex' });
                dbModule.upsertResident({ tg_id: '777', role: 'owner' });
            } finally {
                vi.useRealTimers();
            }

            expect(dbModule.getParticipantIdentity('telegram', '777')!.updated_at).toBe(before.updated_at);
        });
    });

    it('records a changed display name on the identity', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.upsertResident({ tg_id: '777', username: 'alex', display_name: 'Alex' });
            dbModule.upsertResident({ tg_id: '777', username: 'alex', display_name: 'Alexander' });

            expect(dbModule.getParticipantIdentity('telegram', '777')?.display_name).toBe('Alexander');
        });
    });

    it('binds a space created at runtime without waiting for a restart', async () => {
        await withFreshDbModule((dbModule) => {
            // The startup backfill has already run by now, so if ensureSpace did
            // not bind, this space would route through the legacy columns until
            // the next boot.
            dbModule.ensureSpace('telegram', '-2002', { kind: 'group_chat', title: 'Fresh' });

            const binding = dbModule.getTransportBinding('telegram', '-2002');
            expect(binding?.space_id).toBe('telegram:-2002');
            expect(binding?.endpoint_type).toBe('group');
            expect(dbModule.getTransportTopologyReport().spaces_without_binding).toEqual([]);
        });
    });

    it('gives a backfilled binding the same id the runtime would have chosen', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('telegram', '-1001234', { kind: 'group_chat' });
        });

        await withFreshDbModule((dbModule) => {
            const backfilled = dbModule.getTransportBinding('telegram', '-1001234')!;
            const viaRuntime = dbModule.ensureTransportBinding({
                transport: 'telegram',
                endpointId: '-1001234',
                endpointType: 'group',
                spaceId: 'telegram:-1001234',
            });

            expect(viaRuntime.id).toBe(backfilled.id);
            expect(dbModule.getTransportTopologyReport().bindings).toBe(1);
        });
    });

    it('never reassigns an external account already claimed by another participant', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.upsertResident({ tg_id: '777', display_name: 'Alex' });
            dbModule.upsertResident({ tg_id: '888', display_name: 'Sam' });

            dbModule.ensureParticipantIdentity({
                participantId: '777',
                transport: 'web',
                externalUserId: 'local-alex',
            });
            const attempted = dbModule.ensureParticipantIdentity({
                participantId: '888',
                transport: 'web',
                externalUserId: 'local-alex',
            });

            expect(attempted.participant_id).toBe('777');
            expect(dbModule.listParticipantIdentities('888')).toHaveLength(1);
        });
    });
});

describe('storeMessage deduplication', () => {
    it('reports whether the message was new, so a replay can be dropped', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('telegram', '-1001234', { kind: 'group_chat' });

            const message = {
                id: 'telegram:-1001234:99',
                space_id: 'telegram:-1001234',
                channel_ref: '-1001234',
                sender_id: '777',
                content: 'only once',
                timestamp: new Date().toISOString(),
                is_bot: 0,
            };

            expect(dbModule.storeMessage(message).inserted).toBe(true);
            expect(dbModule.storeMessage(message).inserted).toBe(false);

            const stored = dbModule.getRecentMessagesForSpace('telegram:-1001234', 10);
            expect(stored.filter((row) => row.content === 'only once')).toHaveLength(1);
        });
    });

    it('records the transport alongside the message', async () => {
        await withFreshDbModule((dbModule) => {
            dbModule.ensureSpace('discord', '4242', { kind: 'group_chat' });
            dbModule.storeMessage({
                id: 'discord:4242:7',
                space_id: 'discord:4242',
                channel: 'discord',
                channel_ref: '4242',
                sender_id: 'discord:1',
                content: 'from discord',
                timestamp: new Date().toISOString(),
                is_bot: 0,
                transport_message_id: '7',
            });

            const row = dbModule
                .getDb()
                .prepare('SELECT transport, transport_message_id FROM messages WHERE id = ?')
                .get('discord:4242:7') as { transport: string; transport_message_id: string };

            expect(row.transport).toBe('discord');
            expect(row.transport_message_id).toBe('7');
        });
    });
});
