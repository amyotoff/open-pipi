import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadExecutor(customSpec?: (toolName: string, args: any) => any) {
    vi.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-executor-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        SANDBOX_PACK_PROJECT_ROOT: '/sandbox/project',
    };

    const getToolExecutionSpecForContext = vi.fn((toolName: string, args: any) =>
        customSpec
            ? customSpec(toolName, args)
            : {
                  tool_name: toolName,
                  run_mode: 'inline',
                  approval: 'none',
                  audit_default: 'errors',
                  capabilities: ['shell_none'],
              }
    );
    const getToolDeclarationForContext = vi.fn<(...args: any[]) => any>(() => undefined);

    vi.doMock('../skills/_registry', () => ({
        getToolExecutionSpecForContext,
        getToolDeclarationForContext,
    }));

    const getPackToolForContext = vi.fn<(...args: any[]) => any>(() => undefined);
    const buildPackToolRuntimeSnapshot = vi.fn(() => ({
        now: new Date().toISOString(),
        space_id: 'telegram:chat-1',
        assistant_pack_id: 'jeeves',
        channel: 'telegram',
        channel_ref: 'chat-1',
        workspace_path: null,
        participant_count: 1,
        participant_names: ['Alice'],
        active_task_count: 0,
        active_tasks: [],
        pending_counts: { todos: 0, reminders: 0 },
        memory_sprint: {
            opened_at: '2026-03-25T00:00:00.000Z',
            closes_at: '2026-04-01T00:00:00.000Z',
            cadence_days: 7,
        },
        policy: {},
    }));
    vi.doMock('./pack-tool-runtime', () => ({
        getPackToolForContext,
        buildPackToolRuntimeSnapshot,
    }));

    const runPackToolViaSandboxd = vi.fn(async () => ({
        ok: true,
        text: 'sandbox ok',
        metadata: {
            backend: 'docker',
            image: 'node:24-slim',
            container_id: 'abc123',
            output_dir: '/sandbox-output',
            files_written: ['sandbox-output/result.txt'],
            duration_ms: 25,
        },
    }));
    vi.doMock('./sandbox-client', () => ({
        runPackToolViaSandboxd,
    }));

    const db = await import('../db');
    db.initDatabase();
    const mod = await import('./tool-executor');
    return {
        db,
        mod,
        getToolExecutionSpecForContext,
        getToolDeclarationForContext,
        getPackToolForContext,
        buildPackToolRuntimeSnapshot,
        runPackToolViaSandboxd,
    };
}

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/tool-executor', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('writes a success audit row when audit mode is all', async () => {
        const { db, mod } = await loadExecutor();
        const fullResult = 'done nicely '.repeat(40).trim();

        db.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'group_chat',
            title: 'Team',
            channel: 'telegram',
            external_ref: 'chat-1',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ audit_trail: 'all' }),
        });

        const result = await mod.executeToolCall({
            toolName: 'note_tool',
            toolArgs: { hello: 'world' },
            context: {
                chatId: 'chat-1',
                userId: '111',
                spaceId: 'telegram:chat-1',
                turnId: 'turn-42',
            },
            handlers: {
                note_tool: vi.fn(async () => fullResult),
            },
        });

        expect(result).toBe(fullResult);
        const auditRows = db.getDb().prepare('SELECT * FROM tool_execution_log').all() as any[];
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0].tool_name).toBe('note_tool');
        expect(auditRows[0].task_id).toBe('turn-42');
        expect(auditRows[0].status).toBe('success');
        expect(auditRows[0].audit_mode).toBe('all');
        expect(auditRows[0].result_preview).toContain('done nicely');
        expect(auditRows[0].result_preview.length).toBeLessThan(fullResult.length);

        const callRows = db.getDb().prepare('SELECT * FROM tool_logs').all() as any[];
        expect(callRows).toHaveLength(1);
        expect(callRows[0].tool_name).toBe('note_tool');
        expect(callRows[0].task_id).toBe('turn-42');
        expect(callRows[0].status).toBe('success');
        expect(callRows[0].result_text).toBe(fullResult);
        expect(JSON.parse(callRows[0].args_json)).toEqual({ hello: 'world' });
    });

    it('lets task audit config override the space default', async () => {
        const { db, mod } = await loadExecutor();

        db.upsertSpace({
            id: 'telegram:chat-2',
            kind: 'group_chat',
            title: 'Ops',
            channel: 'telegram',
            external_ref: 'chat-2',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ audit_trail: 'off' }),
        });
        db.upsertTask({
            id: 'task:telegram:chat-2:test',
            space_id: 'telegram:chat-2',
            title: 'Test task',
            prompt: 'Do the thing',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            config_json: JSON.stringify({ audit_trail: 'all' }),
        });

        await mod.executeToolCall({
            toolName: 'task_tool',
            toolArgs: {},
            context: {
                chatId: 'chat-2',
                userId: 'system_cron',
                spaceId: 'telegram:chat-2',
                taskId: 'task:telegram:chat-2:test',
            },
            handlers: {
                task_tool: vi.fn(async () => 'task ok'),
            },
        });

        const rows = db.listToolExecutionLogsForTask('task:telegram:chat-2:test');
        expect(rows).toHaveLength(1);
        expect(rows[0].audit_mode).toBe('all');
        expect(rows[0].status).toBe('success');
    });

    it('drops successful errors-only rows and keeps failed ones', async () => {
        const { db, mod } = await loadExecutor();

        db.upsertSpace({
            id: 'telegram:chat-3',
            kind: 'group_chat',
            title: 'Quiet',
            channel: 'telegram',
            external_ref: 'chat-3',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ audit_trail: 'errors' }),
        });

        await mod.executeToolCall({
            toolName: 'ok_tool',
            toolArgs: {},
            context: { chatId: 'chat-3', userId: '111', spaceId: 'telegram:chat-3' },
            handlers: {
                ok_tool: vi.fn(async () => 'ok'),
            },
        });

        expect(db.getDb().prepare('SELECT COUNT(*) as cnt FROM tool_execution_log').get() as any).toEqual({ cnt: 0 });

        await expect(
            mod.executeToolCall({
                toolName: 'bad_tool',
                toolArgs: {},
                context: { chatId: 'chat-3', userId: '111', spaceId: 'telegram:chat-3' },
                handlers: {
                    bad_tool: vi.fn(async () => {
                        throw new Error('boom');
                    }),
                },
            })
        ).rejects.toThrow('boom');

        const rows = db.getDb().prepare('SELECT * FROM tool_execution_log').all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0].tool_name).toBe('bad_tool');
        expect(rows[0].status).toBe('error');
        expect(rows[0].error).toContain('boom');
    });

    it('blocks tools whose capabilities are not allowed in the space', async () => {
        const { db, mod } = await loadExecutor(() => ({
            tool_name: 'browse_web',
            run_mode: 'sidecar',
            approval: 'explicit',
            audit_default: 'all',
            capabilities: ['web_browse', 'external_http'],
        }));

        db.upsertSpace({
            id: 'telegram:chat-4',
            kind: 'group_chat',
            title: 'Locked down',
            channel: 'telegram',
            external_ref: 'chat-4',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ browser: false, audit_trail: 'all' }),
        });

        const result = await mod.executeToolCall({
            toolName: 'browse_web',
            toolArgs: { url: 'https://example.com' },
            context: { chatId: 'chat-4', userId: '111', spaceId: 'telegram:chat-4' },
            handlers: {
                browse_web: vi.fn(async () => 'should not happen'),
            },
        });

        expect(result).toContain('blocked by current execution policy');
        const rows = db.getDb().prepare('SELECT * FROM tool_execution_log').all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('blocked');
    });

    it('enforces explicit approvals before invoking a registered handler', async () => {
        const { db, mod } = await loadExecutor(() => ({
            tool_name: 'publish_report',
            run_mode: 'inline',
            approval: 'explicit',
            approval_action: 'publish_report',
            approval_reason: 'publishing a report to an external destination',
            audit_default: 'all',
            capabilities: ['shell_none'],
        }));
        const approvals = await import('../utils/approvals');
        const context = { chatId: 'chat-approval', userId: '111', spaceId: 'telegram:chat-approval' };
        const handler = vi.fn(async () => 'published');

        db.upsertSpace({
            id: context.spaceId,
            kind: 'group_chat',
            title: 'Approvals',
            channel: 'telegram',
            external_ref: context.chatId,
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ audit_trail: 'all' }),
        });

        const blocked = await mod.executeToolCall({
            toolName: 'publish_report',
            toolArgs: {},
            context,
            handlers: { publish_report: handler },
        });

        expect(blocked).toContain('publish_report');
        expect(blocked).toContain('publishing a report to an external destination');
        expect(handler).not.toHaveBeenCalled();
        expect(approvals.listPendingApprovalActions(context)).toEqual(['publish_report']);

        approvals.approvePendingAction(context, 'publish_report');
        await expect(
            mod.executeToolCall({
                toolName: 'publish_report',
                toolArgs: {},
                context,
                handlers: { publish_report: handler },
            })
        ).resolves.toBe('published');
        expect(handler).toHaveBeenCalledTimes(1);

        const rows = db.getDb().prepare('SELECT status, error FROM tool_execution_log ORDER BY id').all() as any[];
        expect(rows).toEqual([
            { status: 'blocked', error: 'approval_required' },
            { status: 'success', error: null },
        ]);
    });

    it('normalizes array arguments from the tool schema before invoking handlers', async () => {
        const { db, mod, getToolDeclarationForContext } = await loadExecutor();

        db.upsertSpace({
            id: 'telegram:chat-arrays',
            kind: 'group_chat',
            title: 'Arrays',
            channel: 'telegram',
            external_ref: 'chat-arrays',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ audit_trail: 'all' }),
        });

        getToolDeclarationForContext.mockReturnValue({
            name: 'bulk_add',
            description: 'Bulk add items',
            parameters: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                },
            },
        });

        const handler = vi.fn(async () => 'bulk ok');

        await mod.executeToolCall({
            toolName: 'bulk_add',
            toolArgs: { items: 'milk' },
            context: { chatId: 'chat-arrays', userId: '111', spaceId: 'telegram:chat-arrays' },
            handlers: {
                bulk_add: handler,
            },
        });

        await mod.executeToolCall({
            toolName: 'bulk_add',
            toolArgs: {},
            context: { chatId: 'chat-arrays', userId: '111', spaceId: 'telegram:chat-arrays' },
            handlers: {
                bulk_add: handler,
            },
        });

        expect(handler).toHaveBeenNthCalledWith(
            1,
            { items: ['milk'] },
            expect.objectContaining({ spaceId: 'telegram:chat-arrays' })
        );
        expect(handler).toHaveBeenNthCalledWith(
            2,
            { items: [] },
            expect.objectContaining({ spaceId: 'telegram:chat-arrays' })
        );
    });

    it('routes sandbox pack tools through the docker backend and records sandbox metadata', async () => {
        const { db, mod, getPackToolForContext, runPackToolViaSandboxd } = await loadExecutor(() => ({
            tool_name: 'office_focus_note',
            run_mode: 'sandbox',
            approval: 'none',
            audit_default: 'all',
            capabilities: ['shell_none'],
        }));

        db.upsertSpace({
            id: 'telegram:chat-5',
            kind: 'group_chat',
            title: 'Sandbox',
            channel: 'telegram',
            external_ref: 'chat-5',
            assistant_pack_id: 'office',
            policy_json: JSON.stringify({ sandbox_enabled: true, audit_trail: 'all' }),
        });

        getPackToolForContext.mockReturnValue({
            id: 'office_focus_note',
            title: 'Office focus note',
            description: 'Focus note',
            script_path: '/tmp/office_focus_note.tool.js',
            script_relative_path: 'packs/office/tools/office_focus_note.tool.js',
            execution: {
                run_mode: 'sandbox',
                sandbox: { image: 'node:24-slim' },
            },
            declaration: {
                name: 'office_focus_note',
                description: 'Focus note',
                parameters: { type: 'object', properties: {} } as any,
            },
            run: () => 'inline fallback',
        });

        const result = await mod.executeToolCall({
            toolName: 'office_focus_note',
            toolArgs: {},
            context: { chatId: 'chat-5', userId: '111', spaceId: 'telegram:chat-5' },
            handlers: {},
        });

        expect(result).toBe('sandbox ok');
        expect(runPackToolViaSandboxd).toHaveBeenCalledOnce();
        expect(runPackToolViaSandboxd).toHaveBeenCalledWith(
            expect.objectContaining({
                project_root: '/sandbox/project',
                relative_tool_path: 'packs/office/tools/office_focus_note.tool.js',
            })
        );
        const rows = db.getDb().prepare('SELECT * FROM tool_execution_log').all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0].sandbox_backend).toBe('docker');
        expect(rows[0].sandbox_image).toBe('node:24-slim');
        expect(rows[0].sandbox_container_id).toBe('abc123');
        expect(rows[0].files_written_json).toContain('result.txt');
    });
});
