import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export type ProcessLockOwner = 'setup' | 'runtime';
export type ProcessLockState = 'starting' | 'ready';
export type RuntimeMode = 'foreground' | 'background';

interface ProcessLockRecord {
    version: 1 | 2;
    owner: ProcessLockOwner;
    state: ProcessLockState;
    pid: number;
    runId: string;
    startedAt: string;
    readyAt?: string;
    mode?: RuntimeMode;
    processIdentity?: string;
}

export type ProcessIdentityStatus =
    | { state: 'alive'; fingerprint: string }
    | { state: 'dead' }
    | { state: 'unverifiable' };

export type ProcessIdentityReader = (pid: number) => ProcessIdentityStatus;

const SELF_PROCESS_IDENTITY = `self:${process.platform}:${randomUUID()}`;

function hasControlCharacter(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
    });
}

export interface ProcessLockStatus {
    held: boolean;
    stale: boolean;
    owner?: ProcessLockOwner;
    state?: ProcessLockState;
    pid?: number;
    runId?: string;
    startedAt?: string;
    readyAt?: string;
    mode?: RuntimeMode;
    identityVerified?: boolean;
    unverifiable?: boolean;
    dataDir: string;
}

export interface ProcessLock {
    readonly owner: ProcessLockOwner;
    readonly runId: string;
    readonly dataDir: string;
    markReady(): void;
    release(): void;
}

export type ProcessLockErrorCode = 'already_running' | 'stale_lock' | 'unsafe_lock' | 'corrupt_lock' | 'lock_failed';

export class ProcessLockError extends Error {
    constructor(
        public readonly code: ProcessLockErrorCode,
        message: string,
        public readonly status?: ProcessLockStatus
    ) {
        super(message);
        this.name = 'ProcessLockError';
    }
}

export function getProcessLockPath(dataDir: string): string {
    return path.join(path.resolve(dataDir), 'open-pipi.lock');
}

export function getProcessLockGuardPath(dataDir: string): string {
    return `${getProcessLockPath(dataDir)}.acquire`;
}

function pidExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function linuxProcessIdentity(pid: number): string | undefined {
    try {
        const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
        const close = stat.lastIndexOf(')');
        const startTicks =
            close >= 0
                ? stat
                      .slice(close + 1)
                      .trim()
                      .split(/\s+/)[19]
                : undefined;
        if (!/^[a-f0-9-]{16,64}$/i.test(bootId) || !startTicks || !/^\d+$/.test(startTicks)) return undefined;
        return `linux:${bootId}:${startTicks}`;
    } catch {
        return undefined;
    }
}

function darwinProcessIdentity(pid: number): string | undefined {
    try {
        const boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (!boot || !started) return undefined;
        return `darwin:${boot}:${started}`;
    } catch {
        return undefined;
    }
}

export function readProcessIdentity(pid: number): ProcessIdentityStatus {
    if (!pidExists(pid)) return { state: 'dead' };
    const fingerprint =
        process.platform === 'linux'
            ? linuxProcessIdentity(pid)
            : process.platform === 'darwin'
              ? darwinProcessIdentity(pid)
              : undefined;
    if (!fingerprint && pid === process.pid) {
        return { state: 'alive', fingerprint: SELF_PROCESS_IDENTITY };
    }
    return fingerprint ? { state: 'alive', fingerprint } : { state: 'unverifiable' };
}

function readRecord(lockPath: string): ProcessLockRecord | null {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(lockPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new ProcessLockError('lock_failed', 'The runtime ownership file could not be inspected.');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ProcessLockError('unsafe_lock', 'The runtime ownership path is not a regular file.');
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<ProcessLockRecord>;
        if (
            (parsed.version !== 1 && parsed.version !== 2) ||
            (parsed.owner !== 'setup' && parsed.owner !== 'runtime') ||
            (parsed.state !== 'starting' && parsed.state !== 'ready') ||
            !Number.isSafeInteger(parsed.pid) ||
            Number(parsed.pid) <= 0 ||
            typeof parsed.runId !== 'string' ||
            !/^[a-f0-9-]{16,64}$/i.test(parsed.runId) ||
            typeof parsed.startedAt !== 'string' ||
            (parsed.version === 2 &&
                (typeof parsed.processIdentity !== 'string' ||
                    parsed.processIdentity.length === 0 ||
                    parsed.processIdentity.length > 512 ||
                    hasControlCharacter(parsed.processIdentity)))
        ) {
            throw new Error('invalid record');
        }
        if (parsed.mode !== undefined && parsed.mode !== 'foreground' && parsed.mode !== 'background') {
            throw new Error('invalid mode');
        }
        return parsed as ProcessLockRecord;
    } catch {
        throw new ProcessLockError('corrupt_lock', 'The runtime ownership file is invalid.');
    }
}

