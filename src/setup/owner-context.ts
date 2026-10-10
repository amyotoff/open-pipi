import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const OWNER_CONTEXT_FILE = 'setup-owner-context.json';
const MAX_FACTS = 5;
const MAX_FACT_LENGTH = 240;
const MAX_TASK_LENGTH = 500;
const OWNER_CONTEXT_LOCK_FILE = `${OWNER_CONTEXT_FILE}.lock`;
const LOCK_WAIT_MS = 2_000;

export const SETUP_OWNER_CONTEXT_SUBJECT = 'Owner setup context';
export const SETUP_OWNER_CONTEXT_SOURCE = 'setup-owner-context';
export const EMPTY_OWNER_CONTEXT_MARKER = '[Setup owner context intentionally empty.]';

export type OwnerContextInput = {
    language: string;
    timezone: string;
    displayName?: string;
    facts?: string[];
    currentTask?: string;
};

export type StoredOwnerContext = OwnerContextInput & {
    version: 1;
    revision: string;
    updatedAt: string;
    applied?: { revision: string; spaceId: string; appliedAt: string };
};

export type OwnerSetupStatus = {
    currentPack?: string;
    characterCustomized?: boolean;
    profilePresent?: boolean;
    language?: string;
    timezone?: string;
    preferencesPending?: boolean;
};

export function getOwnerContextPath(dataDir: string): string {
    return path.join(path.resolve(dataDir), OWNER_CONTEXT_FILE);
}

function trimmed(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return normalized && normalized.length <= max && !normalized.includes('\0') ? normalized : undefined;
}

function validLanguage(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value);
}

function validTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || !value.trim()) return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value.trim() }).format();
        return true;
    } catch {
        return false;
    }
}

function parseStoredOwnerContext(value: unknown): StoredOwnerContext | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Partial<StoredOwnerContext>;
    if (
        record.version !== 1 ||
        typeof record.revision !== 'string' ||
        !validLanguage(record.language) ||
        !validTimeZone(record.timezone) ||
        typeof record.updatedAt !== 'string'
    ) {
        return null;
    }
    if (record.displayName !== undefined && !trimmed(record.displayName, 120)) return null;
    if (
        record.facts !== undefined &&
        (!Array.isArray(record.facts) ||
            record.facts.length > MAX_FACTS ||
            record.facts.some((fact) => !trimmed(fact, MAX_FACT_LENGTH)))
    ) {
        return null;
    }
    if (record.currentTask !== undefined && !trimmed(record.currentTask, MAX_TASK_LENGTH)) return null;
    if (
        record.applied !== undefined &&
        (record.applied.revision !== record.revision ||
            !trimmed(record.applied.spaceId, 200) ||
            typeof record.applied.appliedAt !== 'string')
    ) {
        return null;
    }
    return record as StoredOwnerContext;
}

