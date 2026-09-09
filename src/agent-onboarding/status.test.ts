import { describe, expect, it } from 'vitest';
import type { DoctorCheck } from '../scripts/doctor';
import type { SetupSafeStatus } from '../setup/service';
import { composeAgentOnboardingStatus } from './status';

function setup(
    overrides: {
        configured?: boolean;
        runtime?: 'stopped' | 'starting' | 'ready' | 'error';
        dialogueVerified?: boolean;
    } = {}
): SetupSafeStatus {
    const configured = overrides.configured ?? true;
    return {
        phase: overrides.runtime === 'ready' ? 'running' : configured ? 'ready' : 'ai',
        metadata: { profilePresent: false },
        provider: { status: 'checking', kind: 'openrouter', model: 'model', configured, validated: false },
        telegram: { status: 'checking', configured, validated: false, webhookConflict: false },
        owners: { existing: configured, count: configured ? 1 : 0, status: configured ? 'ready' : 'missing' },
        pairing: { active: false },
        profile: { initialPack: 'jeeves', currentPack: 'jeeves' },
        runtime: {
            state: overrides.runtime ?? 'stopped',
            dataDir: '/synthetic/data',
            background: false,
            message: 'internal message',
            dialogueVerified: overrides.dialogueVerified ?? false,
        },
        background: { supported: true, platform: 'linux', explanation: 'internal explanation' },
        completed: configured,
    };
}

const healthy: DoctorCheck[] = [{ id: 'node', label: 'Node', status: 'pass', message: 'secret-free' }];

describe('agent onboarding status contract', () => {
    it('distinguishes missing configuration and exposes only bounded doctor IDs', () => {
        const output = composeAgentOnboardingStatus(setup({ configured: false }), [
            { id: 'telegram-token', label: 'Token', status: 'fail', message: 'value secret-123 is missing' },
            { id: 'bad id containing secret-123', label: 'Unsafe', status: 'warn', message: 'secret-123' },
        ]);
        expect(output).toMatchObject({
            progress: 'needs_configuration',
            ready: false,
            doctor: { ready: false, failures: ['telegram-token'], warnings: ['unknown'] },
            nextAction: 'complete_setup',
        });
        expect(JSON.stringify(output)).not.toContain('secret-123');
    });

    it('distinguishes configuration presence, starting, running and dialogue-verified states', () => {
        expect(composeAgentOnboardingStatus(setup(), healthy)).toMatchObject({
            progress: 'configuration_present',
            nextAction: 'validate_in_setup',
        });
        expect(composeAgentOnboardingStatus(setup({ runtime: 'starting' }), healthy)).toMatchObject({
            progress: 'configuration_present',
            nextAction: 'wait_for_runtime',
        });
        expect(composeAgentOnboardingStatus(setup({ runtime: 'ready' }), healthy)).toMatchObject({
            progress: 'running_awaiting_real_reply',
            ready: false,
            nextAction: 'send_real_owner_message_and_wait_for_reply',
        });
        expect(
            composeAgentOnboardingStatus(setup({ runtime: 'ready', dialogueVerified: true }), healthy)
        ).toMatchObject({ progress: 'dialogue_verified', ready: true, nextAction: 'none' });
    });

    it('does not accept dialogue evidence without a ready runtime', () => {
        expect(composeAgentOnboardingStatus(setup({ dialogueVerified: true }), healthy)).toMatchObject({
            progress: 'configuration_present',
            dialogueVerified: false,
            ready: false,
        });
    });
});
