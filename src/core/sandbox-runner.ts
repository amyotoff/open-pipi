import { execFile } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { SandboxPackToolRequest, SandboxPackToolResponse } from './sandbox-contract';
import { PackToolRuntimeSnapshot } from './pack-types';
import { SandboxExecutionSpec } from './tool-execution';

const DEFAULT_SANDBOX_IMAGE = 'node:24-slim';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_TMPFS_MB = 32;
const DEFAULT_CPU_LIMIT = 1;
const MAX_TIMEOUT_MS = Number(process.env.SANDBOXD_MAX_TIMEOUT_MS || 30000);
const MAX_MEMORY_MB = Number(process.env.SANDBOXD_MAX_MEMORY_MB || 256);
const MAX_TMPFS_MB = Number(process.env.SANDBOXD_MAX_TMPFS_MB || 64);
const MAX_CPU_LIMIT = Number(process.env.SANDBOXD_MAX_CPU_LIMIT || 1);
const DEFAULT_ALLOWED_IMAGES = [DEFAULT_SANDBOX_IMAGE];
const CONTAINER_SCRATCH_ROOT = process.env.SANDBOXD_CONTAINER_SCRATCH_ROOT || '/var/lib/sandboxd';
const HOST_SCRATCH_ROOT = process.env.SANDBOXD_HOST_SCRATCH_ROOT || '';
const SANDBOX_WORKSPACE_PATH = '/attached-workspace';
const SANDBOX_PROJECT_PATH = '/workspace';

const INLINE_SANDBOX_RUNNER = `
async function main() {
  const toolPath = process.env.PIPI_SANDBOX_TOOL_PATH;
  const rawArgs = process.env.PIPI_SANDBOX_ARGS || '{}';
  const rawRuntime = process.env.PIPI_SANDBOX_RUNTIME || '{}';
  const rawContext = process.env.PIPI_SANDBOX_CONTEXT || '{}';

  if (!toolPath) {
    throw new Error('PIPI_SANDBOX_TOOL_PATH is required.');
  }

  const loaded = require(toolPath);
  const packTool = loaded.packTool || loaded.default || loaded;
  if (!packTool || typeof packTool.run !== 'function') {
    throw new Error('Sandbox target does not export packTool.run.');
  }

  const args = JSON.parse(rawArgs);
  const runtime = JSON.parse(rawRuntime);
  const context = JSON.parse(rawContext);
  const result = await packTool.run(args, runtime, context);

  if (typeof result === 'string') {
    process.stdout.write(result);
    return;
  }

  if (result === undefined || result === null) {
    return;
  }

  process.stdout.write(typeof result === 'object' ? JSON.stringify(result) : String(result));
}

main().catch((error) => {
  process.stderr.write(String(error && error.message ? error.message : error));
  process.exit(1);
});
`.trim();

export class SandboxRunnerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SandboxRunnerError';
    }
}

type EnforcedSandboxPolicy = {
    image: string;
    timeout_ms: number;
    memory_mb: number;
    tmpfs_mb: number;
    cpu_limit: number;
    read_only_rootfs: true;
    network: 'off';
};

function parseAllowedImages(raw: string | undefined): string[] {
    const parsed = (raw || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_IMAGES;
}

function normalizeExecOutput(stdout: string | Buffer, stderr: string | Buffer): string {
    const stdoutText = String(stdout || '').trim();
    const stderrText = String(stderr || '').trim();
    return [stdoutText, stderrText].filter(Boolean).join('\n').trim();
}

function sanitizeRuntimeSnapshot(runtime: PackToolRuntimeSnapshot, workspaceMounted: boolean): PackToolRuntimeSnapshot {
    return {
        ...runtime,
        workspace_path: workspaceMounted ? SANDBOX_WORKSPACE_PATH : null,
    };
}

export function assertSandboxRunnerConfig(): void {
    if (!HOST_SCRATCH_ROOT) {
        throw new SandboxRunnerError('SANDBOXD_HOST_SCRATCH_ROOT is required.');
    }
}

function buildScratchPaths(): { id: string; containerRoot: string; hostRoot: string } {
    assertSandboxRunnerConfig();
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        id,
        containerRoot: path.join(CONTAINER_SCRATCH_ROOT, id),
        hostRoot: path.join(HOST_SCRATCH_ROOT, id),
    };
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
    const numeric = Number.isFinite(value) ? Number(value) : fallback;
    return Math.max(1, Math.min(Math.round(numeric), max));
}

function clampPositiveFloat(value: number | undefined, fallback: number, max: number): number {
    const numeric = Number.isFinite(value) ? Number(value) : fallback;
    return Math.max(0.1, Math.min(numeric, max));
}

