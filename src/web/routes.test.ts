/**
 * The web API over a real listener, a real database, and real cookies.
 *
 * These are access-control tests before they are anything else, so they use
 * actual HTTP rather than calling handlers directly: the parts most likely to
 * go wrong — middleware order, cookie attributes, status codes — only exist at
 * that level.
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
    db.ensureSpace('telegram', '-200', { kind: 'group_chat', title: 'Private club' });
    db.ensureSpaceMembership('telegram:-100', '777', 'owner');
    db.ensureSpaceMembership('telegram:-200', '888', 'owner');
    db.storeMessage({
        id: 'telegram:-100:1',
        space_id: 'telegram:-100',
        channel: 'telegram',
        channel_ref: '-100',
        sender_id: '777',
        content: 'hello from telegram',
        timestamp: new Date().toISOString(),
        is_bot: 0,
    });

    const auth = await import('./auth');
    auth.clearLoginAttempts();
    auth.upsertWebAccount({ username: 'alex', password: 'correct horse', participantId: '777' });

    const api = await import('../api');
    const app = await api.createApiApp('tool-log-token');
    const instance = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => instance.once('listening', resolve));
    server = instance;

    const address = instance.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    return { db, auth };
}

/** Error pages come back as HTML, so the raw text is the useful fallback. */
function parseJsonOrText(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function call(
    method: string,
    routePath: string,
    options: { body?: unknown; cookie?: string; contentType?: string } = {}
) {
    const response = await fetch(`${baseUrl}${routePath}`, {
        method,
        headers: {
            ...(options.body !== undefined ? { 'Content-Type': options.contentType ?? 'application/json' } : {}),
            ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    const body: unknown = parseJsonOrText(text);

    return { status: response.status, body: body as any, setCookie: response.headers.get('set-cookie') };
}

function cookieFrom(setCookie: string | null): string {
    return (setCookie || '').split(';')[0];
}

async function signIn(): Promise<string> {
    const response = await call('POST', '/api/auth/login', {
        body: { username: 'alex', password: 'correct horse' },
    });
    return cookieFrom(response.setCookie);
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-webroutes-'));
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

describe('web auth routes', () => {
    it('lets a browser sign in without a bearer token', async () => {
        await startServer();

        const response = await call('POST', '/api/auth/login', {
            body: { username: 'alex', password: 'correct horse' },
        });

        // The bearer guard used to cover the whole /api prefix, which would
        // make signing in from a browser impossible.
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
    });

    it('still guards the tool-log API with its bearer token', async () => {
        await startServer();

        const withoutToken = await call('GET', '/api/tool-logs');
        const withSession = await call('GET', '/api/tool-logs', { cookie: await signIn() });

        // Re-scoping the middleware must not have opened this up: a web session
        // is not authorization for the operator API.
        expect(withoutToken.status).toBe(401);
        expect(withSession.status).toBe(401);
    });

    it('issues an httpOnly, same-site session cookie', async () => {
        await startServer();

        const response = await call('POST', '/api/auth/login', {
            body: { username: 'alex', password: 'correct horse' },
        });

        expect(response.setCookie).toContain('HttpOnly');
        expect(response.setCookie).toContain('SameSite=Lax');
        expect(response.setCookie).toContain('Path=/');
    });

    it('rejects a wrong password without saying which part was wrong', async () => {
        await startServer();

        const wrongPassword = await call('POST', '/api/auth/login', {
            body: { username: 'alex', password: 'nope' },
        });
        const unknownUser = await call('POST', '/api/auth/login', {
            body: { username: 'ghost', password: 'nope' },
        });

        expect(wrongPassword.status).toBe(401);
        expect(unknownUser.status).toBe(401);
        expect(wrongPassword.body.error).toBe(unknownUser.body.error);
    });

    it('refuses a state-changing request that is not JSON', async () => {
        await startServer();

        const response = await call('POST', '/api/auth/login', {
            body: { username: 'alex', password: 'correct horse' },
            contentType: 'application/x-www-form-urlencoded',
        });

        // A cross-site form post cannot set a JSON content type, so requiring
        // one closes the gap SameSite alone leaves.
        expect(response.status).toBe(415);
    });

    it('answers /api/me only for a signed-in session', async () => {
        await startServer();

        const anonymous = await call('GET', '/api/me');
        const signedIn = await call('GET', '/api/me', { cookie: await signIn() });

        expect(anonymous.status).toBe(401);
        expect(signedIn.status).toBe(200);
        expect(signedIn.body.participant.id).toBe('777');
    });

    it('ends the session on logout', async () => {
        await startServer();
        const cookie = await signIn();

        await call('POST', '/api/auth/logout', { cookie });

        expect((await call('GET', '/api/me', { cookie })).status).toBe(401);
    });
});

describe('web space routes', () => {
    it('lists only the spaces the signed-in participant belongs to', async () => {
        await startServer();
        const cookie = await signIn();

        const response = await call('GET', '/api/spaces', { cookie });

        expect(response.status).toBe(200);
        expect(response.body.spaces.map((space: { id: string }) => space.id)).toEqual(['telegram:-100']);
    });

    it('returns the history of a space the participant is in', async () => {
        await startServer();
        const cookie = await signIn();

        const response = await call('GET', '/api/spaces/telegram:-100/messages', { cookie });

        expect(response.status).toBe(200);
        expect(response.body.messages.map((message: { content: string }) => message.content)).toContain(
            'hello from telegram'
        );
    });

    it('hides a space the participant is not a member of', async () => {
        await startServer();
        const cookie = await signIn();

        const response = await call('GET', '/api/spaces/telegram:-200/messages', { cookie });

        // 404 rather than 403: telling a stranger the space exists is itself a
        // disclosure.
        expect(response.status).toBe(404);
    });

    it('answers a made-up space id the same way as a forbidden one', async () => {
        await startServer();
        const cookie = await signIn();

        const forbidden = await call('GET', '/api/spaces/telegram:-200/messages', { cookie });
        const nonexistent = await call('GET', '/api/spaces/telegram:-999/messages', { cookie });

        expect(nonexistent.status).toBe(forbidden.status);
        expect(nonexistent.body).toEqual(forbidden.body);
    });

    it('requires a session for space routes', async () => {
        await startServer();

        expect((await call('GET', '/api/spaces')).status).toBe(401);
        expect((await call('GET', '/api/spaces/telegram:-100/messages')).status).toBe(401);
    });

    it('serves the client shell', async () => {
        await startServer();

        const response = await fetch(`${baseUrl}/`);
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(html).toContain('Open PiPi');
    });
});
