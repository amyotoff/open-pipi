/**
 * Local accounts for the Web client.
 *
 * Deliberately small: a password hashed with scrypt from node's own crypto, an
 * opaque random session token, and a rate limit on guessing. No OAuth, no JWT,
 * no new dependency. This is a tool on someone's home network, not an identity
 * provider.
 *
 * Two properties are worth stating because they are easy to lose:
 *
 * - Sessions are stored **hashed**. A stolen database gives an attacker no live
 *   sessions, the same way a stolen password file gives them no passwords.
 * - An account is bound to an existing participant, so signing in over the Web
 *   arrives as the same person as their Telegram account, with the same memory,
 *   membership, and authority.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb, getResident, linkParticipantIdentity } from '../db';

const SCRYPT_KEY_LENGTH = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 5;

export interface WebAccount {
    username: string;
    password_hash: string;
    password_salt: string;
    participant_id: string;
    status: string;
    created_at: string;
    updated_at: string;
}

export interface WebSession {
    token_hash: string;
    username: string;
    created_at: string;
    expires_at: string;
    last_seen_at: string;
}

function nowIso(): string {
    return new Date().toISOString();
}

function hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
}

/** Sessions are looked up by digest, so the raw token exists only in the cookie. */
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Compare without leaking how much of the hash matched.
 *
 * Length is checked first because timingSafeEqual throws on a mismatch, and a
 * differing length is not a secret worth protecting.
 */
function constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}

// ==========================================
// Accounts
// ==========================================

export function getWebAccount(username: string): WebAccount | undefined {
    return getDb().prepare('SELECT * FROM web_accounts WHERE username = ?').get(username) as WebAccount | undefined;
}

export function countWebAccounts(): number {
    return (getDb().prepare('SELECT COUNT(*) as count FROM web_accounts').get() as { count: number }).count;
}

/**
 * Create or re-password an account.
 *
 * The participant must already exist. Creating one here would quietly invent a
 * person, and the whole point of the link is that it points at somebody the
 * operator already knows.
 */
export function upsertWebAccount(input: { username: string; password: string; participantId: string }): WebAccount {
    const username = input.username.trim().toLowerCase();
    if (!username) throw new Error('A web account needs a username.');
    if (input.password.length < 8) throw new Error('A web account password must be at least 8 characters.');
    if (!getResident(input.participantId)) {
        throw new Error(
            `Participant "${input.participantId}" does not exist. Link a web account to someone the assistant already knows.`
        );
    }

    const salt = randomBytes(16).toString('hex');
    const now = nowIso();

    getDb()
        .prepare(
            `
        INSERT INTO web_accounts (username, password_hash, password_salt, participant_id, status, created_at, updated_at)
        VALUES (@username, @password_hash, @password_salt, @participant_id, 'active', @created_at, @updated_at)
        ON CONFLICT(username) DO UPDATE SET
            password_hash = @password_hash,
            password_salt = @password_salt,
            participant_id = @participant_id,
            updated_at = @updated_at
    `
        )
        .run({
            username,
            password_hash: hashPassword(input.password, salt),
            password_salt: salt,
            participant_id: input.participantId,
            created_at: now,
            updated_at: now,
        });

    // The account is a transport identity like any other. Without this row the
    // resolver would not recognize the login as an existing participant and
    // would mint a second person — which is precisely what linking is for.
    linkParticipantIdentity({
        participantId: input.participantId,
        transport: 'web',
        externalUserId: username,
        displayName: getResident(input.participantId)?.display_name ?? null,
    });

    return getWebAccount(username)!;
}

export function disableWebAccount(username: string): void {
    getDb()
        .prepare("UPDATE web_accounts SET status = 'disabled', updated_at = ? WHERE username = ?")
        .run(nowIso(), username.trim().toLowerCase());
    revokeSessionsForAccount(username.trim().toLowerCase());
}

// ==========================================
// Login rate limiting
// ==========================================

const loginAttempts = new Map<string, { count: number; firstAttemptAt: number }>();

