import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function bootApi() {
    vi.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-api-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    const db = await import('./db');
    db.initDatabase();
    const api = await import('./api');
    const server = await api.startApiServer({
        host: '127.0.0.1',
        port: 0,
        token: 'test-token',
    });
    const address = server?.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    return { db, api, baseUrl };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const api = await import('./api');
        await api.stopApiServer();
    } catch {}
    try {
        const db = await import('./db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('api', () => {
    it('rejects unauthorized API requests', async () => {
        const { baseUrl } = await bootApi();

        const response = await fetch(`${baseUrl}/api/tool-logs`);
        const body = await response.json();

        expect(response.status).toBe(401);
        expect(body).toEqual({ ok: false, error: 'Unauthorized.' });
    });

    it('serves generated Brief pages without API auth', async () => {
        const { baseUrl } = await bootApi();
        const { createBriefPage } = await import('./core/brief-pages');
        const page = createBriefPage({
            spaceId: 'telegram:chat-1',
            taskTitle: 'Morning briefing',
            text: '**Today**\n- Check the launch plan\n- 15:00 sync with the launch team',
            createdAt: new Date('2026-05-15T08:00:00.000Z'),
        });

        const response = await fetch(`${baseUrl}/briefs/${page.fileName}`);
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(body).toContain('<h2>🌤 Today</h2>');
        expect(body).toContain('Check the launch plan');
        expect(body).toContain('🗓 Синки и события');
        expect(body).toContain('15:00 sync with the launch team');
    });

    it('serves generated HTML artifacts without API auth', async () => {
        const { baseUrl } = await bootApi();
        const { createHtmlArtifactPage } = await import('./core/html-artifacts');
        const page = createHtmlArtifactPage({
            spaceId: 'telegram:chat-1',
            kind: 'research',
            title: 'Launch Research',
            summary: 'Compact research artifact.',
            body: '**Findings**\n- 12:00 demo review\n- Source map ready',
            createdAt: new Date('2026-05-15T08:00:00.000Z'),
        });

        const response = await fetch(`${baseUrl}/html/${page.fileName}`);
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(body).toContain('🔬 Launch Research');
        expect(body).toContain('Compact research artifact.');
        expect(body).toContain('🗓 Синки и события');
        expect(body).toContain('12:00 demo review');
    });

    it('lists tool logs with filters, paging metadata, and summary', async () => {
        const { db, baseUrl } = await bootApi();

        db.insertToolLog({
            space_id: 'telegram:chat-1',
            task_id: 'task-1',
            tool_name: 'browse_web',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { query: 'rome weather' },
            result_text: 'Sunny in Rome',
            status: 'success',
            started_at: '2026-04-14T08:00:00.000Z',
            finished_at: '2026-04-14T08:00:01.000Z',
            duration_ms: 1000,
        });
        db.insertToolLog({
            space_id: 'telegram:chat-1',
            task_id: 'task-2',
            tool_name: 'browse_web',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { query: 'rome flights' },
            result_text: null,
            status: 'error',
            error: 'rate_limited',
            started_at: '2026-04-14T09:00:00.000Z',
            finished_at: '2026-04-14T09:00:03.000Z',
            duration_ms: 3000,
        });
        db.insertToolLog({
            space_id: 'telegram:chat-2',
            task_id: 'task-3',
            tool_name: 'workspace_read_text',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { path: 'README.md' },
            result_text: 'README body',
            status: 'blocked',
            started_at: '2026-04-14T10:00:00.000Z',
            finished_at: '2026-04-14T10:00:00.500Z',
            duration_ms: 500,
        });

        const response = await fetch(`${baseUrl}/api/tool-logs?space_id=telegram:chat-1&q=rome&limit=1`, {
            headers: {
                Authorization: 'Bearer test-token',
            },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.page.total).toBe(2);
        expect(body.page.limit).toBe(1);
        expect(body.page.offset).toBe(0);
        expect(body.page.has_more).toBe(true);
        expect(body.summary.total).toBe(2);
        expect(body.summary.by_status).toEqual({ error: 1, success: 1 });
        expect(body.summary.by_tool).toEqual([{ tool_name: 'browse_web', count: 2 }]);
        expect(body.items).toHaveLength(1);
        expect(body.items[0].space_id).toBe('telegram:chat-1');
    });

    it('returns full tool log details by id', async () => {
        const { db, baseUrl } = await bootApi();

        const id = db.insertToolLog({
            space_id: 'telegram:chat-9',
            task_id: 'task-9',
            tool_name: 'workspace_read_text',
            run_mode: 'inline',
            audit_mode: 'all',
            args: { path: 'README.md' },
            result_text: 'Very long body that should stay intact',
            status: 'success',
            started_at: '2026-04-14T11:00:00.000Z',
            finished_at: '2026-04-14T11:00:00.500Z',
            duration_ms: 500,
        });

        const response = await fetch(`${baseUrl}/api/tool-logs/${id}`, {
            headers: {
                Authorization: 'Bearer test-token',
            },
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.item.id).toBe(id);
        expect(body.item.result_text).toBe('Very long body that should stay intact');
        expect(JSON.parse(body.item.args_json)).toEqual({ path: 'README.md' });
    });
});