function statusFromRecord(
    dataDir: string,
    record: ProcessLockRecord | null,
    readIdentity: ProcessIdentityReader
): ProcessLockStatus {
    if (!record) return { held: false, stale: false, dataDir: path.resolve(dataDir) };
    const identity = readIdentity(record.pid);
    const verified =
        identity.state === 'alive' && record.version === 2 && record.processIdentity === identity.fingerprint;
    const stale =
        identity.state === 'dead' ||
        (identity.state === 'alive' && record.version === 2 && record.processIdentity !== identity.fingerprint);
    const unverifiable = !verified && !stale;
    return {
        held: verified,
        stale,
        owner: record.owner,
        state: record.state,
        pid: record.pid,
        runId: record.runId,
        startedAt: record.startedAt,
        readyAt: record.readyAt,
        mode: record.mode,
        identityVerified: verified,
        ...(unverifiable ? { unverifiable: true } : {}),
        dataDir: path.resolve(dataDir),
    };
}

export function readProcessLock(
    dataDir: string,
    options: { readIdentity?: ProcessIdentityReader } = {}
): ProcessLockStatus {
    return statusFromRecord(
        dataDir,
        readRecord(getProcessLockPath(dataDir)),
        options.readIdentity || readProcessIdentity
    );
}

function writeRecordExclusive(lockPath: string, record: ProcessLockRecord): void {
    let descriptor: number | undefined;
    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        descriptor = fs.openSync(
            lockPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
            0o600
        );
        fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
    } catch (error) {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {}
        }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new ProcessLockError('already_running', 'Open PiPi is already owned by another process.');
        }
        throw new ProcessLockError('lock_failed', 'Runtime ownership could not be acquired.');
    }
}

function replaceOwnedRecord(lockPath: string, runId: string, update: (record: ProcessLockRecord) => void): void {
    const record = readRecord(lockPath);
    if (!record || record.runId !== runId || record.pid !== process.pid) return;
    update(record);
    const temporaryPath = `${lockPath}.${runId}.tmp`;
    let descriptor: number | undefined;
    try {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        descriptor = fs.openSync(
            temporaryPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
            0o600
        );
        fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        const current = readRecord(lockPath);
        if (!current || current.runId !== runId || current.pid !== process.pid) throw new Error('ownership changed');
        fs.renameSync(temporaryPath, lockPath);
    } catch {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {}
        }
        try {
            fs.unlinkSync(temporaryPath);
        } catch {}
        throw new ProcessLockError('lock_failed', 'Runtime ownership could not be updated.');
    }
}

export function acquireProcessLock(
    dataDir: string,
    owner: ProcessLockOwner,
    options: { runId?: string; mode?: RuntimeMode; readIdentity?: ProcessIdentityReader } = {}
): ProcessLock {
    const lockPath = getProcessLockPath(dataDir);
    const guardPath = getProcessLockGuardPath(dataDir);
    let guardDescriptor: number | undefined;
    const runId = options.runId || randomUUID();
    const readIdentity = options.readIdentity || readProcessIdentity;
    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        guardDescriptor = fs.openSync(
            guardPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
            0o600
        );
        fs.writeFileSync(guardDescriptor, `${process.pid}\n`, 'utf8');
        fs.fsyncSync(guardDescriptor);

        const existing = readRecord(lockPath);
        if (existing) {
            const status = statusFromRecord(dataDir, existing, readIdentity);
            if (status.held) {
                throw new ProcessLockError(
                    'already_running',
                    `${existing.owner === 'setup' ? 'Setup' : 'Open PiPi'} already owns this installation.`,
                    status
                );
            }
            if (!status.stale) {
                throw new ProcessLockError(
                    'stale_lock',
                    'The existing process identity cannot be verified safely.',
                    status
                );
            }
            // Every contender must hold the acquisition guard, so reclaiming a
            // dead owner's file cannot unlink a new live owner's claim.
            fs.unlinkSync(lockPath);
        }

        const identity = readIdentity(process.pid);
        if (identity.state !== 'alive') {
            throw new ProcessLockError('lock_failed', 'This process identity cannot be verified safely.');
        }
        const record: ProcessLockRecord = {
            version: 2,
            owner,
            state: 'starting',
            pid: process.pid,
            runId,
            startedAt: new Date().toISOString(),
            processIdentity: identity.fingerprint,
            ...(options.mode ? { mode: options.mode } : {}),
        };
        writeRecordExclusive(lockPath, record);
    } catch (error) {
        if (error instanceof ProcessLockError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new ProcessLockError(
                'lock_failed',
                'Runtime ownership acquisition is already in progress or needs recovery.'
            );
        }
        throw new ProcessLockError('lock_failed', 'Runtime ownership could not be acquired.');
    } finally {
        if (guardDescriptor !== undefined) {
            try {
                fs.closeSync(guardDescriptor);
            } catch {}
            try {
                fs.unlinkSync(guardPath);
            } catch {}
        }
    }

    let released = false;
    return {
        owner,
        runId,
        dataDir: path.resolve(dataDir),
        markReady() {
            if (released) return;
            replaceOwnedRecord(lockPath, runId, (current) => {
                current.state = 'ready';
                current.readyAt = new Date().toISOString();
            });
        },
        release() {
            if (released) return;
            released = true;
            const current = readRecord(lockPath);
            if (!current || current.runId !== runId || current.pid !== process.pid) return;
            try {
                fs.unlinkSync(lockPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw new ProcessLockError('lock_failed', 'Runtime ownership could not be released.');
                }
            }
        },
    };
}
