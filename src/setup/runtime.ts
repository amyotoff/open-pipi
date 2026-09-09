import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { LLM_KEY_ENV, resolveLlmConfig } from '../core/llm-config';
import type { RuntimeMode } from './process-lock';
import { readProcessLock, type ProcessLockStatus } from './process-lock';

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'error';

export interface RuntimeStatus {
    state: RuntimeState;
    dataDir: string;
    mode?: RuntimeMode;
    pid?: number;
    runId?: string;
    startedAt?: string;
    readyAt?: string;
    background: boolean;
    message: string;
}

export interface BackgroundSupport {
    supported: boolean;
    platform: NodeJS.Platform;
    explanation: string;
}

export interface RuntimeCommandRunner {
    spawn(file: string, args: readonly string[], options: { cwd: string }): Promise<number | undefined>;
    run(file: string, args: readonly string[]): Promise<void>;
    signal(pid: number, signal: NodeJS.Signals): void;
}

export interface RuntimeLifecycleIO {
    exists(filePath: string): boolean;
    readTextFile(filePath: string): string;
    writePrivateFile(filePath: string, content: string): void;
}

export interface RuntimeController {
    backgroundSupport(): BackgroundSupport;
    status(): Promise<RuntimeStatus>;
    start(options: { mode: RuntimeMode }): Promise<RuntimeStatus>;
    stop(): Promise<RuntimeStatus>;
}

export interface RuntimeControllerOptions {
    projectRoot?: string;
    dataDir?: string;
    platform?: NodeJS.Platform;
    homeDir?: string;
    uid?: number;
    nodePath?: string;
    entryPath?: string;
    runner?: RuntimeCommandRunner;
    io?: RuntimeLifecycleIO;
    readLock?: (dataDir: string) => ProcessLockStatus;
    wait?: (milliseconds: number) => Promise<void>;
    readyTimeoutMs?: number;
    backgroundEnvironment?: {
        effective(): NodeJS.ProcessEnv;
        persistent(): NodeJS.ProcessEnv;
    };
}

export type RuntimeLifecycleErrorCode =
    | 'unsupported_platform'
    | 'setup_active'
    | 'runtime_missing'
    | 'background_config_incomplete'
    | 'start_failed'
    | 'stop_failed';

export class RuntimeLifecycleError extends Error {
    constructor(
        public readonly code: RuntimeLifecycleErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'RuntimeLifecycleError';
    }
}

export function backgroundConfigurationMismatches(
    effective: NodeJS.ProcessEnv,
    persistent: NodeJS.ProcessEnv
): string[] {
    const mismatches = new Set<string>();
    const compare = (key: string, effectiveValue = effective[key], persistentValue = persistent[key]): void => {
        if ((effectiveValue || '').trim() !== (persistentValue || '').trim()) mismatches.add(key);
    };

    for (const key of [
        'TELEGRAM_BOT_TOKEN',
        'OWNER_TG_IDS',
        'OWNER_IDENTITIES',
        'BOOTSTRAP_PACK',
        'BOOTSTRAP_GROUNDING',
        'BOT_DISPLAY_NAME',
    ]) {
        if ((effective[key] || '').trim()) compare(key);
    }
    const effectiveLlm = resolveLlmConfig(effective);
    const persistentLlm = resolveLlmConfig(persistent);
    for (const [key, effectiveValue, persistentValue] of [
        ['LLM_PROVIDER', effectiveLlm.provider, persistentLlm.provider],
        ['LLM_EXECUTOR_MODEL', effectiveLlm.executorModel, persistentLlm.executorModel],
        ['LLM_ADVISOR_MODEL', effectiveLlm.advisorModel, persistentLlm.advisorModel],
        ['LLM_TOOLS_PROVIDER', effectiveLlm.toolsProvider, persistentLlm.toolsProvider],
        ['LLM_TOOLS_MODEL', effectiveLlm.toolsModel, persistentLlm.toolsModel],
        ['LLM_VISION_PROVIDER', effectiveLlm.visionProvider, persistentLlm.visionProvider],
        ['LLM_VISION_MODEL', effectiveLlm.visionModel, persistentLlm.visionModel],
        ['LLM_SEARCH_PROVIDER', effectiveLlm.searchProvider, persistentLlm.searchProvider],
        ['LLM_SEARCH_MODEL', effectiveLlm.searchModel, persistentLlm.searchModel],
    ] as const) {
        compare(key, effectiveValue, persistentValue);
    }
    for (const provider of new Set([
        effectiveLlm.provider,
        effectiveLlm.toolsProvider,
        effectiveLlm.visionProvider,
        effectiveLlm.searchProvider,
    ])) {
        const credentialKey = LLM_KEY_ENV[provider];
        compare(credentialKey);
    }
    return [...mismatches].sort();
}

