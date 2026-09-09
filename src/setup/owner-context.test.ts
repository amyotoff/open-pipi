import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getOwnerContextPath, readOwnerContext, readOwnerSetupStatus, saveOwnerContext } from './owner-context';

let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-owner-context-'));
});

afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function createStatusDatabase(): Database.Database {
    const database = new Database(path.join(dataDir, 'open-pipi.db'));
    database.exec(`
        CREATE TABLE spaces (
            id TEXT PRIMARY KEY, kind TEXT, title TEXT, channel TEXT, external_ref TEXT,
            status TEXT, assistant_pack_id TEXT, grounding_pack_id TEXT, policy_json TEXT,
            created_at TEXT, updated_at TEXT
        );
        CREATE TABLE transport_bindings (
            id TEXT PRIMARY KEY, transport TEXT, endpoint_id TEXT, endpoint_type TEXT,
            thread_id TEXT, normalized_thread_id TEXT, space_id TEXT, status TEXT,
            created_at TEXT, updated_at TEXT
        );
        CREATE TABLE grounding_overrides (
            id INTEGER PRIMARY KEY, space_id TEXT, kind TEXT, subject TEXT, content TEXT,
            status TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
        );
    `);
    return database;
}

describe('owner context private file', () => {
    it('stores bounded context atomically with private permissions and merges omitted fields', () => {
        saveOwnerContext(dataDir, {
            language: 'en',
            timezone: 'Europe/Rome',
            displayName: 'Amy',
            facts: ['Prefers concise answers'],
            currentTask: 'Plan the week',
        });
        saveOwnerContext(dataDir, { language: 'it', timezone: 'Europe/Rome' });

        expect(readOwnerContext(dataDir)).toMatchObject({
            language: 'it',
            displayName: 'Amy',
            facts: ['Prefers concise answers'],
            currentTask: 'Plan the week',
        });
        expect(fs.statSync(getOwnerContextPath(dataDir)).mode & 0o777).toBe(0o600);
    });

    it('rejects oversized private context', () => {
        expect(() =>
            saveOwnerContext(dataDir, {
                language: 'en',
                timezone: 'UTC',
                facts: ['1', '2', '3', '4', '5', '6'],
            })
        ).toThrow(/bounds/);
    });
});

describe('owner setup status', () => {
    it('leaves a new instance pack unknown so the configured setup default can win', () => {
        expect(readOwnerSetupStatus({ dataDir, ownerTelegramIds: ['111'] })).toEqual({ profilePresent: false });
        expect(fs.existsSync(path.join(dataDir, 'open-pipi.db'))).toBe(false);
    });

    it('reads the confirmed owner private binding and reports a custom pack', () => {
        const database = createStatusDatabase();
        database
            .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'telegram:111',
                'direct_chat',
                'Amy',
                'telegram',
                '111',
                'ACTIVE',
                'office',
                'jeeves_starter',
                JSON.stringify({ default_language: 'it', timezone: 'Europe/Rome' }),
                '2026-01-01',
                '2026-01-01'
            );
        database
            .prepare('INSERT INTO transport_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('b1', 'telegram', '111', 'direct', null, '', 'telegram:111', 'active', '2026-01-01', '2026-01-01');
        database.close();

        expect(readOwnerSetupStatus({ dataDir, ownerTelegramIds: ['111'] })).toEqual({
            currentPack: 'office',
            characterCustomized: true,
            profilePresent: false,
            language: 'it',
            timezone: 'Europe/Rome',
        });
    });

    it('does not guess another private space when the configured owner has no binding', () => {
        const database = createStatusDatabase();
        database
            .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'telegram:222',
                'direct_chat',
                'Other',
                'telegram',
                '222',
                'ACTIVE',
                'tutor',
                'jeeves_personal',
                '{}',
                '2026-01-01',
                '2026-01-01'
            );
        database.close();

        expect(readOwnerSetupStatus({ dataDir, ownerTelegramIds: ['111'] })).toEqual({ profilePresent: false });
    });

    it('reports an explicit preference save as pending instead of reverting to the live database value', () => {
        const database = createStatusDatabase();
        database
            .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'telegram:111',
                'direct_chat',
                'Amy',
                'telegram',
                '111',
                'ACTIVE',
                'jeeves',
                'jeeves_starter',
                JSON.stringify({ default_language: 'fr', timezone: 'Europe/Paris' }),
                '2026-01-01',
                '2026-01-01'
            );
        database
            .prepare('INSERT INTO transport_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run('b1', 'telegram', '111', 'direct', null, '', 'telegram:111', 'active', '2026-01-01', '2026-01-01');
        database.close();
        saveOwnerContext(dataDir, { language: 'it', timezone: 'Europe/Rome' });

        expect(readOwnerSetupStatus({ dataDir, ownerTelegramIds: ['111'] })).toMatchObject({
            language: 'it',
            timezone: 'Europe/Rome',
            preferencesPending: true,
        });
    });
});