function isSubpath(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelativePath(input: string, label: string): string {
    const normalized = String(input || '').replace(/\\/g, '/');
    if (!normalized || normalized === '.' || normalized.startsWith('/')) {
        throw new SandboxRunnerError(`${label} must be a non-empty relative path.`);
    }

    const collapsed = path.posix.normalize(normalized);
    if (collapsed === '.' || collapsed === '..' || collapsed.startsWith('../')) {
        throw new SandboxRunnerError(`${label} must stay inside its declared root.`);
    }

    return collapsed;
}

function resolveExistingRoot(rootPath: string, label: string): string {
    if (!rootPath || !path.isAbsolute(rootPath)) {
        throw new SandboxRunnerError(`${label} must be an absolute path.`);
    }

    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved)) {
        throw new SandboxRunnerError(`${label} does not exist on sandbox host: ${resolved}`);
    }

    return resolved;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string, label: string): string {
    const normalizedRelativePath = normalizeRelativePath(relativePath, label);
    const resolved = path.resolve(rootPath, ...normalizedRelativePath.split('/'));
    if (!isSubpath(resolved, rootPath)) {
        throw new SandboxRunnerError(`${label} must stay inside ${rootPath}.`);
    }
    return resolved;
}

function resolveWorkspaceMount(workspaceRoot?: string | null, relativeWorkspacePath?: string | null): string | null {
    if (!workspaceRoot) return null;

    const resolvedRoot = resolveExistingRoot(workspaceRoot, 'workspace_root');
    const resolvedPath = relativeWorkspacePath
        ? resolvePathWithinRoot(resolvedRoot, relativeWorkspacePath, 'relative_workspace_path')
        : resolvedRoot;

    if (!fs.existsSync(resolvedPath)) {
        throw new SandboxRunnerError(`Workspace path does not exist on sandbox host: ${resolvedPath}`);
    }

    return resolvedPath;
}

function enforceSandboxPolicy(requested?: SandboxExecutionSpec): EnforcedSandboxPolicy {
    const allowedImages = parseAllowedImages(process.env.SANDBOXD_ALLOWED_IMAGES);
    const image = requested?.image || allowedImages[0] || DEFAULT_SANDBOX_IMAGE;
    if (!allowedImages.includes(image)) {
        throw new SandboxRunnerError(`Sandbox image "${image}" is not in the sandboxd allowlist.`);
    }

    if (requested?.network && requested.network !== 'off') {
        throw new SandboxRunnerError('sandboxd currently enforces network=off for all runs.');
    }

    return {
        image,
        timeout_ms: clampPositiveInt(requested?.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        memory_mb: clampPositiveInt(requested?.memory_mb, DEFAULT_MEMORY_MB, MAX_MEMORY_MB),
        tmpfs_mb: clampPositiveInt(requested?.tmpfs_mb, DEFAULT_TMPFS_MB, MAX_TMPFS_MB),
        cpu_limit: clampPositiveFloat(requested?.cpu_limit, DEFAULT_CPU_LIMIT, MAX_CPU_LIMIT),
        read_only_rootfs: true,
        network: 'off',
    };
}

async function ensureScratchDir(containerPath: string): Promise<void> {
    await fsp.mkdir(containerPath, { recursive: true });
    await fsp.chmod(containerPath, 0o777);
}

async function listFilesRecursive(root: string): Promise<string[]> {
    const results: string[] = [];

    async function walk(current: string): Promise<void> {
        let dirents;
        try {
            dirents = await fsp.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }

        for (const dirent of dirents) {
            const absolutePath = path.join(current, dirent.name);
            const relativePath = path.relative(root, absolutePath).split(path.sep).join(path.posix.sep);
            if (dirent.isDirectory()) {
                await walk(absolutePath);
            } else {
                results.push(relativePath);
            }
        }
    }

    await walk(root);
    return results.sort();
}

async function runDockerCommand(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
        execFile(
            'docker',
            args,
            {
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024,
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject({ error, stdout, stderr });
                    return;
                }

                resolve({
                    stdout: String(stdout || ''),
                    stderr: String(stderr || ''),
                });
            }
        );
    });
}

