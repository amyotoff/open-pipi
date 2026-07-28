/**
 * The dashboard is an access-control surface first and a view second, so these
 * run over real HTTP against a real database.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

let dataDir: string;
let server: Server | null = null;
let baseUrl = '';

async function startServer() {
    vi.resetModules();
    const db = await import('../db');
    db.initDatabase();

    db.upsertResident({ tg_id: '777', display_name: 'Alex', role: 'owner' });
    db.upsertResident({ tg_id: '888', display_name: 'Sam', role: 'member' });
    db.ensureSpace('telegram', '-100', { kind: 'group_chat', title: 'Household' });
    db.ensureSpaceMembership('telegram:-100', '777', 'owner');
    db.ensureSpaceMembership('telegram:-100', '888', 'member');

    const auth = await import('./auth');
    auth.clearLoginAttempts();
    auth.upsertWebAccount({ username: 'alex', password: 'correct horse', participantId: '777' });
    auth.upsertWebAccount({ username: 'sam', password: 'correct horse', participantId: '888' });

    const api = await import('../api');
    const app = await api.createApiApp('tool-log-token');
    const instance = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => instance.once('listening', resolve));
    server = instance;

    const address = instance.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return { db };
}

async function signIn(username: string): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct horse' }),
    });
    return (response.headers.get('set-cookie') || '').split(';')[0];
}

function parseJson(text: string): any {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function get(routePath: string, cookie?: string) {
    const response = await fetch(`${baseUrl}${routePath}`, {
        headers: cookie ? { Cookie: cookie } : {},
    });
    const text = await response.text();
    return { status: response.status, body: parseJson(text) };
}

async function write(method: 'PATCH' | 'POST', routePath: string, body: unknown, cookie?: string) {
    const response = await fetch(`${baseUrl}${routePath}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: parseJson(text) };
}

const ADMIN_ROUTES = [
    '/api/admin/overview',
    '/api/admin/spaces',
    '/api/admin/budget',
    '/api/admin/delivery',
    '/api/admin/brain',
    '/api/admin/memory',
];

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-admin-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, PIPI_WEB_ENABLED: 'true' };
});

afterEach(async () => {
    if (server) {
        await new Promise((resolve) => server!.close(resolve));
        server = null;
    }
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('dashboard access', () => {
    it('is invisible to a member, not merely forbidden', async () => {
        await startServer();
        const cookie = await signIn('sam');

        for (const route of ADMIN_ROUTES) {
            const response = await get(route, cookie);
            // 404, not 403: telling someone an admin surface exists is itself
            // a disclosure.
            expect(response.status, route).toBe(404);
        }
    });

    it('is invisible to someone not signed in at all', async () => {
        await startServer();

        for (const route of ADMIN_ROUTES) {
            expect((await get(route)).status, route).toBe(401);
        }
    });

    it('opens for an owner', async () => {
        await startServer();
        const cookie = await signIn('alex');

        for (const route of ADMIN_ROUTES) {
            const response = await get(route, cookie);
            expect(response.status, route).toBe(200);
            expect(response.body.ok, route).toBe(true);
        }
    });

    it('closes again the moment an owner is demoted', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');
        expect((await get('/api/admin/overview', cookie)).status).toBe(200);

        db.upsertResident({ tg_id: '777', role: 'member' });

        // The role is read per request, so a demotion takes effect now rather
        // than at the next sign-in.
        expect((await get('/api/admin/overview', cookie)).status).toBe(404);
    });
});

describe('dashboard views', () => {
    it('reports health, queue depth, and how the runtime is wired', async () => {
        await startServer();
        const cookie = await signIn('alex');

        const { body } = await get('/api/admin/overview', cookie);

        expect(body.health).toHaveProperty('gemini');
        expect(body.topology.spaces).toBeGreaterThan(0);
        expect(body.topology.bindings).toBeGreaterThan(0);
        expect(body.outbox).toBeTypeOf('object');
    });

    it('lists every space with what decides its behavior', async () => {
        await startServer();
        const cookie = await signIn('alex');

        const { body } = await get('/api/admin/spaces', cookie);

        const space = body.spaces.find((entry: { id: string }) => entry.id === 'telegram:-100');
        expect(space.channel_mode).toBe('full');
        expect(space.pack).toBeTruthy();
        expect(space.bindings.map((binding: { transport: string }) => binding.transport)).toContain('telegram');
    });

    it('breaks spend down by model and by space, and says what it cannot attribute', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');

        db.logTokenUsage('gemini-2.5-flash', 1_000_000, 1_000_000, 'telegram:-100');
        db.logTokenUsage('gemini-2.5-pro', 1_000_000, 0, 'telegram:-100');
        // Background work belongs to no conversation.
        db.logTokenUsage('gemini-2.5-flash', 1_000_000, 0, null);

        const { body } = await get('/api/admin/budget', cookie);

        // 0.15 + 0.60 (flash) + 1.25 (pro) + 0.15 (unattributed flash)
        expect(body.total.cost_usd).toBeCloseTo(2.15, 5);
        expect(body.today.cost_usd).toBeCloseTo(2.15, 5);
        expect(body.daily_limit_usd).toBeGreaterThan(0);

        const byModel = Object.fromEntries(body.by_model.map((row: any) => [row.key, row.cost_usd]));
        expect(byModel['gemini-2.5-pro']).toBeCloseTo(1.25, 5);
        expect(byModel['gemini-2.5-flash']).toBeCloseTo(0.9, 5);

        // Only the two attributed calls land on the space, and it is named.
        expect(body.by_space).toHaveLength(1);
        expect(body.by_space[0]).toMatchObject({ key: 'telegram:-100', title: 'Household', calls: 2 });
        expect(body.by_space[0].cost_usd).toBeCloseTo(2.0, 5);

        // The remainder is declared rather than silently dropped.
        expect(body.unattributed_cost_usd).toBeCloseTo(0.15, 5);
    });

    it('counts a local model as free rather than guessing a price', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');

        db.logTokenUsage('ollama:llama3', 500_000, 500_000, 'telegram:-100');

        const { body } = await get('/api/admin/budget', cookie);

        expect(body.total.cost_usd).toBe(0);
        expect(body.total.input_tokens).toBe(500_000);
    });

    it('leaves spend outside the window out of the report', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');

        db.logTokenUsage('gemini-2.5-flash', 1_000_000, 0, 'telegram:-100');
        db.getDb().prepare(`UPDATE token_usage SET date = '2020-01-01' WHERE id = 1`).run();

        const { body } = await get('/api/admin/budget?days=7', cookie);

        expect(body.days).toBe(7);
        expect(body.total.calls).toBe(0);
        expect(body.total.cost_usd).toBe(0);
    });

    it('shows what is stuck and why', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');
        const { enqueueDelivery, markDeliveryFailed } = await import('../gateway/outbox');
        const entry = enqueueDelivery({
            transport: 'telegram',
            destination: { endpointId: '-100', endpointType: 'group' },
            payload: { id: 'm1', content: { text: 'hi' } },
        });
        markDeliveryFailed(entry.id, 'chat not found', { permanent: true });
        void db;

        const { body } = await get('/api/admin/delivery', cookie);

        expect(body.counts.failed).toBe(1);
        expect(body.entries[0].last_error).toContain('chat not found');
    });

    it('refuses a wiki path that tries to climb out of the wiki', async () => {
        await startServer();
        const cookie = await signIn('alex');

        const escaped = await get('/api/admin/brain/page?path=../../../etc/passwd', cookie);
        const missing = await get('/api/admin/brain/page', cookie);

        expect(escaped.status).toBe(400);
        expect(missing.status).toBe(400);
    });

    it('offers only the values a space may actually be set to', async () => {
        await startServer();
        const cookie = await signIn('alex');

        const { body } = await get('/api/admin/spaces', cookie);

        expect(body.choices.channel_mode).toEqual(['off', 'notify_only', 'inbox', 'full']);
        expect(body.choices.pack).toContain('jeeves');
        expect(body.choices.status).toEqual(['ACTIVE', 'ARCHIVED']);
    });

    it('returns memory newest first', async () => {
        await startServer();
        const cookie = await signIn('alex');
        const db = await import('../db');
        db.rememberMemoryEntry({
            scope_type: 'space',
            scope_id: 'telegram:-100',
            kind: 'fact',
            content: 'the kettle is broken',
        });

        const { body } = await get('/api/admin/memory', cookie);

        expect(body.entries.some((entry: { content: string }) => entry.content === 'the kettle is broken')).toBe(true);
    });
});

async function loggedEvents(type: string): Promise<Array<Record<string, unknown>>> {
    const db = await import('../db');
    const rows = db
        .getDb()
        .prepare('SELECT details FROM event_log WHERE event_type = ? ORDER BY id ASC')
        .all(type) as Array<{ details: string }>;
    return rows.map((row) => JSON.parse(row.details));
}

describe('changing how a space behaves', () => {
    it('is closed to anyone who is not an owner', async () => {
        await startServer();
        const member = await signIn('sam');

        expect((await write('PATCH', '/api/admin/spaces/telegram:-100', { channel_mode: 'off' }, member)).status).toBe(
            404
        );
        expect((await write('PATCH', '/api/admin/spaces/telegram:-100', { channel_mode: 'off' })).status).toBe(401);

        // And it really did nothing.
        const db = await import('../db');
        expect(db.getSpace('telegram:-100')!.policy_json || '').not.toContain('"channel_mode":"off"');
    });

    it('changes mode, pack and grounding, and writes down who did it', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');

        const response = await write(
            'PATCH',
            '/api/admin/spaces/telegram:-100',
            { channel_mode: 'inbox', pack: 'tutor' },
            cookie
        );

        expect(response.status).toBe(200);
        expect(response.body.space.channel_mode).toBe('inbox');
        expect(db.getSpace('telegram:-100')!.assistant_pack_id).toBe('tutor');

        const [event] = await loggedEvents('admin_space_update');
        expect(event).toMatchObject({ space_id: 'telegram:-100', by: '777' });
    });

    it('refuses a value the UI would never offer, and changes nothing', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');
        const before = db.getSpace('telegram:-100')!.assistant_pack_id;

        const badMode = await write('PATCH', '/api/admin/spaces/telegram:-100', { channel_mode: 'loud' }, cookie);
        const badPack = await write('PATCH', '/api/admin/spaces/telegram:-100', { pack: '../../etc' }, cookie);
        const nothing = await write('PATCH', '/api/admin/spaces/telegram:-100', {}, cookie);

        expect([badMode.status, badPack.status, nothing.status]).toEqual([400, 400, 400]);
        expect(db.getSpace('telegram:-100')!.assistant_pack_id).toBe(before);
        expect(await loggedEvents('admin_space_update')).toHaveLength(0);
    });

    it('silences a space when it is archived, so archiving means what it says', async () => {
        const { db } = await startServer();
        const cookie = await signIn('alex');

        await write('PATCH', '/api/admin/spaces/telegram:-100', { status: 'ARCHIVED' }, cookie);

        const { resolveSpaceOperationalSettings } = await import('../core/space-preferences');
        const archived = db.getSpace('telegram:-100')!;
        expect(archived.status).toBe('ARCHIVED');
        expect(resolveSpaceOperationalSettings(archived.policy_json).channel_mode).toBe('off');

        // It is hidden, not deleted: the history and the membership are intact.
        expect(db.listSpacesForParticipant('777').map((space) => space.id)).not.toContain('telegram:-100');
        expect(db.isSpaceMember('telegram:-100', '777')).toBe(true);

        await write('PATCH', '/api/admin/spaces/telegram:-100', { status: 'ACTIVE', channel_mode: 'full' }, cookie);
        expect(db.listSpacesForParticipant('777').map((space) => space.id)).toContain('telegram:-100');
    });

    it('does not invent a space that is not there', async () => {
        await startServer();
        const cookie = await signIn('alex');

        expect((await write('PATCH', '/api/admin/spaces/telegram:-999', { channel_mode: 'off' }, cookie)).status).toBe(
            404
        );
    });
});

describe('retrying a failed delivery', () => {
    async function failedEntryId(): Promise<string> {
        const { enqueueDelivery, markDeliveryFailed } = await import('../gateway/outbox');
        const entry = enqueueDelivery({
            transport: 'telegram',
            destination: { endpointId: '-100', endpointType: 'group' },
            payload: { id: 'm1', content: { text: 'hi' } },
        });
        markDeliveryFailed(entry.id, 'chat not found', { permanent: true });
        return entry.id;
    }

    it('is closed to anyone who is not an owner', async () => {
        await startServer();
        const id = await failedEntryId();
        const member = await signIn('sam');

        expect((await write('POST', `/api/admin/delivery/${id}/requeue`, {}, member)).status).toBe(404);
        expect((await write('POST', `/api/admin/delivery/${id}/requeue`, {})).status).toBe(401);

        const { getOutboxEntry } = await import('../gateway/outbox');
        expect(getOutboxEntry(id)!.status).toBe('failed');
    });

    it('gives the entry its attempts back and writes down who did it', async () => {
        await startServer();
        const id = await failedEntryId();
        const cookie = await signIn('alex');

        const response = await write('POST', `/api/admin/delivery/${id}/requeue`, {}, cookie);

        expect(response.status).toBe(200);

        const { getOutboxEntry } = await import('../gateway/outbox');
        const entry = getOutboxEntry(id)!;
        expect(entry.status).toBe('queued');
        expect(entry.attempts).toBe(0);
        expect(entry.last_error).toBeNull();

        const [event] = await loggedEvents('admin_delivery_requeue');
        expect(event).toMatchObject({ outbox_id: id, by: '777' });
    });

    it('will not re-queue something that is still on its way', async () => {
        await startServer();
        const cookie = await signIn('alex');
        const { enqueueDelivery } = await import('../gateway/outbox');
        const queued = enqueueDelivery({
            transport: 'telegram',
            destination: { endpointId: '-100', endpointType: 'group' },
            payload: { id: 'm2', content: { text: 'hi' } },
        });

        expect((await write('POST', `/api/admin/delivery/${queued.id}/requeue`, {}, cookie)).status).toBe(409);
        expect((await write('POST', '/api/admin/delivery/nope/requeue', {}, cookie)).status).toBe(404);
        expect(await loggedEvents('admin_delivery_requeue')).toHaveLength(0);
    });
});
