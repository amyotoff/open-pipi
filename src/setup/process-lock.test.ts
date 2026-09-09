import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ProcessLockError,
    acquireProcessLock,
    getProcessLockGuardPath,
    getProcessLockPath,
    readProcessLock,
} from './process-lock';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-lock-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('process ownership lock', () => {
    it('distinguishes setup polling from runtime ownership', () => {
        const dataDir = temporaryDirectory();
        const setup = acquireProcessLock(dataDir, 'setup');
        const status = readProcessLock(dataDir);

        expect(status).toMatchObject({
            held: true,
            stale: false,
            owner: 'setup',
            state: 'starting',
            pid: process.pid,
            runId: setup.runId,
            dataDir,
        });
        expect(() => acquireProcessLock(dataDir, 'runtime')).toThrowError(
            expect.objectContaining({ code: 'already_running' })
        );

        setup.release();
        expect(readProcessLock(dataDir)).toEqual({ held: false, stale: false, dataDir });
    });

    it('publishes ready only when the owner explicitly marks startup complete', () => {
        const dataDir = temporaryDirectory();
        const lock = acquireProcessLock(dataDir, 'runtime', {
            runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            mode: 'background',
        });

        expect(readProcessLock(dataDir)).toMatchObject({ state: 'starting', readyAt: undefined });
        lock.markReady();
        expect(readProcessLock(dataDir)).toMatchObject({
            state: 'ready',
            runId: lock.runId,
            mode: 'background',
            readyAt: expect.any(String),
        });

        lock.release();
    });

    it('reclaims a dead runtime while holding the serialized acquisition guard', () => {
        const dataDir = temporaryDirectory();
        fs.writeFileSync(
            getProcessLockPath(dataDir),
            `${JSON.stringify({
                version: 1,
                owner: 'runtime',
                state: 'ready',
                pid: 2_147_483_647,
                runId: '11111111-2222-4333-8444-555555555555',
                startedAt: '2026-09-09T00:00:00.000Z',
            })}\n`,
            { mode: 0o600 }
        );

        expect(readProcessLock(dataDir)).toMatchObject({ held: false, stale: true, owner: 'runtime' });
        const replacement = acquireProcessLock(dataDir, 'setup');
        expect(readProcessLock(dataDir)).toMatchObject({ held: true, owner: 'setup', runId: replacement.runId });
        replacement.release();
    });

    it('reclaims a reused live PID only when its persisted process identity mismatches', () => {
        const dataDir = temporaryDirectory();
        fs.writeFileSync(
            getProcessLockPath(dataDir),
            `${JSON.stringify({
                version: 2,
                owner: 'runtime',
                state: 'ready',
                pid: 4321,
                runId: '11111111-2222-4333-8444-555555555555',
                startedAt: '2026-09-09T00:00:00.000Z',
                processIdentity: 'linux:old-boot:10',
            })}\n`,
            { mode: 0o600 }
        );
        const readIdentity = () => ({ state: 'alive' as const, fingerprint: 'linux:new-boot:99' });

        expect(readProcessLock(dataDir, { readIdentity })).toMatchObject({
            held: false,
            stale: true,
            identityVerified: false,
        });
        const replacement = acquireProcessLock(dataDir, 'setup', { readIdentity });
        expect(readProcessLock(dataDir, { readIdentity })).toMatchObject({
            held: true,
            stale: false,
            identityVerified: true,
            runId: replacement.runId,
        });
        replacement.release();
    });

    it('fails closed for a live legacy or unverifiable process identity', () => {
        for (const identity of [
            () => ({ state: 'alive' as const, fingerprint: 'linux:current:20' }),
            () => ({ state: 'unverifiable' as const }),
        ]) {
            const dataDir = temporaryDirectory();
            const lockPath = getProcessLockPath(dataDir);
            fs.writeFileSync(
                lockPath,
                JSON.stringify({
                    version: 1,
                    owner: 'runtime',
                    state: 'ready',
                    pid: process.pid,
                    runId: '11111111-2222-4333-8444-555555555555',
                    startedAt: '2026-09-09T00:00:00.000Z',
                }),
                { mode: 0o600 }
            );

            expect(readProcessLock(dataDir, { readIdentity: identity })).toMatchObject({
                held: false,
                stale: false,
                unverifiable: true,
            });
            expect(() => acquireProcessLock(dataDir, 'setup', { readIdentity: identity })).toThrowError(
                expect.objectContaining({ code: 'stale_lock' })
            );
            expect(fs.existsSync(lockPath)).toBe(true);
        }
    });

    it('fails closed behind another acquisition guard without touching its ownership file', () => {
        const dataDir = temporaryDirectory();
        const mainPath = getProcessLockPath(dataDir);
        fs.writeFileSync(
            mainPath,
            JSON.stringify({
                version: 1,
                owner: 'runtime',
                state: 'ready',
                pid: 2_147_483_647,
                runId: '11111111-2222-4333-8444-555555555555',
                startedAt: '2026-09-09T00:00:00.000Z',
            })
        );
        fs.writeFileSync(getProcessLockGuardPath(dataDir), 'another-acquirer');

        expect(() => acquireProcessLock(dataDir, 'setup')).toThrowError(
            expect.objectContaining({ code: 'lock_failed' })
        );
        expect(JSON.parse(fs.readFileSync(mainPath, 'utf8')).runId).toBe('11111111-2222-4333-8444-555555555555');
    });

    it('does not delete a corrupt or symlinked ownership path', () => {
        const corruptDir = temporaryDirectory();
        const corruptPath = getProcessLockPath(corruptDir);
        fs.writeFileSync(corruptPath, '{bad-json');
        expect(() => acquireProcessLock(corruptDir, 'runtime')).toThrowError(
            expect.objectContaining({ code: 'corrupt_lock' })
        );
        expect(fs.existsSync(corruptPath)).toBe(true);

        const linkedDir = temporaryDirectory();
        const linkedPath = getProcessLockPath(linkedDir);
        fs.symlinkSync(corruptPath, linkedPath);
        expect(() => readProcessLock(linkedDir)).toThrowError(ProcessLockError);
        expect(fs.lstatSync(linkedPath).isSymbolicLink()).toBe(true);
    });

    it('only lets the matching acquisition release its lock', () => {
        const dataDir = temporaryDirectory();
        const first = acquireProcessLock(dataDir, 'runtime');
        const record = JSON.parse(fs.readFileSync(getProcessLockPath(dataDir), 'utf8'));
        record.runId = '99999999-2222-4333-8444-555555555555';
        fs.writeFileSync(getProcessLockPath(dataDir), JSON.stringify(record), { mode: 0o600 });

        first.release();
        expect(fs.existsSync(getProcessLockPath(dataDir))).toBe(true);
    });
});
