import fs from 'node:fs';
import path from 'node:path';
import { composeAgentOnboardingStatus, type AgentOnboardingStatus } from '../agent-onboarding/status';
import {
    getSetupConfigPaths,
    loadOperatorEnvironment,
    readSetupConfig,
    resolveSetupEnvironment,
} from '../setup/config-store';
import { isDialogueVerified } from '../setup/dialogue-evidence';
import { readOwnerSetupStatus } from '../setup/owner-context';
import { createRuntimeController } from '../setup/runtime';
import { createSetupService } from '../setup/service';
import { inspectDoctor } from './doctor';

export type OnboardingStatusCliDependencies = {
    cwd: string;
    stdout(message: string): void;
    stderr(message: string): void;
    readStatus(dataDir: string): Promise<AgentOnboardingStatus>;
};

export async function readLocalAgentOnboardingStatus(options: {
    cwd: string;
    dataDir: string;
    exportedEnv?: NodeJS.ProcessEnv;
    readEnvFile?: (filePath: string) => string | undefined;
}): Promise<AgentOnboardingStatus> {
    const cwd = path.resolve(options.cwd);
    const dataDir = path.resolve(options.dataDir);
    const operatorEnv = loadOperatorEnvironment(cwd, options.exportedEnv ?? process.env, options.readEnvFile);
    operatorEnv.DATA_DIR = dataDir;
    const stored = readSetupConfig(dataDir);
    const effective = resolveSetupEnvironment(operatorEnv, { cwd, dataDir });
    const ownerTelegramIds = (): string[] => {
        const direct = (effective.OWNER_TG_IDS || '').split(',');
        const identities = (effective.OWNER_IDENTITIES || '')
            .split(',')
            .filter((identity) => identity.trim().toLowerCase().startsWith('telegram:'))
            .map((identity) => identity.trim().slice('telegram:'.length));
        return [...new Set([...direct, ...identities].map((id) => id.trim()).filter(Boolean))];
    };
    const runtime = createRuntimeController({ projectRoot: cwd, dataDir });
    const service = await createSetupService({
        dataDir,
        operatorEnv,
        runtime,
        readOnly: true,
        getStatusExtension: () => ({
            ...readOwnerSetupStatus({ dataDir, ownerTelegramIds: ownerTelegramIds(), projectRoot: cwd }),
            dialogueVerified: isDialogueVerified(dataDir, ownerTelegramIds()),
        }),
    });
    try {
        const setupStatus = await service.status();
        const paths = getSetupConfigPaths(dataDir);
        const doctorChecks = inspectDoctor({
            cwd,
            nodeVersion: process.versions.node,
            envFileFound: fs.existsSync(path.join(cwd, '.env')),
            localConfigFound: fs.existsSync(paths.settings) || fs.existsSync(paths.credentials),
            env: { ...stored.settings, ...stored.credentials, ...effective, DATA_DIR: dataDir },
        });
        return composeAgentOnboardingStatus(setupStatus, doctorChecks);
    } finally {
        await service.dispose();
    }
}

function defaultDependencies(): OnboardingStatusCliDependencies {
    const cwd = process.cwd();
    return {
        cwd,
        stdout: (message) => process.stdout.write(message),
        stderr: (message) => process.stderr.write(message),
        readStatus: (dataDir) => readLocalAgentOnboardingStatus({ cwd, dataDir }),
    };
}

function parseDataDir(argv: readonly string[]): string | null {
    const args = argv.filter((argument) => argument !== '--');
    let value: string | undefined;
    if (args.length === 2 && args[0] === '--data-dir') value = args[1];
    if (args.length === 1 && args[0].startsWith('--data-dir=')) value = args[0].slice('--data-dir='.length);
    if (!value || !path.isAbsolute(value) || value.includes('\0')) return null;
    return path.resolve(value);
}

function safeError(code: 'USAGE' | 'STATUS_UNAVAILABLE', message: string): string {
    return `${JSON.stringify({ schemaVersion: 1, error: { code, message } })}\n`;
}

export async function runOnboardingStatusCli(
    argv: readonly string[],
    dependencies: OnboardingStatusCliDependencies = defaultDependencies()
): Promise<number> {
    const dataDir = parseDataDir(argv);
    if (!dataDir) {
        dependencies.stderr(
            safeError('USAGE', 'Use --data-dir with the absolute path to the existing Open PiPi data directory.')
        );
        return 2;
    }
    try {
        dependencies.stdout(`${JSON.stringify(await dependencies.readStatus(dataDir))}\n`);
        return 0;
    } catch {
        dependencies.stderr(safeError('STATUS_UNAVAILABLE', 'Open PiPi onboarding status could not be read.'));
        return 1;
    }
}

export function isOnboardingStatusCli(argvEntry = process.argv[1], moduleFile = __filename): boolean {
    return require.main === module || Boolean(argvEntry && path.resolve(argvEntry) === path.resolve(moduleFile));
}

if (isOnboardingStatusCli()) {
    void runOnboardingStatusCli(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    });
}
