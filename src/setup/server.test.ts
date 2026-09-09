import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupSafeStatus, SetupService } from './service';
import { SetupServer, startSetupServer } from './server';

function status(): SetupSafeStatus {
    return {
        phase: 'ai',
        metadata: { profilePresent: false },
        provider: {
            status: 'missing',
            kind: 'openrouter',
            model: 'test/model',
            configured: false,
            validated: false,
        },
        telegram: { status: 'missing', configured: false, validated: false, webhookConflict: false },
        owners: { existing: false, count: 0, status: 'missing' },
        pairing: { active: false },
        profile: { initialPack: 'jeeves', currentPack: 'jeeves' },
        runtime: {
            state: 'stopped',
            dataDir: '/safe/data',
            background: false,
            message: 'Stopped.',
            dialogueVerified: false,
        },
        background: { supported: true, platform: 'darwin', explanation: 'Available.' },
        completed: false,
    };
}

function fakeService(overrides: Partial<SetupService> = {}): SetupService {
    const current = status();
    return {
        status: vi.fn(async () => current),
        setMetadata: vi.fn(async () => current),
        beginOpenRouterOAuth: vi.fn(async () => ({ authorizationUrl: 'https://openrouter.ai/auth?safe=1' })),
        completeOpenRouterOAuth: vi.fn(async () => current),
        setManualOpenRouterKey: vi.fn(async () => current),
        setTelegramToken: vi.fn(async () => current),
        beginOwnerPairing: vi.fn(async () => current),
        confirmOwner: vi.fn(async () => current),
        cancelOwnerPairing: vi.fn(async () => current),
        validateConnections: vi.fn(async () => current),
        startRuntime: vi.fn(async () => current),
        stopRuntime: vi.fn(async () => current),
        dispose: vi.fn(async () => undefined),
        ...overrides,
    };
}

async function authenticated(server: SetupServer): Promise<{ cookie: string; csrf: string }> {
    // The test renderer is installed by each caller and captures csrf. Bootstrap
    // only returns the cookie; loading / causes the renderer to receive the token.
    const response = await fetch(server.url, { redirect: 'manual' });
    const cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
    expect(response.status).toBe(303);
    expect(cookie).toContain('pipi_setup_session=');
    const page = await fetch(`${server.origin}/`, { headers: { cookie } });
    const csrf = await page.text();
    return { cookie, csrf };
}

const running: SetupServer[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((server) => server.close().catch(() => undefined)));
});

