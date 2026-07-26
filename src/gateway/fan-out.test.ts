/**
 * Replying to a space rather than to the endpoint a question arrived on.
 *
 * This is the property that makes one conversation readable from two places:
 * without it, a question asked on the web is answered only on the web, and the
 * Telegram side of the same space goes silent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

let dataDir: string;

async function load() {
    vi.resetModules();
    const db = await import('../db');
    db.initDatabase();
    const runtime = await import('../channels/runtime');
    return { db, runtime };
}

function queued(db: typeof import('../db')) {
    return db
        .getDb()
        .prepare('SELECT transport, endpoint_id, idempotency_key, payload_json FROM outbox ORDER BY rowid')
        .all() as Array<{ transport: string; endpoint_id: string; idempotency_key: string; payload_json: string }>;
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-fanout-'));
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

describe('space fan-out', () => {
    it('queues one delivery per active binding', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.ensureTransportBinding({
            transport: 'web',
            endpointId: 'telegram:-100',
            endpointType: 'group',
            spaceId: 'telegram:-100',
        });

        await runtime.sendSpaceMessage('telegram:-100', 'the answer');

        const rows = queued(db);
        expect(rows.map((row) => row.transport).sort()).toEqual(['telegram', 'web']);
        expect(rows.every((row) => JSON.parse(row.payload_json).content.text === 'the answer')).toBe(true);
    });

    it('keeps a single-binding space behaving exactly as before', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });

        await runtime.sendSpaceMessage('telegram:-100', 'the answer');

        const rows = queued(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ transport: 'telegram', endpoint_id: '-100' });
    });

    it('gives each binding its own idempotency key', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.ensureTransportBinding({
            transport: 'web',
            endpointId: 'telegram:-100',
            endpointType: 'group',
            spaceId: 'telegram:-100',
        });

        await runtime.sendSpaceMessage('telegram:-100', 'alert', { idempotencyKey: 'task:42' });
        // The same logical send repeated — a scheduler running twice.
        await runtime.sendSpaceMessage('telegram:-100', 'alert', { idempotencyKey: 'task:42' });

        const rows = queued(db);
        // Two bindings, one copy each: a failure on one retries without
        // touching the other, and a re-run adds nothing.
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(2);
    });

    it('still delivers through the legacy columns when a space has no binding', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.getDb().prepare('DELETE FROM transport_bindings').run();

        await runtime.sendSpaceMessage('telegram:-100', 'the answer');

        const rows = queued(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].endpoint_id).toBe('-100');
    });

    it('sends nothing at all for a space in quiet mode', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.updateSpacePolicy('telegram:-100', { channel_mode: 'off' });

        const result = await runtime.sendSpaceMessage('telegram:-100', 'the answer');

        expect(result.messageId).toBe('suppressed:telegram:-100');
        expect(queued(db)).toHaveLength(0);
    });

    it('fans a file out the same way as a message', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.ensureTransportBinding({
            transport: 'web',
            endpointId: 'telegram:-100',
            endpointType: 'group',
            spaceId: 'telegram:-100',
        });

        await runtime.sendSpaceFile('telegram:-100', '/tmp/brief.html', { filename: 'brief.html' });

        const rows = queued(db);
        expect(rows).toHaveLength(2);
        expect(JSON.parse(rows[0].payload_json).content.attachments[0].localPath).toBe('/tmp/brief.html');
    });

    it('records the endpoint type of each binding rather than guessing', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });

        await runtime.sendSpaceMessage('telegram:-100', 'the answer');

        const row = db.getDb().prepare('SELECT endpoint_type FROM outbox').get() as { endpoint_type: string };
        expect(row.endpoint_type).toBe('group');
    });
});

describe('turn tracing', () => {
    it('carries the inbound correlation id onto every queued delivery', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });
        db.ensureTransportBinding({
            transport: 'web',
            endpointId: 'telegram:-100',
            endpointType: 'group',
            spaceId: 'telegram:-100',
        });

        await runtime.sendSpaceMessage('telegram:-100', 'the answer', { correlationId: 'turn-42' });

        // One turn, followable from "someone said this" to "the answer went
        // out", on whichever surface it went out.
        const rows = db.getDb().prepare('SELECT correlation_id FROM outbox').all() as Array<{
            correlation_id: string;
        }>;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.correlation_id === 'turn-42')).toBe(true);
    });

    it('leaves the correlation id empty for a send that answers nothing', async () => {
        const { db, runtime } = await load();
        db.ensureSpace('telegram', '-100', { kind: 'group_chat' });

        await runtime.sendSpaceMessage('telegram:-100', 'a scheduled nudge');

        const row = db.getDb().prepare('SELECT correlation_id FROM outbox').get() as { correlation_id: string | null };
        expect(row.correlation_id).toBeNull();
    });
});
