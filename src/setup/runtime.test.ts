import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    RuntimeLifecycleError,
    backgroundConfigurationMismatches,
    createRuntimeController,
    renderLaunchAgent,
    renderSystemdUserService,
    type RuntimeCommandRunner,
    type RuntimeLifecycleIO,
} from './runtime';
import type { ProcessLockStatus } from './process-lock';

function stopped(dataDir = '/repo/data'): ProcessLockStatus {
    return { held: false, stale: false, dataDir };
}

function ready(mode: 'foreground' | 'background', dataDir = '/repo/data'): ProcessLockStatus {
    return {
        held: true,
        stale: false,
        owner: 'runtime',
        state: 'ready',
        pid: 4321,
        runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        startedAt: '2026-09-09T10:00:00.000Z',
        readyAt: '2026-09-09T10:00:01.000Z',
        mode,
        dataDir,
    };
}

function harness(
    platform: NodeJS.Platform,
    statuses: ProcessLockStatus[],
    backgroundEnvironment?: { effective(): NodeJS.ProcessEnv; persistent(): NodeJS.ProcessEnv }
) {
    const spawn = vi.fn(async () => 4321);
    const run = vi.fn(async () => undefined);
    const signal = vi.fn();
    const writes: Array<{ filePath: string; content: string }> = [];
    const runner: RuntimeCommandRunner = { spawn, run, signal };
    const io: RuntimeLifecycleIO = {
        exists: (filePath) => filePath === '/repo/dist/index.js',
        readTextFile: () => '',
        writePrivateFile: (filePath, content) => writes.push({ filePath, content }),
    };
    let index = 0;
    const controller = createRuntimeController({
        projectRoot: '/repo',
        dataDir: '/repo/data',
        platform,
        homeDir: '/person',
        uid: 501,
        nodePath: '/usr/bin/node',
        entryPath: '/repo/dist/index.js',
        runner,
        io,
        readLock: () => statuses[Math.min(index++, statuses.length - 1)],
        wait: async () => undefined,
        readyTimeoutMs: 50,
        backgroundEnvironment,
    });
    return { controller, spawn, run, signal, writes };
}

