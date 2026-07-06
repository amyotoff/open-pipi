import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const ORIGINAL_ENV = { ...process.env };

async function loadModule(options: { publicBaseUrl?: string } = {}) {
    vi.resetModules();

    vi.doMock('../channels/runtime', () => ({
        sendChannelFile: vi.fn(async () => ({ success: true, messageId: 'file-1' })),
    }));

    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-task-board-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...(options.publicBaseUrl === undefined ? { PIPI_PUBLIC_BASE_URL: 'https://pipi.example' } : {}),
    };
    if (options.publicBaseUrl !== undefined) {
        process.env.PIPI_PUBLIC_BASE_URL = options.publicBaseUrl;
    }

    const db = await import('../db');
    db.initDatabase();
    db.ensureTelegramSpace('chat-1', 'group', 'chat-1');

    const htmlArtifacts = await import('./html-artifacts');
    return { db, htmlArtifacts };
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

describe('generateTaskBoard', () => {
    it('creates a file and returns url/filePath', async () => {
        const { db, htmlArtifacts } = await loadModule();

        db.upsertTask({
            id: 'task-1',
            space_id: 'telegram:chat-1',
            title: 'Morning Briefing',
            prompt: 'Summarize news',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            status: 'active',
            last_run_at: null,
        });

        const page = htmlArtifacts.generateTaskBoard('telegram:chat-1');

        expect(page.fileName).toMatch(/^task-board-[a-f0-9]{12}\.html$/);
        expect(page.filePath).toContain('html-artifacts');
        expect(page.url).toContain('https://pipi.example/html/task-board-');
        expect(fs.existsSync(page.filePath)).toBe(true);
    });

    it('returns the same filename on repeated calls (stable URL)', async () => {
        const { htmlArtifacts } = await loadModule();

        const page1 = htmlArtifacts.generateTaskBoard('telegram:chat-1');
        const page2 = htmlArtifacts.generateTaskBoard('telegram:chat-1');

        expect(page1.fileName).toBe(page2.fileName);
        expect(page1.url).toBe(page2.url);
    });

    it('generates HTML containing task titles', async () => {
        const { db, htmlArtifacts } = await loadModule();

        db.upsertTask({
            id: 'task-alice-1',
            space_id: 'telegram:chat-1',
            title: 'Утренний брифинг',
            prompt: 'Summarize news',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            status: 'active',
            last_run_at: new Date().toISOString(),
        });
        db.upsertTask({
            id: 'task-bob-1',
            space_id: 'telegram:chat-1',
            title: 'Weekly Report',
            prompt: 'Generate weekly report',
            schedule_type: 'cron',
            schedule_value: '0 18 * * 5',
            status: 'paused',
            last_run_at: null,
        });
        db.upsertTask({
            id: 'task-bender-1',
            space_id: 'telegram:chat-1',
            title: 'Old Task',
            prompt: 'Do something',
            schedule_type: 'cron',
            schedule_value: '0 12 * * *',
            status: 'completed',
            last_run_at: '2026-06-14T12:00:00.000Z',
        });

        const page = htmlArtifacts.generateTaskBoard('telegram:chat-1');
        const html = fs.readFileSync(page.filePath, 'utf8');

        // Task titles present
        expect(html).toContain('Утренний брифинг');
        expect(html).toContain('Weekly Report');
        expect(html).toContain('Old Task');

        // Column structure
        expect(html).toContain('data-status="active"');
        expect(html).toContain('data-status="paused"');
        expect(html).toContain('data-status="completed"');

        // Auto-refresh meta tag
        expect(html).toContain('http-equiv="refresh"');
        expect(html).toContain('content="60"');

        // Task Board kind label
        expect(html).toContain('Task Board');

        // Schedule info
        expect(html).toContain('0 9 * * *');
        expect(html).toContain('0 18 * * 5');
    });

    it('generates different filenames for different spaceIds', async () => {
        const { db, htmlArtifacts } = await loadModule();

        db.ensureTelegramSpace('chat-2', 'group', 'chat-2');

        const page1 = htmlArtifacts.generateTaskBoard('telegram:chat-1');
        const page2 = htmlArtifacts.generateTaskBoard('telegram:chat-2');

        expect(page1.fileName).not.toBe(page2.fileName);
    });
});
