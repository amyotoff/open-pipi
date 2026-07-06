import { randomBytes } from 'node:crypto';
import { getDb } from '../db';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// drive.readonly is required for Drive files.export (used by office_read_google_doc).
const SCOPES = [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
].join(' ');

const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const MIGRATION_SQL = `
    CREATE TABLE IF NOT EXISTS google_oauth_tokens (
        space_id      TEXT    PRIMARY KEY,
        access_token  TEXT    NOT NULL,
        refresh_token TEXT    NOT NULL,
        token_type    TEXT    NOT NULL DEFAULT 'Bearer',
        expires_at    INTEGER NOT NULL,
        scope         TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS google_oauth_nonces (
        nonce      TEXT    PRIMARY KEY,
        space_id   TEXT    NOT NULL,
        expires_at INTEGER NOT NULL
    );
`;

type OAuthSuccessCallback = (spaceId: string) => Promise<void>;
let _successCallback: OAuthSuccessCallback | null = null;

export function onGoogleOAuthSuccess(cb: OAuthSuccessCallback): void {
    _successCallback = cb;
}

export function initGoogleOAuthMigrations(): void {
    const db = getDb();
    // Run each statement individually; exec() handles multi-statement SQL
    db.exec(MIGRATION_SQL);
}

export function isGoogleOAuthConfigured(): boolean {
    return Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_OAUTH_REDIRECT_URI
    );
}

function getConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) return null;
    return { clientId, clientSecret, redirectUri };
}

export function generateGoogleAuthUrl(spaceId: string): string | null {
    const config = getConfig();
    if (!config) return null;

    const db = getDb();
    // Purge stale nonces on each generation to keep the table small
    db.prepare('DELETE FROM google_oauth_nonces WHERE expires_at < ?').run(Date.now());

    const nonce = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO google_oauth_nonces (nonce, space_id, expires_at) VALUES (?, ?, ?)').run(
        nonce,
        spaceId,
        Date.now() + NONCE_TTL_MS
    );

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', nonce);
    return url.toString();
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope: string;
}

async function fetchTokens(params: Record<string, string>): Promise<TokenResponse> {
    const config = getConfig();
    if (!config) throw new Error('Google OAuth is not configured.');

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            ...params,
        }).toString(),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google token exchange failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<TokenResponse>;
}

function storeTokens(spaceId: string, tokens: TokenResponse, existingRefreshToken?: string): void {
    const expiresAt = Date.now() + (tokens.expires_in - 60) * 1000;
    const refreshToken = tokens.refresh_token || existingRefreshToken || '';

    getDb()
        .prepare(
            `
            INSERT INTO google_oauth_tokens (space_id, access_token, refresh_token, token_type, expires_at, scope)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(space_id) DO UPDATE SET
                access_token  = excluded.access_token,
                refresh_token = CASE WHEN excluded.refresh_token != '' THEN excluded.refresh_token ELSE refresh_token END,
                token_type    = excluded.token_type,
                expires_at    = excluded.expires_at,
                scope         = excluded.scope
        `
        )
        .run(
            spaceId,
            tokens.access_token,
            refreshToken,
            tokens.token_type || 'Bearer',
            expiresAt,
            tokens.scope || SCOPES
        );
}

// state is the one-time nonce issued by generateGoogleAuthUrl; spaceId is resolved from it.
export async function exchangeGoogleAuthCode(code: string, state: string): Promise<void> {
    const config = getConfig();
    if (!config) throw new Error('Google OAuth is not configured.');

    const db = getDb();
    const nonceRow = db
        .prepare('SELECT space_id FROM google_oauth_nonces WHERE nonce = ? AND expires_at > ?')
        .get(state, Date.now()) as { space_id: string } | undefined;

    if (!nonceRow) {
        throw new Error('Invalid or expired OAuth state. Please run /gdrive auth again to restart the flow.');
    }

    // Consume once — prevents replay attacks
    db.prepare('DELETE FROM google_oauth_nonces WHERE nonce = ?').run(state);

    const spaceId = nonceRow.space_id;

    const tokens = await fetchTokens({
        code,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
    });

    if (!tokens.refresh_token) {
        throw new Error(
            'Google did not return a refresh token. Revoke app access at myaccount.google.com/permissions and re-authorize.'
        );
    }

    storeTokens(spaceId, tokens);

    if (_successCallback) {
        await _successCallback(spaceId).catch((err) => {
            console.error('[GOOGLE_OAUTH] Success callback error:', err);
        });
    }
}

export interface GoogleAuthStatus {
    connected: boolean;
    scope?: string;
    expires_at?: number;
}

export function getGoogleAuthStatus(spaceId: string): GoogleAuthStatus {
    const row = getDb().prepare('SELECT scope, expires_at FROM google_oauth_tokens WHERE space_id = ?').get(spaceId) as
        | { scope: string; expires_at: number }
        | undefined;

    if (!row) return { connected: false };
    return { connected: true, scope: row.scope, expires_at: row.expires_at };
}

export async function getValidGoogleAccessToken(spaceId: string): Promise<string | null> {
    if (!isGoogleOAuthConfigured()) return null;

    const row = getDb()
        .prepare('SELECT access_token, refresh_token, expires_at FROM google_oauth_tokens WHERE space_id = ?')
        .get(spaceId) as { access_token: string; refresh_token: string; expires_at: number } | undefined;

    if (!row) return null;

    if (Date.now() < row.expires_at) {
        return row.access_token;
    }

    try {
        const tokens = await fetchTokens({ refresh_token: row.refresh_token, grant_type: 'refresh_token' });
        storeTokens(spaceId, tokens, row.refresh_token);
        return tokens.access_token;
    } catch (err) {
        console.error('[GOOGLE_OAUTH] Token refresh failed:', err);
        return null;
    }
}

export function revokeGoogleOAuthTokens(spaceId: string): boolean {
    const row = getDb().prepare('SELECT access_token FROM google_oauth_tokens WHERE space_id = ?').get(spaceId) as
        | { access_token: string }
        | undefined;

    if (!row) return false;

    getDb().prepare('DELETE FROM google_oauth_tokens WHERE space_id = ?').run(spaceId);

    fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(row.access_token)}`, { method: 'POST' }).catch(() => {});
    return true;
}
