import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

let dataDir: string;

async function loadAuth() {
    vi.resetModules();
    const db = await import('../db');
    db.initDatabase();
    db.upsertResident({ tg_id: '777', display_name: 'Alex', role: 'owner' });
    const auth = await import('./auth');
    auth.clearLoginAttempts();
    return { db, ...auth };
}

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-webauth-'));
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

describe('web accounts', () => {
    it('links an account to an existing participant', async () => {
        const { upsertWebAccount } = await loadAuth();

        const account = upsertWebAccount({ username: 'Alex', password: 'correct horse', participantId: '777' });

        // Lowercased so a login cannot depend on how the name was typed.
        expect(account.username).toBe('alex');
        expect(account.participant_id).toBe('777');
    });

    it('refuses to invent a participant', async () => {
        const { upsertWebAccount } = await loadAuth();

        // Creating one here would quietly conjure a person, and the whole point
        // of the link is that it names somebody the operator already knows.
        expect(() =>
            upsertWebAccount({ username: 'ghost', password: 'correct horse', participantId: 'nobody' })
        ).toThrow(/does not exist/);
    });

    it('rejects a password too short to be worth hashing', async () => {
        const { upsertWebAccount } = await loadAuth();

        expect(() => upsertWebAccount({ username: 'alex', password: 'short', participantId: '777' })).toThrow(
            /at least 8/
        );
    });

    it('never stores the password itself', async () => {
        const { upsertWebAccount } = await loadAuth();

        const account = upsertWebAccount({ username: 'alex', password: 'correct horse', participantId: '777' });

        expect(account.password_hash).not.toContain('correct horse');
        expect(account.password_salt).toHaveLength(32);
    });

    it('gives the same password a different hash for each account', async () => {
        const { db, upsertWebAccount } = await loadAuth();
        db.upsertResident({ tg_id: '888', display_name: 'Sam', role: 'member' });

        const first = upsertWebAccount({ username: 'alex', password: 'same password', participantId: '777' });
        const second = upsertWebAccount({ username: 'sam', password: 'same password', participantId: '888' });

        // Per-account salts, so one cracked hash does not reveal the other.
        expect(first.password_hash).not.toBe(second.password_hash);
    });
});

describe('web login', () => {
    async function withAccount() {
        const auth = await loadAuth();
        auth.upsertWebAccount({ username: 'alex', password: 'correct horse', participantId: '777' });
        return auth;
    }

    it('issues a session for the right password', async () => {
        const { login } = await withAccount();

        const outcome = login({ username: 'alex', password: 'correct horse' });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.session.participantId).toBe('777');
        expect(outcome.session.token).toHaveLength(43);
    });

    it('answers a wrong password and an unknown account identically', async () => {
        const { login } = await withAccount();

        const wrongPassword = login({ username: 'alex', password: 'wrong', throttleKey: 'a' });
        const unknownUser = login({ username: 'nobody', password: 'wrong', throttleKey: 'b' });

        // Telling them apart would turn the login form into a way to discover
        // who has an account.
        expect(wrongPassword).toEqual({ ok: false, reason: 'invalid_credentials' });
        expect(unknownUser).toEqual({ ok: false, reason: 'invalid_credentials' });
    });

    it('stops guessing after a handful of failures', async () => {
        const { login } = await withAccount();

        for (let attempt = 0; attempt < 5; attempt += 1) {
            expect(login({ username: 'alex', password: 'wrong' }).ok).toBe(false);
        }

        const throttled = login({ username: 'alex', password: 'correct horse' });
        expect(throttled).toEqual({ ok: false, reason: 'throttled' });
    });

    it('forgets failures once the account is used successfully', async () => {
        const { login } = await withAccount();
        login({ username: 'alex', password: 'wrong' });
        login({ username: 'alex', password: 'wrong' });

        expect(login({ username: 'alex', password: 'correct horse' }).ok).toBe(true);
        expect(login({ username: 'alex', password: 'wrong' }).ok).toBe(false);
        expect(login({ username: 'alex', password: 'correct horse' }).ok).toBe(true);
    });

    it('refuses a disabled account and drops its sessions', async () => {
        const { login, disableWebAccount, resolveSession } = await withAccount();
        const outcome = login({ username: 'alex', password: 'correct horse' });
        if (!outcome.ok) throw new Error('expected a session');

        disableWebAccount('alex');

        expect(resolveSession(outcome.session.token)).toBeNull();
        expect(login({ username: 'alex', password: 'correct horse' })).toEqual({ ok: false, reason: 'disabled' });
    });
});

describe('web sessions', () => {
    async function withSession() {
        const auth = await loadAuth();
        auth.upsertWebAccount({ username: 'alex', password: 'correct horse', participantId: '777' });
        const outcome = auth.login({ username: 'alex', password: 'correct horse' });
        if (!outcome.ok) throw new Error('expected a session');
        return { ...auth, session: outcome.session };
    }

    it('resolves a live session to its participant', async () => {
        const { resolveSession, session } = await withSession();

        expect(resolveSession(session.token)?.participantId).toBe('777');
    });

    it('stores only a digest, so a stolen database yields no live sessions', async () => {
        const { db, session } = await withSession();

        const rows = db.getDb().prepare('SELECT token_hash FROM web_sessions').all() as Array<{ token_hash: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].token_hash).not.toBe(session.token);
        expect(rows[0].token_hash).toHaveLength(64);
    });

    it('treats a forged or absent token as simply not signed in', async () => {
        const { resolveSession } = await withSession();

        expect(resolveSession('made-up-token')).toBeNull();
        expect(resolveSession(undefined)).toBeNull();
        expect(resolveSession('')).toBeNull();
    });

    it('drops an expired session on sight', async () => {
        const { db, resolveSession, session } = await withSession();
        db.getDb()
            .prepare('UPDATE web_sessions SET expires_at = ?')
            .run(new Date(Date.now() - 1000).toISOString());

        expect(resolveSession(session.token)).toBeNull();
        expect(db.getDb().prepare('SELECT COUNT(*) as count FROM web_sessions').get()).toEqual({ count: 0 });
    });

    it('ends a session on logout', async () => {
        const { resolveSession, revokeSession, session } = await withSession();

        revokeSession(session.token);

        expect(resolveSession(session.token)).toBeNull();
    });

    it('purges expired rows without touching live ones', async () => {
        const { db, purgeExpiredSessions, resolveSession, session } = await withSession();
        db.getDb()
            .prepare(
                `INSERT INTO web_sessions (token_hash, username, created_at, expires_at, last_seen_at)
                 VALUES ('stale', 'alex', ?, ?, ?)`
            )
            .run(new Date(0).toISOString(), new Date(Date.now() - 1000).toISOString(), new Date(0).toISOString());

        expect(purgeExpiredSessions()).toBe(1);
        expect(resolveSession(session.token)).not.toBeNull();
    });
});