describe('local setup HTTP server', () => {
    it('uses a one-use bootstrap and requires the session for safe status', async () => {
        const service = fakeService();
        const server = await startSetupServer({
            service,
            renderSetupPage: ({ csrfToken }) => csrfToken,
        });
        running.push(server);

        const unauthorized = await fetch(`${server.origin}/api/status`);
        expect(unauthorized.status).toBe(401);
        const session = await authenticated(server);
        const safeStatus = await fetch(`${server.origin}/api/status`, { headers: { cookie: session.cookie } });
        expect(safeStatus.status).toBe(200);
        expect(await safeStatus.json()).toEqual(status());

        const replay = await fetch(server.url, { redirect: 'manual' });
        expect(replay.status).toBe(410);
    });

    it('requires exact origin and CSRF for every mutation', async () => {
        const setKey = vi.fn(async () => status());
        const service = fakeService({ setManualOpenRouterKey: setKey });
        const server = await startSetupServer({ service, renderSetupPage: ({ csrfToken }) => csrfToken });
        running.push(server);
        const session = await authenticated(server);

        const withoutOrigin = await fetch(`${server.origin}/api/openrouter/key`, {
            method: 'POST',
            headers: { cookie: session.cookie, 'content-type': 'application/json', 'x-pipi-csrf': session.csrf },
            body: JSON.stringify({ key: 'private-key' }),
        });
        expect(withoutOrigin.status).toBe(403);

        const wrongCsrf = await fetch(`${server.origin}/api/openrouter/key`, {
            method: 'POST',
            headers: {
                cookie: session.cookie,
                origin: server.origin,
                'content-type': 'application/json',
                'x-pipi-csrf': 'wrong',
            },
            body: JSON.stringify({ key: 'private-key' }),
        });
        expect(wrongCsrf.status).toBe(403);
        expect(setKey).not.toHaveBeenCalled();
    });

    it('passes a private key to the service without echoing it in JSON', async () => {
        const setKey = vi.fn(async () => status());
        const service = fakeService({ setManualOpenRouterKey: setKey });
        const server = await startSetupServer({ service, renderSetupPage: ({ csrfToken }) => csrfToken });
        running.push(server);
        const session = await authenticated(server);
        const secret = 'sk-or-v1-never-echo-this';

        const response = await fetch(`${server.origin}/api/openrouter/key`, {
            method: 'POST',
            headers: {
                cookie: session.cookie,
                origin: server.origin,
                'content-type': 'application/json',
                'x-pipi-csrf': session.csrf,
            },
            body: JSON.stringify({ key: secret }),
        });
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(setKey).toHaveBeenCalledWith(secret);
        expect(body).not.toContain(secret);
    });

    it('passes explicitly consented owner context to the service without returning private fields', async () => {
        const setMetadata = vi.fn(async () => ({ ...status(), metadata: { profilePresent: true } }));
        const service = fakeService({ setMetadata });
        const server = await startSetupServer({ service, renderSetupPage: ({ csrfToken }) => csrfToken });
        running.push(server);
        const session = await authenticated(server);
        const privateFact = 'Prefers short morning summaries';

        const response = await fetch(`${server.origin}/api/profile`, {
            method: 'POST',
            headers: {
                cookie: session.cookie,
                origin: server.origin,
                'content-type': 'application/json',
                'x-pipi-csrf': session.csrf,
            },
            body: JSON.stringify({
                consent: true,
                language: 'en',
                timezone: 'Europe/Rome',
                facts: [privateFact],
                currentTask: 'Plan this week',
            }),
        });
        const responseBody = await response.text();

        expect(response.status).toBe(200);
        expect(setMetadata).toHaveBeenCalledWith({
            language: 'en',
            timezone: 'Europe/Rome',
            profile: { facts: [privateFact], currentTask: 'Plan this week' },
        });
        expect(responseBody).not.toContain(privateFact);

        const invalid = await fetch(`${server.origin}/api/profile`, {
            method: 'POST',
            headers: {
                cookie: session.cookie,
                origin: server.origin,
                'content-type': 'application/json',
                'x-pipi-csrf': session.csrf,
            },
            body: JSON.stringify({ consent: true, language: 'en', timezone: 'UTC', facts: 'private', currentTask: '' }),
        });
        expect(invalid.status).toBe(400);

        const withoutConsent = await fetch(`${server.origin}/api/profile`, {
            method: 'POST',
            headers: {
                cookie: session.cookie,
                origin: server.origin,
                'content-type': 'application/json',
                'x-pipi-csrf': session.csrf,
            },
            body: JSON.stringify({ language: 'en', timezone: 'UTC', facts: [], currentTask: '' }),
        });
        expect(withoutConsent.status).toBe(400);
    });

    it('correlates the OAuth callback path and removes the code before redirecting', async () => {
        const callback = vi.fn(async () => status());
        const service = fakeService({ completeOpenRouterOAuth: callback });
        const server = await startSetupServer({ service, renderSetupPage: ({ csrfToken }) => csrfToken });
        running.push(server);
        const session = await authenticated(server);

        const response = await fetch(`${server.origin}/api/setup/openrouter/callback/state-value?code=private-code`, {
            headers: { cookie: session.cookie },
            redirect: 'manual',
        });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/?oauth=connected');
        expect(callback).toHaveBeenCalledWith('state-value', 'private-code');
        expect(response.headers.get('location')).not.toContain('private-code');
    });
});
