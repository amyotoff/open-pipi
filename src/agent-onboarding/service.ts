import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    getOwnerContextPath,
    readOwnerContext,
    saveOwnerContextIfRevision,
    type OwnerContextInput,
    type StoredOwnerContext,
} from '../setup/owner-context';

const LEDGER_FILE = 'agent-onboarding.json';
const LOCK_FILE = 'agent-onboarding.lock';
const PREVIEW_TTL_MS = 30 * 60 * 1_000;
const MAX_RECORDS = 100;
const MAX_FACTS = 5;
const MAX_FACT_LENGTH = 240;
const MAX_TASK_LENGTH = 500;
const MAX_LEDGER_BYTES = 1_000_000;

export type AgentOnboardingDraft = {
    language: string;
    timezone: string;
    facts?: string[];
    currentTask?: string;
};

export type AgentOnboardingDiff = Array<{
    field: keyof OwnerContextInput;
    before?: string | string[];
    after?: string | string[];
}>;

export type AgentOnboardingPreview = {
    schemaVersion: 1;
    previewId: string;
    previewHash: string;
    createdAt: string;
    expiresAt: string;
    baseRevision: string | null;
    ownerContext: OwnerContextInput;
    diff: AgentOnboardingDiff;
    effects: { ownerContextWrite: true; runtimeCalls: false; providerCalls: false };
    state: 'awaiting_confirmation' | 'applied' | 'expired';
};

export type AgentOnboardingApplyInput = {
    previewId: string;
    previewHash: string;
    idempotencyKey: string;
};

export type AgentOnboardingApplyResult = {
    schemaVersion: 1;
    previewId: string;
    previewHash: string;
    state: 'applied';
    appliedAt: string;
    ownerContext: StoredOwnerContext;
};

export type AgentOnboardingState = {
    schemaVersion: 1;
    state: 'not_configured' | 'configured' | 'awaiting_confirmation' | 'applied' | 'expired';
    ownerContext: StoredOwnerContext | null;
    preview?: AgentOnboardingPreview;
    currentMatchesPreview?: boolean;
};

export type AgentOnboardingErrorCode =
    | 'VALIDATION_FAILED'
    | 'PREVIEW_NOT_FOUND'
    | 'PREVIEW_EXPIRED'
    | 'PREVIEW_HASH_MISMATCH'
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'LEDGER_UNAVAILABLE';

export class AgentOnboardingError extends Error {
    constructor(
        public readonly code: AgentOnboardingErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'AgentOnboardingError';
    }
}

export interface AgentOnboardingService {
    readState(previewId?: string): AgentOnboardingState;
    preview(input: unknown): AgentOnboardingPreview;
    /** Call only behind the existing authenticated human session and CSRF-protected endpoint. */
    confirmAndApply(input: AgentOnboardingApplyInput): AgentOnboardingApplyResult;
}

type Ledger = {
    version: 1;
    previews: AgentOnboardingPreview[];
    applications: Array<{
        idempotencyKey: string;
        previewId: string;
        previewHash: string;
        result: AgentOnboardingApplyResult;
    }>;
    attempts: Array<{
        idempotencyKey: string;
        previewId: string;
        previewHash: string;
        startedAt: string;
    }>;
};

function failValidation(message: string): never {
    throw new AgentOnboardingError('VALIDATION_FAILED', message);
}

function parseDraft(input: unknown): AgentOnboardingDraft {
    if (!input || typeof input !== 'object' || Array.isArray(input)) failValidation('Draft must be an object.');
    const record = input as Record<string, unknown>;
    const allowed = new Set(['language', 'timezone', 'facts', 'currentTask']);
    if (Object.keys(record).some((key) => !allowed.has(key))) failValidation('Draft contains an unknown field.');
    if (typeof record.language !== 'string' || typeof record.timezone !== 'string') {
        failValidation('Language and timezone are required.');
    }
    const language = record.language.trim();
    const timezone = record.timezone.trim();
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) failValidation('Language is invalid.');
    try {
        new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
        failValidation('Timezone is invalid.');
    }
    let facts: string[] | undefined;
    if (record.facts !== undefined) {
        if (!Array.isArray(record.facts) || record.facts.length > MAX_FACTS) failValidation('Facts are invalid.');
        facts = record.facts.map((value) => {
            if (typeof value !== 'string') failValidation('Facts are invalid.');
            const fact = value.trim();
            if (!fact || fact.length > MAX_FACT_LENGTH || fact.includes('\0')) failValidation('Facts are invalid.');
            return fact;
        });
    }
    let currentTask: string | undefined;
    if (record.currentTask !== undefined) {
        if (typeof record.currentTask !== 'string') failValidation('Current task is invalid.');
        const task = record.currentTask.trim();
        if (task.length > MAX_TASK_LENGTH || task.includes('\0')) failValidation('Current task is invalid.');
        currentTask = task;
    }
    return {
        language,
        timezone,
        ...(facts !== undefined ? { facts } : {}),
        ...(currentTask !== undefined ? { currentTask } : {}),
    };
}

