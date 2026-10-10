import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOnboardingStatus } from '../agent-onboarding/status';
import { updateSetupConfig } from '../setup/config-store';
import {
    initializeDialogueEvidence,
    markDialogueAccepted,
    markDialogueDelivered,
    resetDialogueEvidenceRuntimeForTests,
} from '../setup/dialogue-evidence';
import { acquireProcessLock } from '../setup/process-lock';
import {
    readLocalAgentOnboardingStatus,
    runOnboardingStatusCli,
    type OnboardingStatusCliDependencies,
} from './onboarding-status';

let testRoot: string;

beforeEach(() => {
    const parent = path.resolve(process.cwd(), '.tmp');
    fs.mkdirSync(parent, { recursive: true });
    testRoot = fs.mkdtempSync(path.join(parent, 'onboarding-status-'));
});

afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
});

function result(progress: AgentOnboardingStatus['progress']): AgentOnboardingStatus {
    return {
        schemaVersion: 1,
        progress,
        ready: progress === 'dialogue_verified',
        setup: {
            configured: progress !== 'needs_configuration',
            phase: progress.includes('running') ? 'running' : 'ready',
        },
        runtime: { state: progress.includes('running') || progress === 'dialogue_verified' ? 'ready' : 'stopped' },
        dialogueVerified: progress === 'dialogue_verified',
        doctor: { ready: true, failures: [], warnings: [] },
        nextAction: progress === 'dialogue_verified' ? 'none' : 'complete_setup',
    };
}

function dependencies(readStatus = vi.fn(async () => result('needs_configuration'))) {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const value: OnboardingStatusCliDependencies = {
        cwd: process.cwd(),
        stdout,
        stderr,
        readStatus,
    };
    return { value, stdout, stderr, readStatus };
}

describe('onboarding status CLI', () => {
    it('requires an explicit absolute data directory and emits JSON only', async () => {
        const test = dependencies();
        expect(await runOnboardingStatusCli(['--data-dir', 'relative/data'], test.value)).toBe(2);
        expect(JSON.parse(test.stderr.mock.calls[0][0])).toMatchObject({ error: { code: 'USAGE' } });
        expect(test.stdout).not.toHaveBeenCalled();
    });

    it('prints the bounded status as a single JSON document', async () => {
        const test = dependencies(vi.fn(async () => result('running_awaiting_real_reply')));
        expect(await runOnboardingStatusCli(['--', '--data-dir', testRoot], test.value)).toBe(0);
        expect(JSON.parse(test.stdout.mock.calls[0][0])).toMatchObject({
            progress: 'running_awaiting_real_reply',
            ready: false,
        });
        expect(test.stderr).not.toHaveBeenCalled();
    });

    it('returns a secret-free operational failure', async () => {
        const test = dependencies(
            vi.fn(async () => {
                throw new Error('token=private-token identity=777 session=http://private');
            })
        );
        expect(await runOnboardingStatusCli(['--data-dir', testRoot], test.value)).toBe(1);
        const output = test.stderr.mock.calls[0][0];
        expect(JSON.parse(output)).toMatchObject({ error: { code: 'STATUS_UNAVAILABLE' } });
        expect(output).not.toMatch(/private-token|777|http/);
    });

    it('does not create a missing data directory while reading actual setup state', async () => {
        const missing = path.join(testRoot, 'missing-data');
        const status = await readLocalAgentOnboardingStatus({
            cwd: process.cwd(),
            dataDir: missing,
            exportedEnv: {},
            readEnvFile: () => undefined,
        });
        expect(status.progress).toBe('needs_configuration');
        expect(fs.existsSync(missing)).toBe(false);
    });

    it('verifies actual local dialogue against the current runtime run and remains read-only', async () => {
        const dataDir = path.join(testRoot, 'synthetic-data');
        updateSetupConfig(dataDir, {
            settings: {
                LLM_PROVIDER: 'openrouter',
                OWNER_TG_IDS: '424242',
                TZ: 'UTC',
                BOOTSTRAP_PACK: 'jeeves',
                BOOTSTRAP_GROUNDING: 'jeeves_personal',
            },
            credentials: {
                OPENROUTER_API_KEY: 'synthetic-openrouter-key',
                TELEGRAM_BOT_TOKEN: `424242:${'x'.repeat(24)}`,
            },
        });
        let runtimeLock = acquireProcessLock(dataDir, 'runtime', { mode: 'foreground' });
        runtimeLock.markReady();
        initializeDialogueEvidence(dataDir, runtimeLock.runId);
        expect(
            markDialogueAccepted({
                transport: 'telegram',
                endpointType: 'direct',
                endpointId: '424242',
                ownerTelegramId: '424242',
                correlationId: 'synthetic-turn',
            })
        ).toBe(true);
        expect(
            markDialogueDelivered({
                transport: 'telegram',
                endpointType: 'direct',
                endpointId: '424242',
                correlationId: 'synthetic-turn',
            })
        ).toBe(true);

        const snapshot = (): Record<string, string> =>
            Object.fromEntries(
                fs
                    .readdirSync(dataDir)
                    .sort()
                    .map((name) => [name, fs.readFileSync(path.join(dataDir, name), 'utf8')])
            );
        const before = snapshot();
        const fetch = vi.fn(() => {
            throw new Error('Network access is forbidden in the status reader.');
        });
        vi.stubGlobal('fetch', fetch);

        try {
            const options = {
                cwd: process.cwd(),
                dataDir,
                exportedEnv: {},
                readEnvFile: () => undefined,
            };
            expect(await readLocalAgentOnboardingStatus(options)).toMatchObject({
                progress: 'dialogue_verified',
                ready: true,
                dialogueVerified: true,
            });
            expect(snapshot()).toEqual(before);
            expect(fetch).not.toHaveBeenCalled();

            runtimeLock.release();
            runtimeLock = acquireProcessLock(dataDir, 'runtime', { mode: 'foreground' });
            runtimeLock.markReady();
            expect(await readLocalAgentOnboardingStatus(options)).toMatchObject({
                progress: 'running_awaiting_real_reply',
                ready: false,
                dialogueVerified: false,
            });

            runtimeLock.release();
            expect(await readLocalAgentOnboardingStatus(options)).toMatchObject({
                progress: 'configuration_present',
                ready: false,
                dialogueVerified: false,
                runtime: { state: 'stopped' },
            });
        } finally {
            runtimeLock.release();
            resetDialogueEvidenceRuntimeForTests();
            vi.unstubAllGlobals();
        }
    });
});
