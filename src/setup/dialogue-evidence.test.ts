import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { acquireProcessLock, readProcessLock, type ProcessLock } from './process-lock';
import {
    getDialogueEvidencePath,
    initializeDialogueEvidence,
    isDialogueVerified,
    markDialogueAccepted,
    markDialogueDelivered,
    resetDialogueEvidenceRuntimeForTests,
} from './dialogue-evidence';

let dataDir: string;
let lock: ProcessLock | undefined;
const readIdentity = () => ({ state: 'alive' as const, fingerprint: 'test-process-identity' });
const verified = (owners: string[]) =>
    isDialogueVerified(dataDir, owners, {
        readLock: (target) => readProcessLock(target, { readIdentity }),
    });

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-dialogue-'));
    lock = acquireProcessLock(dataDir, 'runtime', { readIdentity });
    initializeDialogueEvidence(dataDir, lock.runId);
    lock.markReady();
});

afterEach(() => {
    lock?.release();
    resetDialogueEvidenceRuntimeForTests();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

it('verifies a sent response to an accepted owner private text turn', () => {
    expect(
        markDialogueAccepted({
            transport: 'telegram',
            endpointType: 'direct',
            endpointId: '111',
            ownerTelegramId: '111',
            correlationId: 'turn-1',
        })
    ).toBe(true);
    expect(
        markDialogueDelivered({
            transport: 'telegram',
            endpointType: 'direct',
            endpointId: '111',
            correlationId: 'turn-1',
        })
    ).toBe(true);
    expect(verified(['111'])).toBe(true);

    const marker = fs.readFileSync(getDialogueEvidencePath(dataDir), 'utf8');
    expect(marker).not.toContain('hello');
    expect(fs.statSync(getDialogueEvidencePath(dataDir)).mode & 0o777).toBe(0o600);
});

it('does not accept groups, other owners, failed matches, or queued-only work', () => {
    expect(
        markDialogueAccepted({
            transport: 'telegram',
            endpointType: 'group',
            endpointId: '-100',
            ownerTelegramId: '111',
            correlationId: 'turn-1',
        })
    ).toBe(false);
    expect(
        markDialogueAccepted({
            transport: 'telegram',
            endpointType: 'direct',
            endpointId: '111',
            ownerTelegramId: '111',
            correlationId: 'turn-2',
        })
    ).toBe(true);
    expect(verified(['111'])).toBe(false);
    expect(
        markDialogueDelivered({
            transport: 'telegram',
            endpointType: 'direct',
            endpointId: '222',
            correlationId: 'turn-2',
        })
    ).toBe(false);
    expect(verified(['222'])).toBe(false);
});

it('rejects stale evidence from a prior runtime run', () => {
    markDialogueAccepted({
        transport: 'telegram',
        endpointType: 'direct',
        endpointId: '111',
        ownerTelegramId: '111',
        correlationId: 'turn-old',
    });
    markDialogueDelivered({
        transport: 'telegram',
        endpointType: 'direct',
        endpointId: '111',
        correlationId: 'turn-old',
    });
    lock?.release();

    lock = acquireProcessLock(dataDir, 'runtime', { readIdentity });
    lock.markReady();
    expect(verified(['111'])).toBe(false);
});

it('keeps a successful proof sticky for the rest of the same runtime run', () => {
    markDialogueAccepted({
        transport: 'telegram',
        endpointType: 'direct',
        endpointId: '111',
        ownerTelegramId: '111',
        correlationId: 'turn-1',
    });
    markDialogueDelivered({
        transport: 'telegram',
        endpointType: 'direct',
        endpointId: '111',
        correlationId: 'turn-1',
    });

    markDialogueAccepted({
        transport: 'telegram',
        endpointType: 'direct',
        endpointId: '111',
        ownerTelegramId: '111',
        correlationId: 'turn-2',
    });

    expect(verified(['111'])).toBe(true);
});

it('tracks a bounded set of rapid turns until any matching response is delivered', () => {
    for (let index = 1; index <= 9; index += 1) {
        markDialogueAccepted({
            transport: 'telegram',
            endpointType: 'direct',
            endpointId: '111',
            ownerTelegramId: '111',
            correlationId: `turn-${index}`,
        });
    }

    expect(
        markDialogueDelivered({
            transport: 'telegram',
            endpointType: 'direct',
            endpointId: '111',
            correlationId: 'turn-1',
        })
    ).toBe(false);
    expect(
        markDialogueDelivered({
            transport: 'telegram',
            endpointType: 'direct',
            endpointId: '111',
            correlationId: 'turn-2',
        })
    ).toBe(true);
});