function exactContext(draft: AgentOnboardingDraft, current: StoredOwnerContext | null): OwnerContextInput {
    return {
        language: draft.language,
        timezone: draft.timezone,
        ...(current?.displayName ? { displayName: current.displayName } : {}),
        ...(draft.facts !== undefined
            ? draft.facts.length
                ? { facts: draft.facts }
                : {}
            : current?.facts
              ? { facts: current.facts }
              : {}),
        ...(Object.prototype.hasOwnProperty.call(draft, 'currentTask')
            ? draft.currentTask
                ? { currentTask: draft.currentTask }
                : {}
            : current?.currentTask
              ? { currentTask: current.currentTask }
              : {}),
    };
}

function contextValues(context: OwnerContextInput | StoredOwnerContext | null): Partial<OwnerContextInput> {
    if (!context) return {};
    return {
        language: context.language,
        timezone: context.timezone,
        ...(context.displayName ? { displayName: context.displayName } : {}),
        ...(context.facts ? { facts: context.facts } : {}),
        ...(context.currentTask ? { currentTask: context.currentTask } : {}),
    };
}

function contextsEqual(left: OwnerContextInput | StoredOwnerContext | null, right: OwnerContextInput): boolean {
    return JSON.stringify(contextValues(left)) === JSON.stringify(contextValues(right));
}

