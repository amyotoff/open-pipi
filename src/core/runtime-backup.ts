import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb } from '../db';

const BACKUPS_DIRNAME = 'backups';
const BACKUP_PAYLOAD_DIRNAME = 'payload';
const BACKUP_MANIFEST_FILENAME = 'manifest.json';
const DEFAULT_RETENTION_COUNT = 7;

export interface RuntimeBackupFileEntry {
    path: string;
    size: number;
    sha256: string;
}

export interface RuntimeBackupManifest {
    id: string;
    kind: 'scheduled' | 'manual' | 'pre_restore' | 'startup';
    health_status: 'unknown' | 'healthy';
    created_at: string;
    app_version: string;
    payload_dir: string;
    data_dir: string;
    db_path: string;
    db_relative_path: string;
    file_count: number;
    total_bytes: number;
    counts: {
        spaces: number;
        memory_entries: number;
        tasks: number;
        artifacts: number;
        grounding_overrides: number;
    };
    warnings: string[];
    files: RuntimeBackupFileEntry[];
}

function appVersion(): string {
    return process.env.npm_package_version || '2.5.0';
}

function nowIso(): string {
    return new Date().toISOString();
}

function backupId(now: string): string {
    return `backup-${now.replace(/[:.]/g, '-')}`;
}

function backupsRoot(): string {
    return path.join(dataDir(), BACKUPS_DIRNAME);
}

function dataDir(): string {
    return process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
}

function dbPath(): string {
    return process.env.DB_PATH || path.join(dataDir(), 'open-pipi.db');
}

function manifestPathForBackup(root: string): string {
    return path.join(root, BACKUP_MANIFEST_FILENAME);
}

function payloadRootForBackup(root: string): string {
    return path.join(root, BACKUP_PAYLOAD_DIRNAME);
}

function isPathInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveDbRelativePath(warnings: string[]): string {
    if (isPathInside(dataDir(), dbPath())) {
        return path.relative(dataDir(), dbPath()) || path.basename(dbPath());
    }

    warnings.push(`Database path "${dbPath()}" is outside DATA_DIR; restore will place it inside "__external_db/".`);
    return path.join('__external_db', path.basename(dbPath()));
}

function shouldSkipDataEntry(sourcePath: string): boolean {
    const resolved = path.resolve(sourcePath);
    const resolvedDb = path.resolve(dbPath());
    if (resolved === path.resolve(backupsRoot())) return true;
    if (resolved === resolvedDb) return true;
    if (resolved === `${resolvedDb}-wal`) return true;
    if (resolved === `${resolvedDb}-shm`) return true;
    return false;
}

function copyDataEntries(payloadRoot: string): void {
    fs.mkdirSync(payloadRoot, { recursive: true });

    for (const entry of fs.readdirSync(dataDir())) {
        const sourcePath = path.join(dataDir(), entry);
        if (shouldSkipDataEntry(sourcePath)) {
            continue;
        }

        fs.cpSync(sourcePath, path.join(payloadRoot, entry), { recursive: true });
    }
}

async function copyDatabaseSnapshot(payloadRoot: string, dbRelativePath: string): Promise<void> {
    const dbBackupPath = path.join(payloadRoot, dbRelativePath);
    fs.mkdirSync(path.dirname(dbBackupPath), { recursive: true });
    await getDb().backup(dbBackupPath);
}

