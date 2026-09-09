import fs from 'node:fs';
import path from 'node:path';
import { readProcessLock, type ProcessLockStatus } from './process-lock';

const EVIDENCE_FILE = 'setup-dialogue-evidence.json';

type AcceptedDialogue = {
    correlationId: string;
    ownerTelegramId: string;
    endpointId: string;
    acceptedAt: string;
};

type DeliveredDialogue = AcceptedDialogue & {
    deliveredAt: string;
};

type DialogueEvidence = {
    version: 1;
    runId: string;
    accepted: AcceptedDialogue[];
    delivered?: DeliveredDialogue;
};

const MAX_PENDING_TURNS = 8;

let activeRuntime: { dataDir: string; runId: string } | null = null;

export function getDialogueEvidencePath(dataDir: string): string {
    return path.join(path.resolve(dataDir), EVIDENCE_FILE);
}

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\r\n\0]/.test(value);
}

function parseEvidence(value: unknown): DialogueEvidence | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Partial<DialogueEvidence>;
    if (record.version !== 1 || !isSafeId(record.runId)) return null;

    const accepted = record.accepted;
    if (!Array.isArray(accepted) || accepted.length > MAX_PENDING_TURNS) return null;
    if (
        accepted.some(
            (turn) =>
                !isSafeId(turn?.correlationId) ||
                !isSafeId(turn?.ownerTelegramId) ||
                !isSafeId(turn?.endpointId) ||
                typeof turn?.acceptedAt !== 'string'
        )
    )
        return null;

    const delivered = record.delivered;
    if (
        delivered !== undefined &&
        (!isSafeId(delivered.correlationId) ||
            !isSafeId(delivered.ownerTelegramId) ||
            !isSafeId(delivered.endpointId) ||
            typeof delivered.acceptedAt !== 'string' ||
            typeof delivered.deliveredAt !== 'string')
    ) {
        return null;
    }

    return record as DialogueEvidence;
}

function readEvidence(dataDir: string): DialogueEvidence | null {
    const evidencePath = getDialogueEvidencePath(dataDir);
    try {
        const stat = fs.lstatSync(evidencePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        return parseEvidence(JSON.parse(fs.readFileSync(evidencePath, 'utf8')));
    } catch {
        return null;
    }
}

function writeEvidence(dataDir: string, evidence: DialogueEvidence): void {
    const root = path.resolve(dataDir);
    const target = getDialogueEvidencePath(root);
    const temporary = `${target}.${process.pid}.${evidence.runId}.tmp`;
    let descriptor: number | undefined;

    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        descriptor = fs.openSync(
            temporary,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
            0o600
        );
        fs.writeFileSync(descriptor, `${JSON.stringify(evidence)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, target);
        fs.chmodSync(target, 0o600);
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {}
        }
        try {
            fs.unlinkSync(temporary);
        } catch {}
    }
}

/** Start a clean proof record for the exact runtime lock acquired at boot. */
export function initializeDialogueEvidence(dataDir: string, runId: string): void {
    if (!isSafeId(runId)) throw new Error('A valid runtime run id is required for dialogue evidence.');
    const resolvedDataDir = path.resolve(dataDir);
    activeRuntime = { dataDir: resolvedDataDir, runId };
    writeEvidence(resolvedDataDir, { version: 1, runId, accepted: [] });
}

/** Record only a normal owner text turn that reached the assistant path. */
export function markDialogueAccepted(input: {
    transport: string;
    endpointType: string;
    endpointId: string;
    ownerTelegramId: string;
    correlationId: string;
}): boolean {
    if (!activeRuntime) return false;
    if (input.transport !== 'telegram' || input.endpointType !== 'direct') return false;
    if (input.endpointId !== input.ownerTelegramId) return false;
    if (![input.endpointId, input.ownerTelegramId, input.correlationId].every(isSafeId)) return false;

    const current = readEvidence(activeRuntime.dataDir);
    if (!current || current.runId !== activeRuntime.runId) return false;
    if (current.delivered) return true;
    const accepted: AcceptedDialogue = {
        correlationId: input.correlationId,
        ownerTelegramId: input.ownerTelegramId,
        endpointId: input.endpointId,
        acceptedAt: new Date().toISOString(),
    };
    const pending = current.accepted.filter((turn) => turn.correlationId !== input.correlationId);
    try {
        writeEvidence(activeRuntime.dataDir, {
            version: 1,
            runId: activeRuntime.runId,
            accepted: [...pending, accepted].slice(-MAX_PENDING_TURNS),
        });
        return true;
    } catch {
        return false;
    }
}

/** Record delivery only when it answers the accepted turn at the same private endpoint. */
export function markDialogueDelivered(input: {
    transport: string;
    endpointType: string;
    endpointId: string;
    correlationId: string | null;
}): boolean {
    if (!activeRuntime || input.transport !== 'telegram' || input.endpointType !== 'direct') return false;
    if (!input.correlationId) return false;

    const current = readEvidence(activeRuntime.dataDir);
    if (current?.delivered) return true;
    const accepted = current?.accepted.find(
        (turn) => turn.correlationId === input.correlationId && turn.endpointId === input.endpointId
    );
    if (!current || current.runId !== activeRuntime.runId || !accepted) {
        return false;
    }

    try {
        writeEvidence(activeRuntime.dataDir, {
            ...current,
            delivered: { ...accepted, deliveredAt: new Date().toISOString() },
        });
        return true;
    } catch {
        return false;
    }
}

/** Verify a delivered conversation against the live runtime lock and configured owner. */
export function isDialogueVerified(
    dataDir: string,
    ownerTelegramIds: readonly string[],
    options: { readLock?: (dataDir: string) => ProcessLockStatus } = {}
): boolean {
    const owners = new Set(ownerTelegramIds.map((id) => id.trim()).filter(Boolean));
    if (owners.size === 0) return false;

    let lock;
    try {
        lock = (options.readLock || readProcessLock)(dataDir);
    } catch {
        return false;
    }
    if (!lock.held || lock.owner !== 'runtime' || lock.state !== 'ready' || !lock.runId) return false;

    const evidence = readEvidence(dataDir);
    const delivered = evidence?.delivered;
    return Boolean(
        evidence &&
        delivered &&
        evidence.runId === lock.runId &&
        evidence.accepted.some((turn) => turn.correlationId === delivered.correlationId) &&
        delivered.endpointId === delivered.ownerTelegramId &&
        owners.has(delivered.ownerTelegramId)
    );
}

export function resetDialogueEvidenceRuntimeForTests(): void {
    activeRuntime = null;
}