function readCurrentOwnerContext(dataDir: string): StoredOwnerContext | null {
    const current = readOwnerContext(dataDir);
    if (current) return current;
    try {
        fs.lstatSync(getOwnerContextPath(dataDir));
        throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Existing owner context is unsafe or unreadable.');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

function buildDiff(current: StoredOwnerContext | null, planned: OwnerContextInput): AgentOnboardingDiff {
    const before = contextValues(current);
    const after = contextValues(planned);
    return (['language', 'timezone', 'displayName', 'facts', 'currentTask'] as const).flatMap((field) =>
        JSON.stringify(before[field]) === JSON.stringify(after[field])
            ? []
            : [
                  {
                      field,
                      ...(before[field] !== undefined ? { before: before[field] } : {}),
                      ...(after[field] !== undefined ? { after: after[field] } : {}),
                  },
              ]
    );
}

function hashPreview(preview: Omit<AgentOnboardingPreview, 'previewHash' | 'state'>): string {
    return createHash('sha256').update(JSON.stringify(preview)).digest('hex');
}

function previewCore(preview: AgentOnboardingPreview): Omit<AgentOnboardingPreview, 'previewHash' | 'state'> {
    const { previewHash: _hash, state: _state, ...core } = preview;
    void _hash;
    void _state;
    return core;
}

function emptyLedger(): Ledger {
    return { version: 1, previews: [], applications: [], attempts: [] };
}

function ensurePrivateRoot(dataDir: string): string {
    const root = path.resolve(dataDir);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Onboarding data directory is unsafe.');
    }
    return root;
}

function readLedger(root: string): Ledger {
    const ledgerPath = path.join(root, LEDGER_FILE);
    try {
        const stat = fs.lstatSync(ledgerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('unsafe');
        if (stat.size > MAX_LEDGER_BYTES) throw new Error('oversized');
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('wrong owner');
        const value = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Partial<Ledger>;
        if (
            value.version !== 1 ||
            !Array.isArray(value.previews) ||
            !Array.isArray(value.applications) ||
            !Array.isArray(value.attempts) ||
            value.previews.length > MAX_RECORDS ||
            value.applications.length > MAX_RECORDS ||
            value.attempts.length > MAX_RECORDS ||
            value.previews.some(
                (preview) =>
                    !preview ||
                    typeof preview !== 'object' ||
                    typeof preview.previewId !== 'string' ||
                    typeof preview.previewHash !== 'string' ||
                    hashPreview(previewCore(preview)) !== preview.previewHash
            )
        ) {
            throw new Error('invalid');
        }
        return value as Ledger;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
        throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Onboarding state could not be read.');
    }
}

function writeLedger(root: string, ledger: Ledger): void {
    const target = path.join(root, LEDGER_FILE);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(
            temporary,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
            0o600
        );
        fs.writeFileSync(descriptor, `${JSON.stringify(ledger)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, target);
        fs.chmodSync(target, 0o600);
    } catch {
        throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Onboarding state could not be written.');
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

function withLedgerLock<T>(root: string, action: () => T): T {
    const lockPath = path.join(root, LOCK_FILE);
    let descriptor: number | undefined;
    const deadline = Date.now() + 2_000;
    while (descriptor === undefined) {
        try {
            descriptor = fs.openSync(
                lockPath,
                fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
                0o600
            );
            fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
            fs.fsyncSync(descriptor);
        } catch (error) {
            if (descriptor !== undefined) {
                try {
                    fs.closeSync(descriptor);
                } catch {}
                descriptor = undefined;
                try {
                    fs.unlinkSync(lockPath);
                } catch {}
            }
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) {
                throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Another onboarding operation is in progress.');
            }
            try {
                const stat = fs.lstatSync(lockPath);
                if (!stat.isFile() || stat.isSymbolicLink()) {
                    throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Onboarding lock path is unsafe.');
                }
            } catch (inspectionError) {
                if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw inspectionError;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    try {
        return action();
    } finally {
        fs.closeSync(descriptor);
        try {
            fs.unlinkSync(lockPath);
        } catch {}
    }
}

function requireBoundedIdentifier(value: unknown, label: string, minimum = 1): string {
    if (
        typeof value !== 'string' ||
        value.length < minimum ||
        value.length > 200 ||
        !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
        failValidation(`${label} is invalid.`);
    }
    return value;
}

export function createAgentOnboardingService(options: { dataDir: string; now?: () => Date }): AgentOnboardingService {
    const root = ensurePrivateRoot(options.dataDir);
    const now = options.now ?? (() => new Date());

    return {
        readState(previewId?: string): AgentOnboardingState {
            const ownerContext = readCurrentOwnerContext(root);
            const ledger = readLedger(root);
            const preview = previewId
                ? ledger.previews.find((candidate) => candidate.previewId === previewId)
                : ledger.previews.at(-1);
            if (!preview && !previewId) {
                return { schemaVersion: 1, state: ownerContext ? 'configured' : 'not_configured', ownerContext };
            }
            if (!preview) throw new AgentOnboardingError('PREVIEW_NOT_FOUND', 'Preview was not found.');
            const visiblePreview =
                preview.state === 'awaiting_confirmation' && now().getTime() >= Date.parse(preview.expiresAt)
                    ? { ...preview, state: 'expired' as const }
                    : preview;
            return {
                schemaVersion: 1,
                state: visiblePreview.state,
                ownerContext,
                preview: visiblePreview,
                ...(visiblePreview.state === 'applied'
                    ? { currentMatchesPreview: contextsEqual(ownerContext, visiblePreview.ownerContext) }
                    : {}),
            };
        },

        preview(input: unknown): AgentOnboardingPreview {
            const draft = parseDraft(input);
            return withLedgerLock(root, () => {
                const current = readCurrentOwnerContext(root);
                const ownerContext = exactContext(draft, current);
                const createdAt = now();
                const core: Omit<AgentOnboardingPreview, 'previewHash' | 'state'> = {
                    schemaVersion: 1,
                    previewId: randomUUID(),
                    createdAt: createdAt.toISOString(),
                    expiresAt: new Date(createdAt.getTime() + PREVIEW_TTL_MS).toISOString(),
                    baseRevision: current?.revision ?? null,
                    ownerContext,
                    diff: buildDiff(current, ownerContext),
                    effects: { ownerContextWrite: true, runtimeCalls: false, providerCalls: false },
                };
                const preview: AgentOnboardingPreview = {
                    ...core,
                    previewHash: hashPreview(core),
                    state: 'awaiting_confirmation',
                };
                const ledger = readLedger(root);
                if (ledger.previews.length >= MAX_RECORDS) {
                    const removable = ledger.previews.findIndex(
                        (candidate) =>
                            candidate.state !== 'awaiting_confirmation' ||
                            createdAt.getTime() >= Date.parse(candidate.expiresAt)
                    );
                    if (removable < 0) {
                        throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Too many active previews.');
                    }
                    ledger.previews.splice(removable, 1);
                }
                ledger.previews.push(preview);
                ledger.applications = ledger.applications.slice(-MAX_RECORDS);
                writeLedger(root, ledger);
                return preview;
            });
        },

        confirmAndApply(input: AgentOnboardingApplyInput): AgentOnboardingApplyResult {
            if (!input || typeof input !== 'object' || Array.isArray(input)) failValidation('Apply input is invalid.');
            if (Object.keys(input).some((key) => !['previewId', 'previewHash', 'idempotencyKey'].includes(key))) {
                failValidation('Apply input contains an unknown field.');
            }
            const previewId = requireBoundedIdentifier(input.previewId, 'Preview ID');
            const previewHash = requireBoundedIdentifier(input.previewHash, 'Preview hash');
            const idempotencyKey = requireBoundedIdentifier(input.idempotencyKey, 'Idempotency key', 8);
            return withLedgerLock(root, () => {
                const ledger = readLedger(root);
                const prior = ledger.applications.find((application) => application.idempotencyKey === idempotencyKey);
                if (prior) {
                    if (prior.previewId !== previewId || prior.previewHash !== previewHash) {
                        throw new AgentOnboardingError(
                            'IDEMPOTENCY_KEY_REUSED',
                            'Idempotency key was already used for another preview.'
                        );
                    }
                    return prior.result;
                }
                const attempt = ledger.attempts.find((candidate) => candidate.idempotencyKey === idempotencyKey);
                if (attempt && (attempt.previewId !== previewId || attempt.previewHash !== previewHash)) {
                    throw new AgentOnboardingError(
                        'IDEMPOTENCY_KEY_REUSED',
                        'Idempotency key was already used for another preview.'
                    );
                }
                const preview = ledger.previews.find((candidate) => candidate.previewId === previewId);
                if (!preview) throw new AgentOnboardingError('PREVIEW_NOT_FOUND', 'Preview was not found.');
                if (preview.previewHash !== previewHash || hashPreview(previewCore(preview)) !== previewHash) {
                    throw new AgentOnboardingError('PREVIEW_HASH_MISMATCH', 'Preview content does not match its hash.');
                }
                let current = readCurrentOwnerContext(root);
                const completedAttempt = Boolean(
                    attempt &&
                    current &&
                    current.revision !== preview.baseRevision &&
                    contextsEqual(current, preview.ownerContext)
                );
                if (now().getTime() >= Date.parse(preview.expiresAt) && !completedAttempt) {
                    throw new AgentOnboardingError('PREVIEW_EXPIRED', 'Preview has expired.');
                }
                let saved: StoredOwnerContext;
                if ((current?.revision ?? null) !== preview.baseRevision) {
                    if (!attempt || !current || !contextsEqual(current, preview.ownerContext)) {
                        throw new AgentOnboardingError('VERSION_CONFLICT', 'Owner context changed after preview.');
                    }
                    saved = current;
                } else {
                    if (!attempt) {
                        if (ledger.attempts.length >= MAX_RECORDS) {
                            throw new AgentOnboardingError('LEDGER_UNAVAILABLE', 'Too many incomplete apply attempts.');
                        }
                        ledger.attempts.push({
                            idempotencyKey,
                            previewId,
                            previewHash,
                            startedAt: now().toISOString(),
                        });
                        writeLedger(root, ledger);
                    }
                    const applied = saveOwnerContextIfRevision(
                        root,
                        {
                            ...preview.ownerContext,
                            facts: preview.ownerContext.facts ?? [],
                            currentTask: preview.ownerContext.currentTask ?? '',
                        },
                        preview.baseRevision
                    );
                    if (!applied) {
                        current = readCurrentOwnerContext(root);
                        if (!current || !contextsEqual(current, preview.ownerContext)) {
                            throw new AgentOnboardingError('VERSION_CONFLICT', 'Owner context changed after preview.');
                        }
                        saved = current;
                    } else {
                        saved = applied;
                    }
                }

                const appliedAt = now().toISOString();
                const result: AgentOnboardingApplyResult = {
                    schemaVersion: 1,
                    previewId,
                    previewHash,
                    state: 'applied',
                    appliedAt,
                    ownerContext: saved,
                };
                preview.state = 'applied';
                ledger.applications.push({ idempotencyKey, previewId, previewHash, result });
                ledger.applications = ledger.applications.slice(-MAX_RECORDS);
                ledger.attempts = ledger.attempts.filter((candidate) => candidate.idempotencyKey !== idempotencyKey);
                writeLedger(root, ledger);
                return result;
            });
        },
    };
}