const defaultRunner: RuntimeCommandRunner = {
    spawn: (file, args, options) =>
        new Promise((resolve, reject) => {
            const child = spawn(file, [...args], {
                cwd: options.cwd,
                detached: false,
                stdio: 'inherit',
                shell: false,
            });
            child.once('spawn', () => resolve(child.pid));
            child.once('error', reject);
        }),
    run: (file, args) =>
        new Promise((resolve, reject) => {
            execFile(file, [...args], { shell: false }, (error) => (error ? reject(error) : resolve()));
        }),
    signal: (pid, signal) => process.kill(pid, signal),
};

const defaultIO: RuntimeLifecycleIO = {
    exists: (filePath) => fs.existsSync(filePath),
    readTextFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
    writePrivateFile: (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, 0o600);
    },
};

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function renderLaunchAgent(
    programArgs: readonly string[],
    workingDirectory: string,
    serviceLabel = 'com.openpipi.runtime'
): string {
    const argumentsXml = programArgs.map((argument) => `        <string>${xmlEscape(argument)}</string>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(serviceLabel)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
        throw new RuntimeLifecycleError('start_failed', 'A runtime path contains unsupported characters.');
    }
    return `"${value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderSystemdUserService(
    programArgs: readonly string[],
    workingDirectory: string,
    installationId = 'default'
): string {
    return `# Open PiPi installation: ${installationId}
[Unit]
Description=Open PiPi personal assistant
After=network-online.target

[Service]
Type=simple
ExecStart=${programArgs.map(systemdQuote).join(' ')}
WorkingDirectory=${systemdQuote(workingDirectory)}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function supportFor(platform: NodeJS.Platform): BackgroundSupport {
    if (platform === 'darwin' || platform === 'linux') {
        return {
            supported: true,
            platform,
            explanation:
                'Background mode starts after you sign in and restarts after failures. PiPi is unavailable while this computer sleeps or is turned off.',
        };
    }
    return {
        supported: false,
        platform,
        explanation: 'Background mode is currently supported on macOS and Linux.',
    };
}

function mapLockStatus(status: ProcessLockStatus): RuntimeStatus {
    if (status.owner === 'setup' && status.held) {
        return {
            state: 'stopped',
            dataDir: status.dataDir,
            background: false,
            message: 'Setup currently owns the Telegram connection.',
        };
    }
    if (status.owner === 'runtime' && status.held) {
        return {
            state: status.state === 'ready' ? 'ready' : 'starting',
            dataDir: status.dataDir,
            mode: status.mode,
            pid: status.pid,
            runId: status.runId,
            startedAt: status.startedAt,
            readyAt: status.readyAt,
            background: status.mode === 'background',
            message: status.state === 'ready' ? 'Open PiPi is ready.' : 'Open PiPi is starting.',
        };
    }
    if (status.stale && status.owner === 'runtime') {
        return {
            state: 'error',
            dataDir: status.dataDir,
            mode: status.mode,
            pid: status.pid,
            runId: status.runId,
            startedAt: status.startedAt,
            readyAt: status.readyAt,
            background: status.mode === 'background',
            message: 'The previous Open PiPi process stopped without a clean shutdown.',
        };
    }
    return {
        state: 'stopped',
        dataDir: status.dataDir,
        background: false,
        message: 'Open PiPi is stopped.',
    };
}

export function createRuntimeController(options: RuntimeControllerOptions = {}): RuntimeController {
    const projectRoot = path.resolve(options.projectRoot || process.cwd());
    const dataDir = path.resolve(options.dataDir || path.join(projectRoot, 'data'));
    const platform = options.platform || process.platform;
    const homeDir = path.resolve(options.homeDir || os.homedir());
    const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
    const nodePath = path.resolve(options.nodePath || process.execPath);
    const entryPath = path.resolve(options.entryPath || path.join(projectRoot, 'dist', 'index.js'));
    const runner = options.runner || defaultRunner;
    const io = options.io || defaultIO;
    const readLock = options.readLock || readProcessLock;
    const wait =
        options.wait || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
    const backgroundEnvironment = options.backgroundEnvironment;
    const installationId = createHash('sha256').update(`${projectRoot}\0${dataDir}`).digest('hex').slice(0, 12);
    const serviceLabel = `com.openpipi.runtime.${installationId}`;
    const serviceName = `open-pipi-${installationId}.service`;
    const ownershipMarker = `Open PiPi installation: ${installationId}`;
    const runtimeArgs = (mode: RuntimeMode) => [entryPath, `--runtime-mode=${mode}`, `--data-dir=${dataDir}`];
    const macServicePath = path.join(homeDir, 'Library', 'LaunchAgents', `${serviceLabel}.plist`);
    const linuxServicePath = path.join(homeDir, '.config', 'systemd', 'user', serviceName);

    async function status(): Promise<RuntimeStatus> {
        return mapLockStatus(readLock(dataDir));
    }

    async function waitForStartup(): Promise<RuntimeStatus> {
        const deadline = Date.now() + readyTimeoutMs;
        let current = await status();
        while (current.state === 'stopped' && Date.now() < deadline) {
            await wait(Math.min(50, Math.max(1, deadline - Date.now())));
            current = await status();
        }
        return current.state === 'stopped'
            ? { ...current, state: 'error', message: 'Open PiPi exited before it became ready.' }
            : current;
    }

    async function waitForRelease(runId: string | undefined): Promise<void> {
        const deadline = Date.now() + readyTimeoutMs;
        let current = readLock(dataDir);
        while (current.held && (!runId || current.runId === runId) && Date.now() < deadline) {
            await wait(Math.min(50, Math.max(1, deadline - Date.now())));
            current = readLock(dataDir);
        }
        if (current.held && (!runId || current.runId === runId)) {
            throw new RuntimeLifecycleError('stop_failed', 'Open PiPi did not stop cleanly in time.');
        }
    }

    function assertServiceFileOwned(filePath: string): void {
        if (!io.exists(filePath)) return;
        let content: string;
        try {
            content = io.readTextFile(filePath);
        } catch {
            throw new RuntimeLifecycleError('start_failed', 'The existing background service could not be inspected.');
        }
        if (!content.includes(ownershipMarker) && !content.includes(`<string>${serviceLabel}</string>`)) {
            throw new RuntimeLifecycleError(
                'start_failed',
                'The background service path belongs to a different installation.'
            );
        }
    }

    function sameVerifiedRun(expected: ProcessLockStatus, current: ProcessLockStatus): boolean {
        return (
            expected.held &&
            current.held &&
            current.owner === 'runtime' &&
            expected.runId === current.runId &&
            expected.pid === current.pid
        );
    }

    function signalVerifiedForeground(expected: ProcessLockStatus): void {
        const current = readLock(dataDir);
        if (!sameVerifiedRun(expected, current) || current.mode !== 'foreground' || current.pid === undefined) {
            throw new RuntimeLifecycleError(
                'stop_failed',
                'Runtime ownership changed before it could be stopped safely.'
            );
        }
        runner.signal(current.pid, 'SIGTERM');
    }

    return {
        backgroundSupport: () => supportFor(platform),
        status,
        async start({ mode }) {
            const currentLock = readLock(dataDir);
            if (currentLock.owner === 'setup' && currentLock.held) {
                throw new RuntimeLifecycleError(
                    'setup_active',
                    'Finish setup polling and release setup ownership before starting Open PiPi.'
                );
            }
            if (currentLock.owner === 'runtime' && currentLock.held && currentLock.mode === mode) {
                return mapLockStatus(currentLock);
            }
            if (
                currentLock.owner === 'runtime' &&
                currentLock.held &&
                currentLock.mode === 'background' &&
                mode === 'foreground'
            ) {
                return mapLockStatus(currentLock);
            }
            if (!io.exists(entryPath)) {
                throw new RuntimeLifecycleError('runtime_missing', 'The built Open PiPi runtime was not found.');
            }

            try {
                if (mode === 'foreground') {
                    await runner.spawn(nodePath, runtimeArgs(mode), { cwd: projectRoot });
                } else {
                    const support = supportFor(platform);
                    if (!support.supported) {
                        throw new RuntimeLifecycleError('unsupported_platform', support.explanation);
                    }
                    if (
                        backgroundEnvironment &&
                        backgroundConfigurationMismatches(
                            backgroundEnvironment.effective(),
                            backgroundEnvironment.persistent()
                        ).length > 0
                    ) {
                        throw new RuntimeLifecycleError(
                            'background_config_incomplete',
                            'Background mode cannot use configuration that exists only in the current terminal.'
                        );
                    }
                    if (currentLock.owner === 'runtime' && currentLock.held && currentLock.mode === 'foreground') {
                        signalVerifiedForeground(currentLock);
                        await waitForRelease(currentLock.runId);
                    }
                    const args = [nodePath, ...runtimeArgs(mode)];
                    if (platform === 'darwin') {
                        assertServiceFileOwned(macServicePath);
                        io.writePrivateFile(macServicePath, renderLaunchAgent(args, projectRoot, serviceLabel));
                        await runner.run('launchctl', ['bootstrap', `gui/${uid}`, macServicePath]);
                    } else {
                        assertServiceFileOwned(linuxServicePath);
                        io.writePrivateFile(
                            linuxServicePath,
                            renderSystemdUserService(args, projectRoot, installationId)
                        );
                        await runner.run('systemctl', ['--user', 'daemon-reload']);
                        await runner.run('systemctl', ['--user', 'enable', '--now', serviceName]);
                    }
                }
                return await waitForStartup();
            } catch (error) {
                if (error instanceof RuntimeLifecycleError) throw error;
                throw new RuntimeLifecycleError('start_failed', 'Open PiPi could not be started.');
            }
        },
        async stop() {
            const currentLock = readLock(dataDir);
            try {
                if (currentLock.held && currentLock.owner === 'runtime' && currentLock.mode === 'foreground') {
                    signalVerifiedForeground(currentLock);
                    await waitForRelease(currentLock.runId);
                } else if (
                    (currentLock.held && currentLock.owner === 'runtime' && currentLock.mode === 'background') ||
                    io.exists(platform === 'darwin' ? macServicePath : linuxServicePath)
                ) {
                    assertServiceFileOwned(platform === 'darwin' ? macServicePath : linuxServicePath);
                    if (platform === 'darwin') {
                        await runner.run('launchctl', ['bootout', `gui/${uid}`, macServicePath]);
                    } else if (platform === 'linux') {
                        await runner.run('systemctl', ['--user', 'disable', '--now', serviceName]);
                    }
                    if (currentLock.held) await waitForRelease(currentLock.runId);
                }
                return {
                    state: 'stopped',
                    dataDir,
                    background: false,
                    message: 'Open PiPi stop was requested.',
                };
            } catch {
                throw new RuntimeLifecycleError('stop_failed', 'Open PiPi could not be stopped.');
            }
        },
    };
}
