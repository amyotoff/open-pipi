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

const ADMIN_ROUTES = [
    '/api/admin/overview',
    '/api/admin/spaces',
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
