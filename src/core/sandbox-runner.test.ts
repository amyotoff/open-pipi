import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadRunner(env: Record<string, string>) {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...env };

    const execFile = vi.fn((file: string, args: string[], options: any, callback: any) => {
        const cidIndex = args.indexOf('--cidfile');
        const cidFile = cidIndex >= 0 ? args[cidIndex + 1] : '';
        if (cidFile) {
            fs.mkdirSync(path.dirname(cidFile), { recursive: true });
            fs.writeFileSync(cidFile, 'container-123');
        }

        const outputMount = args.find((arg) => arg.includes(':/sandbox-output:rw'));
        if (outputMount) {
            const hostOutputDir = outputMount.split(':/sandbox-output:rw')[0];
            fs.mkdirSync(hostOutputDir, { recursive: true });
            fs.writeFileSync(path.join(hostOutputDir, 'result.txt'), 'ok');
        }

        callback(null, 'sandbox output', '');
    });

    vi.doMock('child_process', () => ({ execFile }));
    const mod = await import('./sandbox-runner');
    return { ...mod, execFile };
}

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/sandbox-runner', () => {
    it('fails fast when the sandbox host scratch root is missing', async () => {
        const mod = await loadRunner({
            SANDBOXD_ALLOWED_IMAGES: 'node:24-slim',
        });

        expect(() => mod.assertSandboxRunnerConfig()).toThrow(/SANDBOXD_HOST_SCRATCH_ROOT is required/);
    });

    it('builds a hardened docker run command from explicit project and workspace roots', async () => {
        const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-sandboxd-test-'));
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-sandbox-project-'));
        const toolPath = path.join(projectRoot, 'packs', 'jeeves', 'tools', 'brief_note.tool.js');
        fs.mkdirSync(path.dirname(toolPath), { recursive: true });
        fs.writeFileSync(
            toolPath,
            'module.exports = { packTool: { id: "jeeves_brief_note", title: "x", description: "x", run() { return "ok"; } } };'
        );
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-sandbox-workspace-'));
        fs.mkdirSync(path.join(workspaceRoot, 'project'), { recursive: true });
        const mod = await loadRunner({
            SANDBOXD_ALLOWED_IMAGES: 'node:24-slim',
            SANDBOXD_CONTAINER_SCRATCH_ROOT: scratchRoot,
            SANDBOXD_HOST_SCRATCH_ROOT: scratchRoot,
        });

        const result = await mod.runPackToolInSandbox({
            tool_name: 'jeeves_brief_note',
            project_root: projectRoot,
            relative_tool_path: 'packs/jeeves/tools/brief_note.tool.js',
            tool_args: { foo: 'bar' },
            runtime: {
                now: '2026-03-26T00:00:00.000Z',
                space_id: 'telegram:chat-1',
                assistant_pack_id: 'jeeves',
                channel: 'telegram',
                channel_ref: 'chat-1',
                workspace_path: '/tmp/ignored-by-runner',
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
            },
            context: { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1' },
            sandbox: {
                image: 'node:24-slim',
                timeout_ms: 5000,
                memory_mb: 96,
                tmpfs_mb: 16,
                read_only_rootfs: false,
                network: 'off',
            },
            workspace_root: workspaceRoot,
            relative_workspace_path: 'project',
        });

        expect(result.ok).toBe(true);
        expect(result.text).toBe('sandbox output');
        expect(result.metadata.container_id).toBe('container-123');
        expect(result.metadata.files_written).toContain('sandbox-output/result.txt');
        expect(mod.execFile).toHaveBeenCalledOnce();

        const [file, args] = mod.execFile.mock.calls[0];
        expect(file).toBe('docker');
        expect(args).toEqual(
            expect.arrayContaining([
                'run',
                '--rm',
                '--read-only',
                '--network',
                'none',
                '--memory',
                '96m',
                '--tmpfs',
                '/tmp:rw,nosuid,nodev,size=16m',
                'node:24-slim',
                'node',
                '-e',
            ])
        );
        expect(args.join(' ')).toContain(`${projectRoot}:/workspace:ro`);
        expect(args.join(' ')).toContain(`${path.join(workspaceRoot, 'project')}:/attached-workspace:ro`);
        expect(args.join(' ')).toContain(':/sandbox-output:rw');
    });

    it('rejects images outside the sandboxd allowlist', async () => {
        const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-sandboxd-test-'));
        const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipi-sandbox-project-'));
        const toolPath = path.join(projectRoot, 'packs', 'jeeves', 'tools', 'brief_note.tool.js');
        fs.mkdirSync(path.dirname(toolPath), { recursive: true });
        fs.writeFileSync(
            toolPath,
            'module.exports = { packTool: { id: "jeeves_brief_note", title: "x", description: "x", run() { return "ok"; } } };'
        );
        const mod = await loadRunner({
            SANDBOXD_ALLOWED_IMAGES: 'node:24-slim',
            SANDBOXD_CONTAINER_SCRATCH_ROOT: scratchRoot,
            SANDBOXD_HOST_SCRATCH_ROOT: scratchRoot,
        });

        await expect(
            mod.runPackToolInSandbox({
                tool_name: 'jeeves_brief_note',
                project_root: projectRoot,
                relative_tool_path: 'packs/jeeves/tools/brief_note.tool.js',
                tool_args: {},
                runtime: {
                    now: '2026-03-26T00:00:00.000Z',
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
                },
                context: { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1' },
                sandbox: {
                    image: 'python:3.12',
                },
                workspace_root: null,
                relative_workspace_path: null,
            })
        ).rejects.toThrow(/allowlist/);
    });
});
