import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';
import {
    createRuntimeBackup,
    getLatestHealthyRuntimeBackup,
    getLatestRuntimeBackup,
    RuntimeBackupManifest,
} from '../core/runtime-backup';

type ParsedArgs = {
    backupRef: string | null;
    targetDir: string;
    force: boolean;
};

function usage(): string {
    return [
        'Usage: ts-node src/scripts/restore-runtime-backup.ts <backup-id|path|latest|latest-healthy> [--target-dir <path>] [--force]',
        '',
        'Examples:',
        '  ts-node src/scripts/restore-runtime-backup.ts backup-2026-04-02T03-12-00-000Z',
        '  ts-node src/scripts/restore-runtime-backup.ts /srv/open-pipi/data/backups/backup-... --force',
    ].join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
    let backupRef: string | null = null;
    let targetDir = DATA_DIR;
    let force = false;

    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--target-dir') {
            targetDir = argv[index + 1] || targetDir;
            index += 1;
            continue;
        }
        if (value === '--force') {
            force = true;
            continue;
        }
        if (!backupRef) {
            backupRef = value;
        }
    }

    return {
        backupRef,
        targetDir: path.resolve(targetDir),
        force,
    };
}

function resolveBackupRoot(reference: string): string {
    if (reference === 'latest') {
        const latest = getLatestRuntimeBackup();
        if (!latest) {
            throw new Error('No restore points are available.');
        }
        return path.resolve(dataDir(), 'backups', latest.id);
    }

    if (reference === 'latest-healthy') {
        const latestHealthy = getLatestHealthyRuntimeBackup();
        if (!latestHealthy) {
            throw new Error('No healthy restore points are available.');
        }
        return path.resolve(dataDir(), 'backups', latestHealthy.id);
    }

    if (fs.existsSync(reference)) {
        return path.resolve(reference);
    }

    return path.resolve(dataDir(), 'backups', reference);
}

function dataDir(): string {
    return process.env.DATA_DIR || DATA_DIR;
}

function readManifest(backupRoot: string): RuntimeBackupManifest {
    const manifestPath = path.join(backupRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Backup manifest not found at ${manifestPath}`);
    }

    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RuntimeBackupManifest;
}

function ensureSafeToRestore(targetDir: string, force: boolean): void {
    if (!fs.existsSync(targetDir)) {
        return;
    }

    const entries = fs.readdirSync(targetDir);
    if (entries.length === 0) {
        return;
    }

    if (!force) {
        throw new Error(`Target directory ${targetDir} is not empty. Re-run with --force to replace it.`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.backupRef) {
        console.error(usage());
        process.exit(1);
    }

    const backupRoot = resolveBackupRoot(args.backupRef);
    if (!fs.existsSync(backupRoot)) {
        throw new Error(`Backup "${args.backupRef}" not found.`);
    }

    const manifest = readManifest(backupRoot);
    const payloadRoot = path.join(backupRoot, manifest.payload_dir);
    if (!fs.existsSync(payloadRoot)) {
        throw new Error(`Backup payload not found at ${payloadRoot}`);
    }

    ensureSafeToRestore(args.targetDir, args.force);

    if (
        args.targetDir === path.resolve(dataDir()) &&
        fs.existsSync(args.targetDir) &&
        fs.readdirSync(args.targetDir).length > 0
    ) {
        const preRestore = await createRuntimeBackup('pre_restore');
        console.log(`[RESTORE] Current runtime saved as ${preRestore.id} before restore.`);
    }

    const stagedTarget = `${args.targetDir}.restore-${Date.now()}`;
    const replacedTarget = `${args.targetDir}.replaced-${Date.now()}`;
    fs.rmSync(stagedTarget, { recursive: true, force: true });
    fs.cpSync(payloadRoot, stagedTarget, { recursive: true });

    if (fs.existsSync(args.targetDir)) {
        fs.renameSync(args.targetDir, replacedTarget);
    }
    fs.renameSync(stagedTarget, args.targetDir);

    console.log(`[RESTORE] Restored backup ${manifest.id} into ${args.targetDir}`);
    console.log(`[RESTORE] Backup created at ${manifest.created_at}; app version ${manifest.app_version}`);
    if (manifest.warnings.length > 0) {
        console.log(`[RESTORE] Warnings: ${manifest.warnings.join(' | ')}`);
    }
    if (fs.existsSync(replacedTarget)) {
        console.log(`[RESTORE] Previous target moved to ${replacedTarget}`);
    }
}

main().catch((error) => {
    console.error(`[RESTORE] Failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
