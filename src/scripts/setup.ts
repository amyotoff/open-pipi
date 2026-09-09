import { spawn } from 'node:child_process';
import path from 'node:path';
import { renderSetupPage } from '../setup/page';
import { loadOperatorEnvironment, readSetupConfig, resolveSetupEnvironment } from '../setup/config-store';
import { createRuntimeController } from '../setup/runtime';
import { startSetupServer } from '../setup/server';
import { createSetupService, type SetupService } from '../setup/service';
import { isDialogueVerified } from '../setup/dialogue-evidence';
import { readOwnerSetupStatus, saveOwnerContext } from '../setup/owner-context';
import { createAgentOnboardingService } from '../agent-onboarding/service';

type SetupCliService = SetupService;

type SetupCliServer = {
    url: string;
    origin: string;
    close(): Promise<void>;
};

export type SetupCliDependencies = {
    platform: NodeJS.Platform;
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdout(message: string): void;
    stderr(message: string): void;
    createService(options: { readOnly: boolean }): Promise<SetupCliService>;
    startServer(service: SetupCliService, options?: { agentOnboarding: boolean }): Promise<SetupCliServer>;
    openUrl(url: string, platform: NodeJS.Platform): Promise<boolean>;
    onceSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
};

function openWithPlatform(url: string, platform: NodeJS.Platform): Promise<boolean> {
    const command =
        platform === 'darwin'
            ? { file: 'open', args: [url] }
            : platform === 'linux'
              ? { file: 'xdg-open', args: [url] }
              : platform === 'win32'
                ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }
                : null;

    if (!command) return Promise.resolve(false);
    return new Promise((resolve) => {
        let settled = false;
        const finish = (opened: boolean): void => {
            if (settled) return;
            settled = true;
            resolve(opened);
        };
        const child = spawn(command.file, command.args, { stdio: 'ignore', shell: false });
        child.once('error', () => finish(false));
        child.once('exit', (code) => finish(code === 0));
    });
}

function defaultDependencies(): SetupCliDependencies {
    const cwd = process.cwd();
    // Load only the operator layer here. The service adds its setup store below
    // this layer, so old stored values never become immutable env overrides.
    const env = loadOperatorEnvironment(cwd, process.env);
    const dataDir = path.resolve(cwd, env.DATA_DIR || 'data');
    const ownerTelegramIds = (): string[] => {
        const stored = readSetupConfig(dataDir).settings;
        const effective = { ...stored, ...env };
        const direct = (effective.OWNER_TG_IDS || '').split(',');
        const identities = (effective.OWNER_IDENTITIES || '')
            .split(',')
            .filter((identity) => identity.trim().toLowerCase().startsWith('telegram:'))
            .map((identity) => identity.trim().slice('telegram:'.length));
        return [...new Set([...direct, ...identities].map((id) => id.trim()).filter(Boolean))];
    };

    return {
        platform: process.platform,
        cwd,
        env,
        stdout: (message) => process.stdout.write(message),
        stderr: (message) => process.stderr.write(message),
        createService: async ({ readOnly }) => {
            const runtime = createRuntimeController({
                projectRoot: cwd,
                dataDir,
                backgroundEnvironment: {
                    effective: () => resolveSetupEnvironment(env, { cwd, dataDir }),
                    persistent: () => resolveSetupEnvironment(loadOperatorEnvironment(cwd, {}), { cwd, dataDir }),
                },
            });
            return createSetupService({
                dataDir,
                operatorEnv: env,
                runtime,
                readOnly,
                saveProfileCard: (context) => {
                    saveOwnerContext(dataDir, context);
                },
                getStatusExtension: () => ({
                    ...readOwnerSetupStatus({ dataDir, ownerTelegramIds: ownerTelegramIds(), projectRoot: cwd }),
                    dialogueVerified: isDialogueVerified(dataDir, ownerTelegramIds()),
                }),
            });
        },
        startServer: (service, options) =>
            startSetupServer({
                service,
                renderSetupPage: (input) => renderSetupPage({ ...input, agentOnboarding: options?.agentOnboarding }),
                ...(options?.agentOnboarding ? { onboarding: createAgentOnboardingService({ dataDir }) } : {}),
            }),
        openUrl: openWithPlatform,
        onceSignal: (signal, handler) => process.once(signal, handler),
    };
}

function formatCliError(error: unknown): string {
    const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? ` (${error.code})`
            : '';
    return `Open PiPi setup could not start${code}. Check the local data directory and run the command again.\n`;
}

export async function runSetupCli(
    argv: readonly string[],
    dependencies: SetupCliDependencies = defaultDependencies()
): Promise<number> {
    const json = argv.includes('--json');
    const showLink = argv.includes('--show-link');
    const agentOnboarding = argv.includes('--agent-onboarding');
    const unknown = argv.filter(
        (argument) => !['--json', '--show-link', '--agent-onboarding', '--'].includes(argument)
    );
    if (unknown.length > 0 || (json && (showLink || agentOnboarding))) {
        dependencies.stderr('Usage: pnpm setup [-- --json|--show-link] [--agent-onboarding]\n');
        return 2;
    }

    let service: SetupCliService | undefined;
    let server: SetupCliServer | undefined;
    try {
        service = await dependencies.createService({ readOnly: json });
        if (json) {
            const status = await service.status();
            dependencies.stdout(`${JSON.stringify(status, null, 2)}\n`);
            await service.dispose();
            return 0;
        }

        server = agentOnboarding
            ? await dependencies.startServer(service, { agentOnboarding: true })
            : await dependencies.startServer(service);
        if (showLink) {
            dependencies.stdout(`Short-lived local setup link (keep private): ${server.url}\n`);
        } else {
            const opened = await dependencies.openUrl(server.url, dependencies.platform);
            if (!opened) {
                await server.close();
                await service.dispose();
                dependencies.stderr(
                    'Could not open the setup page. Run `pnpm setup -- --show-link` in your own private terminal.\n'
                );
                return 1;
            }
            dependencies.stdout(`Open PiPi setup opened in your browser at ${server.origin}.\n`);
        }

        let closing = false;
        const close = (): void => {
            if (closing) return;
            closing = true;
            void (async () => {
                await server?.close();
                await service?.dispose();
                dependencies.stdout('Open PiPi setup stopped.\n');
            })();
        };
        dependencies.onceSignal('SIGINT', close);
        dependencies.onceSignal('SIGTERM', close);
        return 0;
    } catch (error) {
        if (server) await server.close().catch(() => undefined);
        if (service) await service.dispose().catch(() => undefined);
        dependencies.stderr(formatCliError(error));
        return 1;
    }
}

export function isSetupCli(argvEntry = process.argv[1], moduleFile = __filename): boolean {
    return require.main === module || Boolean(argvEntry && path.resolve(argvEntry) === path.resolve(moduleFile));
}

if (isSetupCli()) {
    void runSetupCli(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    });
}