export function readOwnerContext(dataDir: string): StoredOwnerContext | null {
    const contextPath = getOwnerContextPath(dataDir);
    try {
        const stat = fs.lstatSync(contextPath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
        return parseStoredOwnerContext(JSON.parse(fs.readFileSync(contextPath, 'utf8')));
    } catch {
        return null;
    }
}

function writeOwnerContext(dataDir: string, context: StoredOwnerContext): void {
    const root = path.resolve(dataDir);
    const target = getOwnerContextPath(root);
    const temporary = `${target}.${process.pid}.${context.revision}.tmp`;
    let descriptor: number | undefined;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
        descriptor = fs.openSync(
            temporary,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
            0o600
        );
        fs.writeFileSync(descriptor, `${JSON.stringify(context)}\n`, 'utf8');
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

function assertSafeOwnerContextTarget(dataDir: string): void {
    try {
        const stat = fs.lstatSync(getOwnerContextPath(dataDir));
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
            throw new Error('Owner context path is unsafe.');
        }
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('Owner context path has an unexpected owner.');
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

function sleepSync(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withOwnerContextLock<T>(dataDir: string, action: () => T): T {
    const root = path.resolve(dataDir);
    const lockPath = path.join(root, OWNER_CONTEXT_LOCK_FILE);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let descriptor: number | undefined;

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
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const stat = fs.lstatSync(lockPath);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error('Owner context lock path is unsafe.', { cause: error });
            }
            if (Date.now() >= deadline) throw new Error('Owner context is busy.', { cause: error });
            sleepSync(10);
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

function validRevision(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildOwnerContext(
    input: OwnerContextInput,
    previous: StoredOwnerContext | null,
    revision: string = randomUUID()
): StoredOwnerContext {
    const language = input.language.trim();
    const timezone = input.timezone.trim();
    if (!validLanguage(language) || !validTimeZone(timezone)) throw new Error('Owner locale metadata is invalid.');

    const displayName = input.displayName === undefined ? previous?.displayName : trimmed(input.displayName, 120);
    const facts =
        input.facts === undefined
            ? previous?.facts
            : input.facts.map((fact) => trimmed(fact, MAX_FACT_LENGTH)).filter((fact): fact is string => !!fact);
    const currentTask =
        input.currentTask === undefined ? previous?.currentTask : trimmed(input.currentTask, MAX_TASK_LENGTH);
    if (input.facts !== undefined && (input.facts.length > MAX_FACTS || facts?.length !== input.facts.length)) {
        throw new Error('Owner context exceeds the supported bounds.');
    }
    if (!validRevision(revision)) throw new Error('Owner context revision is invalid.');

    return {
        version: 1,
        revision,
        updatedAt: new Date().toISOString(),
        language,
        timezone,
        ...(displayName ? { displayName } : {}),
        ...(facts?.length ? { facts } : {}),
        ...(currentTask ? { currentTask } : {}),
    };
}

/** Save bounded private context without requiring the runtime database to exist. */
export function saveOwnerContext(dataDir: string, input: OwnerContextInput): StoredOwnerContext {
    return withOwnerContextLock(dataDir, () => {
        assertSafeOwnerContextTarget(dataDir);
        const context = buildOwnerContext(input, readOwnerContext(dataDir));
        writeOwnerContext(dataDir, context);
        return context;
    });
}

/** Atomically save only when the private context still has the expected revision. */
export function saveOwnerContextIfRevision(
    dataDir: string,
    input: OwnerContextInput,
    expectedRevision: string | null,
    options?: { revision?: string }
): StoredOwnerContext | null {
    return withOwnerContextLock(dataDir, () => {
        assertSafeOwnerContextTarget(dataDir);
        const previous = readOwnerContext(dataDir);
        if ((previous?.revision ?? null) !== expectedRevision) return null;
        const context = buildOwnerContext(input, previous, options?.revision);
        writeOwnerContext(dataDir, context);
        return context;
    });
}

export function markOwnerContextApplied(dataDir: string, revision: string, spaceId: string): boolean {
    return withOwnerContextLock(dataDir, () => {
        assertSafeOwnerContextTarget(dataDir);
        const current = readOwnerContext(dataDir);
        if (!current || current.revision !== revision) return false;
        writeOwnerContext(dataDir, {
            ...current,
            applied: { revision, spaceId, appliedAt: new Date().toISOString() },
        });
        return true;
    });
}

function findDatabasePath(dataDir: string): string | null {
    for (const filename of ['open-pipi.db', 'pipi.db']) {
        const candidate = path.join(path.resolve(dataDir), filename);
        try {
            const stat = fs.lstatSync(candidate);
            if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
        } catch {}
    }
    return null;
}

function parsePolicy(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'string') return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function snapshotWasCustomized(
    dataDir: string,
    projectRoot: string | undefined,
    spaceId: string,
    packId: string
): boolean {
    if (!projectRoot) return false;
    const snapshotRoot = path.join(dataDir, 'space-behavior', Buffer.from(spaceId).toString('base64url'), 'pack');
    const installedRoot = path.join(projectRoot, 'src', 'packs', packId);
    for (const filename of ['agent.md', 'character.md', 'skills.md', 'tools.md']) {
        const snapshot = path.join(snapshotRoot, filename);
        const installed = path.join(installedRoot, filename);
        if (!fs.existsSync(snapshot)) continue;
        if (!fs.existsSync(installed)) return true;
        if (!fs.readFileSync(snapshot).equals(fs.readFileSync(installed))) return true;
    }
    return false;
}

/** Read only safe status fields from an existing database; never creates or migrates it. */
export function readOwnerSetupStatus(input: {
    dataDir: string;
    ownerTelegramIds: readonly string[];
    projectRoot?: string;
}): OwnerSetupStatus {
    const pending = readOwnerContext(input.dataDir);
    const preferencesPending = Boolean(pending && pending.applied?.revision !== pending.revision);
    const base: OwnerSetupStatus = {
        profilePresent: Boolean(pending?.displayName || pending?.facts?.length || pending?.currentTask),
        ...(pending?.language ? { language: pending.language } : {}),
        ...(pending?.timezone ? { timezone: pending.timezone } : {}),
        ...(pending ? { preferencesPending } : {}),
    };
    const ownerIds = [...new Set(input.ownerTelegramIds.map((id) => id.trim()).filter(Boolean))];
    const dbPath = findDatabasePath(input.dataDir);
    if (!dbPath) return base;
    if (ownerIds.length === 0) return base;

    let database: Database.Database | undefined;
    try {
        database = new Database(dbPath, { readonly: true, fileMustExist: true });
        database.pragma('query_only = ON');
        const placeholders = ownerIds.map(() => '?').join(', ');
        const hasBindings = Boolean(
            database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transport_bindings'").get()
        );
        const query = hasBindings
            ? `SELECT s.* FROM spaces s
               JOIN transport_bindings b ON b.space_id = s.id
               WHERE b.transport = 'telegram' AND b.endpoint_type = 'direct' AND b.status = 'active'
                 AND b.endpoint_id IN (${placeholders}) AND s.kind = 'direct_chat' AND s.status = 'ACTIVE'
               ORDER BY s.updated_at DESC LIMIT 1`
            : `SELECT s.* FROM spaces s
               WHERE s.channel = 'telegram' AND s.external_ref IN (${placeholders})
                 AND s.kind = 'direct_chat' AND s.status = 'ACTIVE'
               ORDER BY s.updated_at DESC LIMIT 1`;
        const space = database.prepare(query).get(...ownerIds) as
            | { id: string; assistant_pack_id: string; policy_json: string | null }
            | undefined;
        if (!space) return base;

        const policy = parsePolicy(space.policy_json);
        const language = preferencesPending ? pending?.language : trimmed(policy.default_language, 32) || base.language;
        const timezone = preferencesPending
            ? pending?.timezone
            : validTimeZone(policy.timezone)
              ? policy.timezone.trim()
              : base.timezone;
        const hasOverridesTable = Boolean(
            database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'grounding_overrides'").get()
        );
        const overrideCounts = hasOverridesTable
            ? (database
                  .prepare(
                      `SELECT SUM(CASE WHEN NOT (subject = ? AND created_by = ? AND content = ?) THEN 1 ELSE 0 END) AS count,
                              SUM(CASE WHEN kind = 'person' AND NOT (subject = ? AND created_by = ? AND content = ?) THEN 1 ELSE 0 END) AS profile_count
                       FROM grounding_overrides WHERE space_id = ? AND status = 'active'`
                  )
                  .get(
                      SETUP_OWNER_CONTEXT_SUBJECT,
                      SETUP_OWNER_CONTEXT_SOURCE,
                      EMPTY_OWNER_CONTEXT_MARKER,
                      SETUP_OWNER_CONTEXT_SUBJECT,
                      SETUP_OWNER_CONTEXT_SOURCE,
                      EMPTY_OWNER_CONTEXT_MARKER,
                      space.id
                  ) as { count: number | null; profile_count: number | null })
            : { count: 0, profile_count: 0 };
        const customized =
            space.assistant_pack_id !== 'jeeves' ||
            Number(overrideCounts.count) > 0 ||
            snapshotWasCustomized(input.dataDir, input.projectRoot, space.id, space.assistant_pack_id);
        return {
            currentPack: space.assistant_pack_id,
            characterCustomized: customized,
            profilePresent: base.profilePresent || Number(overrideCounts.profile_count) > 0,
            ...(language ? { language } : {}),
            ...(timezone ? { timezone } : {}),
            ...(pending ? { preferencesPending } : {}),
        };
    } catch {
        return base;
    } finally {
        database?.close();
    }
}
