import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModules() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-runtime-backup-${Date.now()}` };

    const db = await import('../db');
    db.initDatabase();
    const backup = await import('./runtime-backup');

    return { db, backup };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/runtime-backup', () => {
    it('creates a runtime backup with a manifest and copied runtime files', async () => {
        const { db, backup } = await loadModules();
        const dataDir = process.env.DATA_DIR!;

        db.ensureTelegramSpace('chat-1', 'group', 'Main chat');
        db.rememberMemoryEntry({
            scope_type: 'space',
            scope_id: 'telegram:chat-1',
            memory_sprint_id: null,
            kind: 'note',
            content: 'Pinned memory survives.',
            salience: 0.9,
            source: 'test',
        });

        const authRoot = path.join(dataDir, 'whatsapp-auth');
        fs.mkdirSync(authRoot, { recursive: true });
        fs.writeFileSync(path.join(authRoot, 'creds.json'), '{"ok":true}');

        const manifest = await backup.createRuntimeBackup('manual');
        const backupRoot = path.join(dataDir, 'backups', manifest.id);
        const payloadRoot = path.join(backupRoot, 'payload');

        expect(fs.existsSync(path.join(backupRoot, 'manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(payloadRoot, 'open-pipi.db'))).toBe(true);
        expect(fs.existsSync(path.join(payloadRoot, 'whatsapp-auth', 'creds.json'))).toBe(true);
        expect(manifest.counts.spaces).toBe(1);
        expect(manifest.counts.memory_entries).toBe(1);
        expect(manifest.files.some((entry) => entry.path === 'open-pipi.db')).toBe(true);
        expect(backup.getLatestRuntimeBackup()?.id).toBe(manifest.id);
    });
});