describe('setup runtime lifecycle', () => {
    it.each(['darwin', 'linux'] as const)('refuses to stop an unowned background service on %s', async (platform) => {
        const run = vi.fn(async () => undefined);
        const signal = vi.fn();
        const controller = createRuntimeController({
            platform,
            projectRoot: '/repo',
            dataDir: '/repo/data',
            homeDir: '/person',
            runner: { run, signal, spawn: vi.fn(async () => 4321) },
            io: {
                exists: () => true,
                readTextFile: () => 'This service belongs to another application.',
                writePrivateFile: vi.fn(),
            },
            readLock: () => stopped(),
        });

        await expect(controller.stop()).rejects.toMatchObject({ code: 'stop_failed' });
        expect(run).not.toHaveBeenCalled();
        expect(signal).not.toHaveBeenCalled();
    });

    it('starts foreground with structured argv and reports readiness from the runtime lock', async () => {
        const { controller, spawn } = harness('darwin', [stopped(), stopped(), ready('foreground')]);

        const result = await controller.start({ mode: 'foreground' });

        expect(spawn).toHaveBeenCalledWith(
            '/usr/bin/node',
            ['/repo/dist/index.js', '--runtime-mode=foreground', '--data-dir=/repo/data'],
            { cwd: '/repo' }
        );
        expect(result).toMatchObject({
            state: 'ready',
            mode: 'foreground',
            background: false,
            pid: 4321,
            runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            readyAt: '2026-09-09T10:00:01.000Z',
        });
    });

    it('reports an early child exit as an error instead of staying in starting forever', async () => {
        const { controller } = harness('linux', [stopped()]);

        await expect(controller.start({ mode: 'foreground' })).resolves.toMatchObject({
            state: 'error',
            message: 'Open PiPi exited before it became ready.',
        });
    });

    it('requires setup to release Telegram ownership before starting runtime', async () => {
        const dataDir = '/repo/data';
        const { controller, spawn } = harness('linux', [
            {
                held: true,
                stale: false,
                owner: 'setup',
                state: 'starting',
                pid: 123,
                runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                startedAt: '2026-09-09T10:00:00.000Z',
                dataDir,
            },
        ]);

        await expect(controller.start({ mode: 'foreground' })).rejects.toMatchObject({ code: 'setup_active' });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('writes a macOS user service with escaped argv and no environment or credential values', async () => {
        const { controller, run, writes } = harness('darwin', [stopped(), stopped(), ready('background')]);

        const result = await controller.start({ mode: 'background' });

        expect(writes).toHaveLength(1);
        expect(writes[0].filePath).toMatch(
            /^\/person\/Library\/LaunchAgents\/com\.openpipi\.runtime\.[a-f0-9]{12}\.plist$/
        );
        expect(writes[0].content).toContain('<string>/usr/bin/node</string>');
        expect(writes[0].content).toContain('<string>--runtime-mode=background</string>');
        expect(writes[0].content).not.toContain('EnvironmentVariables');
        expect(writes[0].content).not.toMatch(/API_KEY|BOT_TOKEN|secret/i);
        expect(run).toHaveBeenCalledWith('launchctl', ['bootstrap', 'gui/501', writes[0].filePath]);
        expect(result).toMatchObject({ state: 'ready', background: true });
    });

    it('writes and enables a Linux user service without invoking a shell', async () => {
        const { controller, run, writes } = harness('linux', [stopped(), stopped(), ready('background')]);

        await controller.start({ mode: 'background' });

        expect(writes[0].filePath).toMatch(/^\/person\/\.config\/systemd\/user\/open-pipi-[a-f0-9]{12}\.service$/);
        expect(writes[0].content).toContain(
            'ExecStart="/usr/bin/node" "/repo/dist/index.js" "--runtime-mode=background" "--data-dir=/repo/data"'
        );
        expect(writes[0].content).not.toMatch(/Environment=|API_KEY|BOT_TOKEN|secret/i);
        expect(run.mock.calls).toEqual([
            ['systemctl', ['--user', 'daemon-reload']],
            ['systemctl', ['--user', 'enable', '--now', path.basename(writes[0].filePath)]],
        ]);
    });

    it('refuses background mode when required configuration exists only in exported environment', async () => {
        const exportedOnly = {
            LLM_PROVIDER: 'openrouter',
            LLM_EXECUTOR_MODEL: 'exported/model',
            OPENROUTER_API_KEY: 'exported-secret',
            TELEGRAM_BOT_TOKEN: 'exported-token',
            OWNER_TG_IDS: '77',
        };
        expect(backgroundConfigurationMismatches(exportedOnly, {})).toEqual([
            'LLM_EXECUTOR_MODEL',
            'OPENROUTER_API_KEY',
            'OWNER_TG_IDS',
            'TELEGRAM_BOT_TOKEN',
        ]);
        const runtime = harness('linux', [stopped()], {
            effective: () => exportedOnly,
            persistent: () => ({}),
        });

        await expect(runtime.controller.start({ mode: 'background' })).rejects.toMatchObject({
            code: 'background_config_incomplete',
        });
        expect(runtime.run).not.toHaveBeenCalled();
        expect(runtime.writes).toHaveLength(0);
    });

    it('allows background mode when its persistent setup configuration matches', async () => {
        const persistent = {
            LLM_PROVIDER: 'openrouter',
            LLM_TOOLS_PROVIDER: 'openrouter',
            OPENROUTER_API_KEY: 'persistent-secret',
            TELEGRAM_BOT_TOKEN: 'persistent-token',
            OWNER_TG_IDS: '77',
        };
        expect(backgroundConfigurationMismatches(persistent, persistent)).toEqual([]);
        const runtime = harness('linux', [stopped(), stopped(), ready('background')], {
            effective: () => persistent,
            persistent: () => persistent,
        });

        await expect(runtime.controller.start({ mode: 'background' })).resolves.toMatchObject({ state: 'ready' });
        expect(runtime.run).toHaveBeenCalled();
    });

    it('compares Gemini model aliases through the same resolver as runtime', () => {
        expect(
            backgroundConfigurationMismatches(
                {
                    LLM_PROVIDER: 'gemini',
                    GEMINI_API_KEY: 'persistent-secret',
                    GEMINI_EXECUTOR_MODEL: 'exported-executor',
                    GEMINI_ADVISOR_MODEL: 'exported-advisor',
                },
                { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'persistent-secret' }
            )
        ).toEqual(expect.arrayContaining(['LLM_EXECUTOR_MODEL', 'LLM_ADVISOR_MODEL']));
    });

    it('escapes service arguments as data and rejects unsupported background platforms', async () => {
        const plist = renderLaunchAgent(['/a&b/node', '/tmp/<entry>'], '/work/"quoted"');
        expect(plist).toContain('/a&amp;b/node');
        expect(plist).toContain('/tmp/&lt;entry&gt;');
        expect(plist).toContain('/work/&quot;quoted&quot;');

        const unit = renderSystemdUserService(['/path with spaces/node', '/tmp/100%'], '/work/"quoted"');
        expect(unit).toContain('"/path with spaces/node" "/tmp/100%%"');
        expect(unit).toContain('WorkingDirectory="/work/\\"quoted\\""');

        const { controller } = harness('win32', [stopped()]);
        expect(controller.backgroundSupport()).toMatchObject({ supported: false, platform: 'win32' });
        await expect(controller.start({ mode: 'background' })).rejects.toBeInstanceOf(RuntimeLifecycleError);
    });

    it('stops foreground by PID and background through the owning user service manager', async () => {
        const foreground = harness('linux', [ready('foreground'), ready('foreground'), stopped()]);
        await expect(foreground.controller.stop()).resolves.toMatchObject({ state: 'stopped' });
        expect(foreground.signal).toHaveBeenCalledWith(4321, 'SIGTERM');

        const background = harness('darwin', [ready('background'), ready('background'), stopped()]);
        await background.controller.stop();
        expect(background.run).toHaveBeenCalledWith('launchctl', [
            'bootout',
            'gui/501',
            expect.stringMatching(/^\/person\/Library\/LaunchAgents\/com\.openpipi\.runtime\.[a-f0-9]{12}\.plist$/),
        ]);
    });

    it('does not signal when runtime ownership changes immediately before stop', async () => {
        const changed = { ...ready('foreground'), pid: 9876, runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
        const foreground = harness('linux', [ready('foreground'), changed]);

        await expect(foreground.controller.stop()).rejects.toMatchObject({ code: 'stop_failed' });
        expect(foreground.signal).not.toHaveBeenCalled();
    });

    it('keeps an already running background instance when foreground is requested', async () => {
        const background = harness('darwin', [ready('background')]);

        await expect(background.controller.start({ mode: 'foreground' })).resolves.toMatchObject({
            state: 'ready',
            mode: 'background',
        });
        expect(background.spawn).not.toHaveBeenCalled();
        expect(background.run).not.toHaveBeenCalled();
    });

    it('stops an owned foreground run before switching to background', async () => {
        const foreground = ready('foreground');
        const background = ready('background');
        const { controller, signal, run } = harness('linux', [
            foreground,
            foreground,
            stopped(),
            stopped(),
            background,
        ]);

        await expect(controller.start({ mode: 'background' })).resolves.toMatchObject({
            state: 'ready',
            mode: 'background',
        });
        expect(signal).toHaveBeenCalledWith(4321, 'SIGTERM');
        expect(run).toHaveBeenCalledWith('systemctl', [
            '--user',
            'enable',
            '--now',
            expect.stringMatching(/^open-pipi-[a-f0-9]{12}\.service$/),
        ]);
    });
});