function hashFile(filePath: string): string {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function collectPayloadFiles(root: string, currentRoot: string = root): RuntimeBackupFileEntry[] {
    const entries: RuntimeBackupFileEntry[] = [];

    for (const entry of fs.readdirSync(currentRoot, { withFileTypes: true })) {
        const fullPath = path.join(currentRoot, entry.name);
        if (entry.isDirectory()) {
            entries.push(...collectPayloadFiles(root, fullPath));
            continue;
        }

        const stats = fs.statSync(fullPath);
        entries.push({
            path: path.relative(root, fullPath).split(path.sep).join(path.posix.sep),
            size: stats.size,
            sha256: hashFile(fullPath),
        });
    }

    return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function backupCounts() {
    const db = getDb();
    const count = (table: string) =>
        (db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number } | undefined)?.cnt || 0;

    return {
        spaces: count('spaces'),
        memory_entries: count('memory_entries'),
        tasks: count('tasks'),
        artifacts: count('artifacts'),
        grounding_overrides: count('grounding_overrides'),
    };
}

function parseRetentionCount(): number {
    const raw = Number(process.env.BACKUP_RETENTION_COUNT || DEFAULT_RETENTION_COUNT);
    return Number.isFinite(raw) && raw >= 1 ? Math.round(raw) : DEFAULT_RETENTION_COUNT;
}

function readManifest(root: string): RuntimeBackupManifest | null {
    const manifestPath = manifestPathForBackup(root);
    if (!fs.existsSync(manifestPath)) return null;

    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RuntimeBackupManifest;
    } catch {
        return null;
    }
}

export function listRuntimeBackups(limit: number = 20): RuntimeBackupManifest[] {
    const root = backupsRoot();
    if (!fs.existsSync(root)) return [];

    return fs
        .readdirSync(root)
        .map((entry) => readManifest(path.join(root, entry)))
        .filter((entry): entry is RuntimeBackupManifest => Boolean(entry))
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, Math.max(limit, 1));
}

export function getLatestRuntimeBackup(): RuntimeBackupManifest | null {
    return listRuntimeBackups(1)[0] || null;
}

export function getLatestHealthyRuntimeBackup(): RuntimeBackupManifest | null {
    return listRuntimeBackups(1000).find((backup) => backup.health_status === 'healthy') || null;
}

function pruneOldBackups(): void {
    const keepCount = parseRetentionCount();
    const root = backupsRoot();
    if (!fs.existsSync(root)) return;

    const backups = listRuntimeBackups(1000);
    for (const backup of backups.slice(keepCount)) {
        fs.rmSync(path.join(root, backup.id), { recursive: true, force: true });
    }
}

export async function createRuntimeBackup(
    kind: RuntimeBackupManifest['kind'] = 'manual',
    options?: {
        healthStatus?: RuntimeBackupManifest['health_status'];
    }
): Promise<RuntimeBackupManifest> {
    const warnings: string[] = [];
    const createdAt = nowIso();
    const id = backupId(createdAt);
    const root = backupsRoot();
    const finalRoot = path.join(root, id);
    const tempRoot = `${finalRoot}.tmp-${Date.now()}`;
    const payloadRoot = payloadRootForBackup(tempRoot);
    const dbRelativePath = resolveDbRelativePath(warnings);

    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });

    copyDataEntries(payloadRoot);
    await copyDatabaseSnapshot(payloadRoot, dbRelativePath);

    const files = collectPayloadFiles(payloadRoot);
    const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
    const counts = backupCounts();
    const manifest: RuntimeBackupManifest = {
        id,
        kind,
        health_status: options?.healthStatus || 'unknown',
        created_at: createdAt,
        app_version: appVersion(),
        payload_dir: BACKUP_PAYLOAD_DIRNAME,
        data_dir: dataDir(),
        db_path: dbPath(),
        db_relative_path: dbRelativePath.split(path.sep).join(path.posix.sep),
        file_count: files.length,
        total_bytes: totalBytes,
        counts,
        warnings,
        files,
    };

    fs.writeFileSync(manifestPathForBackup(tempRoot), JSON.stringify(manifest, null, 2));
    fs.rmSync(finalRoot, { recursive: true, force: true });
    fs.renameSync(tempRoot, finalRoot);
    pruneOldBackups();

    return manifest;
}

export async function ensureHealthyRestorePoint(): Promise<RuntimeBackupManifest> {
    const latestHealthy = getLatestHealthyRuntimeBackup();
    const now = Date.now();
    const HEALTHY_RESTORE_POINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

    if (
        latestHealthy &&
        latestHealthy.app_version === appVersion() &&
        now - new Date(latestHealthy.created_at).getTime() < HEALTHY_RESTORE_POINT_MAX_AGE_MS
    ) {
        return latestHealthy;
    }

    return createRuntimeBackup('startup', { healthStatus: 'healthy' });
}