function buildDockerArgs(args: {
    image: string;
    containerName: string;
    cidFile: string;
    hostProjectRoot: string;
    hostWorkspacePath?: string | null;
    hostOutputDir: string;
    toolPathInSandbox: string;
    request: SandboxPackToolRequest;
    runtime: PackToolRuntimeSnapshot;
    policy: EnforcedSandboxPolicy;
}): string[] {
    const dockerArgs = [
        'run',
        '--rm',
        '--name',
        args.containerName,
        '--cidfile',
        args.cidFile,
        '--workdir',
        SANDBOX_PROJECT_PATH,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--pids-limit',
        '128',
        '--memory',
        `${args.policy.memory_mb}m`,
        '--cpus',
        String(args.policy.cpu_limit),
        '--user',
        '65534:65534',
        '-v',
        `${args.hostProjectRoot}:${SANDBOX_PROJECT_PATH}:ro`,
        '-v',
        `${args.hostOutputDir}:/sandbox-output:rw`,
        '-e',
        `PIPI_SANDBOX_TOOL_PATH=${args.toolPathInSandbox}`,
        '-e',
        `PIPI_SANDBOX_ARGS=${JSON.stringify(args.request.tool_args || {})}`,
        '-e',
        `PIPI_SANDBOX_RUNTIME=${JSON.stringify(args.runtime)}`,
        '-e',
        `PIPI_SANDBOX_CONTEXT=${JSON.stringify(args.request.context)}`,
        '-e',
        'PIPI_SANDBOX_OUTPUT_DIR=/sandbox-output',
    ];

    if (args.policy.read_only_rootfs) {
        dockerArgs.push('--read-only');
    }

    dockerArgs.push('--network', 'none');
    dockerArgs.push('--tmpfs', `/tmp:rw,nosuid,nodev,size=${args.policy.tmpfs_mb}m`);

    if (args.hostWorkspacePath) {
        dockerArgs.push('-v', `${args.hostWorkspacePath}:${SANDBOX_WORKSPACE_PATH}:ro`);
        dockerArgs.push('-e', `PIPI_SANDBOX_WORKSPACE=${SANDBOX_WORKSPACE_PATH}`);
    }

    dockerArgs.push(args.image, 'node', '-e', INLINE_SANDBOX_RUNNER);

    return dockerArgs;
}

export async function runPackToolInSandbox(request: SandboxPackToolRequest): Promise<SandboxPackToolResponse> {
    const policy = enforceSandboxPolicy(request.sandbox);
    const hostProjectRoot = resolveExistingRoot(request.project_root, 'project_root');
    const relativeToolPath = normalizeRelativePath(request.relative_tool_path, 'relative_tool_path');
    const hostToolPath = resolvePathWithinRoot(hostProjectRoot, relativeToolPath, 'relative_tool_path');
    if (!fs.existsSync(hostToolPath)) {
        throw new SandboxRunnerError(`Tool script does not exist on sandbox host: ${hostToolPath}`);
    }

    const toolPathInSandbox = path.posix.join(SANDBOX_PROJECT_PATH, relativeToolPath);
    const hostWorkspacePath = resolveWorkspaceMount(request.workspace_root, request.relative_workspace_path);
    const runtime = sanitizeRuntimeSnapshot(request.runtime, !!hostWorkspacePath);
    const scratch = buildScratchPaths();
    const outputDirContainer = path.join(scratch.containerRoot, 'output');
    const outputDirHost = path.join(scratch.hostRoot, 'output');
    const cidFileContainer = path.join(scratch.containerRoot, 'container.cid');
    const cidFileHost = path.join(scratch.hostRoot, 'container.cid');
    const containerName = `pipi-sbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startedMs = Date.now();

    await ensureScratchDir(outputDirContainer);

    const dockerArgs = buildDockerArgs({
        image: policy.image,
        containerName,
        cidFile: cidFileHost,
        hostProjectRoot,
        hostWorkspacePath,
        hostOutputDir: outputDirHost,
        toolPathInSandbox,
        request,
        runtime,
        policy,
    });

    try {
        const { stdout, stderr } = await runDockerCommand(dockerArgs, policy.timeout_ms);
        let containerId: string | null = null;
        try {
            containerId = (await fsp.readFile(cidFileContainer, 'utf-8')).trim() || null;
        } catch {}

        const filesWritten = await listFilesRecursive(outputDirContainer);

        return {
            ok: true,
            text: normalizeExecOutput(stdout, stderr),
            metadata: {
                backend: 'docker',
                image: policy.image,
                container_id: containerId,
                output_dir: '/sandbox-output',
                files_written: filesWritten.map((file) => path.posix.join('sandbox-output', file)),
                duration_ms: Date.now() - startedMs,
            },
        };
    } catch (error: any) {
        const output = normalizeExecOutput(error?.stdout || '', error?.stderr || '');
        throw new SandboxRunnerError(output || error?.error?.message || error?.message || 'Sandbox execution failed.');
    } finally {
        await fsp.rm(scratch.containerRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}
