import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const GOOGLE_ENV = {
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://example.com/oauth/google/callback',
};

async function loadOAuth() {
    vi.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...GOOGLE_ENV,
    };
    const db = await import('../db');
    db.initDatabase();
    const oauth = await import('./google-oauth');
    oauth.initGoogleOAuthMigrations();
    return { db, oauth };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
});

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/google-oauth', () => {
    describe('isGoogleOAuthConfigured', () => {
        it('returns false when env vars are absent', async () => {
            vi.resetModules();
            process.env = { ...ORIGINAL_ENV };
            const { isGoogleOAuthConfigured } = await import('./google-oauth');
            expect(isGoogleOAuthConfigured()).toBe(false);
        });

        it('returns true when all three env vars are set', async () => {
            const { oauth } = await loadOAuth();
            expect(oauth.isGoogleOAuthConfigured()).toBe(true);
        });
    });

    describe('generateGoogleAuthUrl', () => {
        it('returns null when OAuth is not configured', async () => {
            vi.resetModules();
            process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-oauth-uncfg-${Date.now()}` };
            const db = await import('../db');
            db.initDatabase();
            const oauth = await import('./google-oauth');
            oauth.initGoogleOAuthMigrations();
            expect(oauth.generateGoogleAuthUrl('telegram:chat-1')).toBeNull();
            db.closeDatabase();
        });

        it('returns a valid URL with required OAuth parameters', async () => {
            const { oauth } = await loadOAuth();
            const url = oauth.generateGoogleAuthUrl('telegram:chat-1');
            expect(url).not.toBeNull();

            const parsed = new URL(url!);
            expect(parsed.hostname).toBe('accounts.google.com');
            expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
            expect(parsed.searchParams.get('redirect_uri')).toBe('https://example.com/oauth/google/callback');
            expect(parsed.searchParams.get('response_type')).toBe('code');
            expect(parsed.searchParams.get('access_type')).toBe('offline');
            expect(parsed.searchParams.get('prompt')).toBe('consent');

            const scope = parsed.searchParams.get('scope') || '';
            expect(scope).toContain('documents');
            expect(scope).toContain('spreadsheets');
            expect(scope).toContain('drive.readonly');
        });

        it('stores a hex nonce as state instead of a predictable base64 spaceId', async () => {
            const { oauth } = await loadOAuth();
            const url = oauth.generateGoogleAuthUrl('telegram:chat-1');
            const parsed = new URL(url!);
            const state = parsed.searchParams.get('state') || '';

            // Must be a 64-char hex string (32 bytes)
            expect(state).toMatch(/^[0-9a-f]{64}$/);
            // Must NOT be a base64-encoded version of the spaceId
            expect(state).not.toBe(Buffer.from('telegram:chat-1').toString('base64url'));
        });

        it('generates a different nonce on each call', async () => {
            const { oauth } = await loadOAuth();
            const url1 = new URL(oauth.generateGoogleAuthUrl('telegram:chat-1')!);
            const url2 = new URL(oauth.generateGoogleAuthUrl('telegram:chat-1')!);
            expect(url1.searchParams.get('state')).not.toBe(url2.searchParams.get('state'));
        });
    });

    describe('exchangeGoogleAuthCode', () => {
        it('throws when nonce is not found in the database', async () => {
            const { oauth } = await loadOAuth();
            await expect(oauth.exchangeGoogleAuthCode('auth-code', 'unknown-nonce')).rejects.toThrow(
                /invalid or expired/i
            );
        });

        it('throws when nonce is expired', async () => {
            const { db, oauth } = await loadOAuth();
            const expiredNonce = 'a'.repeat(64);
            db.getDb()
                .prepare('INSERT INTO google_oauth_nonces (nonce, space_id, expires_at) VALUES (?, ?, ?)')
                .run(expiredNonce, 'telegram:chat-1', Date.now() - 1000);

            await expect(oauth.exchangeGoogleAuthCode('auth-code', expiredNonce)).rejects.toThrow(
                /invalid or expired/i
            );
        });

        it('exchanges code, stores tokens, and calls success callback', async () => {
            const { db, oauth } = await loadOAuth();

            const validNonce = 'b'.repeat(64);
            db.getDb()
                .prepare('INSERT INTO google_oauth_nonces (nonce, space_id, expires_at) VALUES (?, ?, ?)')
                .run(validNonce, 'telegram:chat-1', Date.now() + 60_000);

            const fetchMock = vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    access_token: 'access-123',
                    refresh_token: 'refresh-456',
                    expires_in: 3600,
                    token_type: 'Bearer',
                    scope: 'https://www.googleapis.com/auth/documents',
                }),
            }));
            vi.stubGlobal('fetch', fetchMock);

            const successSpy = vi.fn(async () => {});
            oauth.onGoogleOAuthSuccess(successSpy);

            await oauth.exchangeGoogleAuthCode('auth-code', validNonce);

            expect(fetchMock).toHaveBeenCalledWith(
                'https://oauth2.googleapis.com/token',
                expect.objectContaining({ method: 'POST' })
            );

            const status = oauth.getGoogleAuthStatus('telegram:chat-1');
            expect(status.connected).toBe(true);
            expect(status.scope).toContain('documents');

            expect(successSpy).toHaveBeenCalledWith('telegram:chat-1');

            // Nonce is consumed — second call with same nonce must fail
            await expect(oauth.exchangeGoogleAuthCode('auth-code', validNonce)).rejects.toThrow(/invalid or expired/i);
        });

        it('throws when Google does not return a refresh_token', async () => {
            const { db, oauth } = await loadOAuth();

            const nonce = 'c'.repeat(64);
            db.getDb()
                .prepare('INSERT INTO google_oauth_nonces (nonce, space_id, expires_at) VALUES (?, ?, ?)')
                .run(nonce, 'telegram:chat-1', Date.now() + 60_000);

            vi.stubGlobal('fetch', async () => ({
                ok: true,
                json: async () => ({
                    access_token: 'access-only',
                    expires_in: 3600,
                    token_type: 'Bearer',
                    scope: 'docs',
                    // no refresh_token
                }),
            }));

            await expect(oauth.exchangeGoogleAuthCode('auth-code', nonce)).rejects.toThrow(/refresh token/i);
        });
    });

    describe('getGoogleAuthStatus', () => {
        it('returns connected=false for an unknown space', async () => {
            const { oauth } = await loadOAuth();
            expect(oauth.getGoogleAuthStatus('telegram:unknown')).toEqual({ connected: false });
        });

        it('returns connected=true with scope after tokens are stored', async () => {
            const { db, oauth } = await loadOAuth();
            db.getDb()
                .prepare(
                    `INSERT INTO google_oauth_tokens (space_id, access_token, refresh_token, token_type, expires_at, scope)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run('telegram:chat-1', 'acc', 'ref', 'Bearer', Date.now() + 3_600_000, 'docs spreadsheets');

            const status = oauth.getGoogleAuthStatus('telegram:chat-1');
            expect(status.connected).toBe(true);
            expect(status.scope).toBe('docs spreadsheets');
        });
    });

    describe('getValidGoogleAccessToken', () => {
        it('returns null when OAuth is not configured', async () => {
            vi.resetModules();
            process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-oauth-uncfg2-${Date.now()}` };
            const db = await import('../db');
            db.initDatabase();
            const oauth = await import('./google-oauth');
            oauth.initGoogleOAuthMigrations();
            expect(await oauth.getValidGoogleAccessToken('telegram:chat-1')).toBeNull();
            db.closeDatabase();
        });

        it('returns null when no token exists for the space', async () => {
            const { oauth } = await loadOAuth();
            expect(await oauth.getValidGoogleAccessToken('telegram:no-token')).toBeNull();
        });

        it('returns the access token when it is still fresh', async () => {
            const { db, oauth } = await loadOAuth();
            db.getDb()
                .prepare(
                    `INSERT INTO google_oauth_tokens (space_id, access_token, refresh_token, token_type, expires_at, scope)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run('telegram:chat-fresh', 'fresh-token', 'ref', 'Bearer', Date.now() + 3_600_000, 'docs');

            expect(await oauth.getValidGoogleAccessToken('telegram:chat-fresh')).toBe('fresh-token');
        });

        it('refreshes an expired token and returns the new access token', async () => {
            const { db, oauth } = await loadOAuth();
            db.getDb()
                .prepare(
                    `INSERT INTO google_oauth_tokens (space_id, access_token, refresh_token, token_type, expires_at, scope)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run('telegram:chat-exp', 'expired-token', 'good-refresh', 'Bearer', Date.now() - 1000, 'docs');

            vi.stubGlobal('fetch', async () => ({
                ok: true,
                json: async () => ({
                    access_token: 'new-access-token',
                    expires_in: 3600,
                    token_type: 'Bearer',
                    scope: 'docs',
                }),
            }));

            const token = await oauth.getValidGoogleAccessToken('telegram:chat-exp');
            expect(token).toBe('new-access-token');

            // Subsequent call should use the cached fresh token, not fetch again
            const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
            vi.stubGlobal('fetch', fetchSpy);
            const token2 = await oauth.getValidGoogleAccessToken('telegram:chat-exp');
            expect(token2).toBe('new-access-token');
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('returns null when the refresh request fails', async () => {
            const { db, oauth } = await loadOAuth();
            db.getDb()
                .prepare(
                    `INSERT INTO google_oauth_tokens (space_id, access_token, refresh_token, token_type, expires_at, scope)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run('telegram:chat-fail', 'expired', 'bad-refresh', 'Bearer', Date.now() - 1000, 'docs');

            vi.stubGlobal('fetch', async () => ({ ok: false, text: async () => 'invalid_grant' }));

            expect(await oauth.getValidGoogleAccessToken('telegram:chat-fail')).toBeNull();
        });
    });

    describe('revokeGoogleOAuthTokens', () => {
        it('returns false when no token exists for the space', async () => {
            const { oauth } = await loadOAuth();
            expect(oauth.revokeGoogleOAuthTokens('telegram:ghost')).toBe(false);
        });

        it('deletes the token row and returns true', async () => {
            const { db, oauth } = await loadOAuth();
            db.getDb()
                .prepare(
                    `INSERT INTO google_oauth_tokens (space_id, access_token, refresh_token, token_type, expires_at, scope)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run('telegram:chat-rev', 'acc-tok', 'ref-tok', 'Bearer', Date.now() + 3_600_000, 'docs');

            const fetchMock = vi.fn(async () => ({ ok: true }));
            vi.stubGlobal('fetch', fetchMock);

            const result = oauth.revokeGoogleOAuthTokens('telegram:chat-rev');
            expect(result).toBe(true);

            expect(oauth.getGoogleAuthStatus('telegram:chat-rev')).toEqual({ connected: false });
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('https://oauth2.googleapis.com/revoke'),
                expect.objectContaining({ method: 'POST' })
            );
        });
    });
});