export function isLoginThrottled(key: string, now: number = Date.now()): boolean {
    const record = loginAttempts.get(key);
    if (!record) return false;
    if (now - record.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
        loginAttempts.delete(key);
        return false;
    }
    return record.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(key: string, now: number = Date.now()): void {
    const record = loginAttempts.get(key);
    if (!record || now - record.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
        loginAttempts.set(key, { count: 1, firstAttemptAt: now });
        return;
    }
    record.count += 1;
}

export function clearLoginAttempts(key?: string): void {
    if (key) loginAttempts.delete(key);
    else loginAttempts.clear();
}

// ==========================================
// Sessions
// ==========================================

export interface AuthenticatedSession {
    token: string;
    username: string;
    participantId: string;
    expiresAt: string;
}

export type LoginOutcome =
    | { ok: true; session: AuthenticatedSession }
    | { ok: false; reason: 'invalid_credentials' | 'throttled' | 'disabled' };

/**
 * Verify a password and issue a session.
 *
 * A wrong username and a wrong password are answered identically, so the
 * response cannot be used to discover who has an account.
 */
export function login(input: { username: string; password: string; throttleKey?: string }): LoginOutcome {
    const username = input.username.trim().toLowerCase();
    const throttleKey = input.throttleKey || username;

    if (isLoginThrottled(throttleKey)) return { ok: false, reason: 'throttled' };

    const account = getWebAccount(username);
    if (!account) {
        // Still costs a hash, so a missing account is not faster than a wrong
        // password and cannot be spotted by timing.
        hashPassword(input.password, 'absent-account-salt');
        recordFailedLogin(throttleKey);
        return { ok: false, reason: 'invalid_credentials' };
    }

    if (!constantTimeEquals(hashPassword(input.password, account.password_salt), account.password_hash)) {
        recordFailedLogin(throttleKey);
        return { ok: false, reason: 'invalid_credentials' };
    }

    if (account.status !== 'active') return { ok: false, reason: 'disabled' };

    clearLoginAttempts(throttleKey);
    return { ok: true, session: issueSession(account) };
}

export function issueSession(account: WebAccount): AuthenticatedSession {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

    getDb()
        .prepare(
            `
        INSERT INTO web_sessions (token_hash, username, created_at, expires_at, last_seen_at)
        VALUES (@token_hash, @username, @created_at, @expires_at, @last_seen_at)
    `
        )
        .run({
            token_hash: hashToken(token),
            username: account.username,
            created_at: now.toISOString(),
            expires_at: expiresAt,
            last_seen_at: now.toISOString(),
        });

    return { token, username: account.username, participantId: account.participant_id, expiresAt };
}

/**
 * Resolve a cookie to the person it belongs to, or nothing.
 *
 * An expired session, a disabled account, and a forged token are all simply
 * "not signed in" — the caller has no decision to make between them.
 */
export function resolveSession(token: string | undefined | null): AuthenticatedSession | null {
    if (!token) return null;

    const row = getDb().prepare('SELECT * FROM web_sessions WHERE token_hash = ?').get(hashToken(token)) as
        | WebSession
        | undefined;
    if (!row) return null;

    if (Date.parse(row.expires_at) <= Date.now()) {
        revokeSession(token);
        return null;
    }

    const account = getWebAccount(row.username);
    if (!account || account.status !== 'active') {
        revokeSession(token);
        return null;
    }

    getDb().prepare('UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), row.token_hash);

    return {
        token,
        username: account.username,
        participantId: account.participant_id,
        expiresAt: row.expires_at,
    };
}

export function revokeSession(token: string): void {
    getDb().prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(hashToken(token));
}

export function revokeSessionsForAccount(username: string): void {
    getDb().prepare('DELETE FROM web_sessions WHERE username = ?').run(username);
}

/** Housekeeping: expired rows serve no purpose and should not accumulate. */
export function purgeExpiredSessions(): number {
    return getDb().prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(nowIso()).changes;
}
