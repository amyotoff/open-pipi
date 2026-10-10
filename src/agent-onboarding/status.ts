import type { DoctorCheck } from '../scripts/doctor';
import type { RuntimeMode } from '../setup/process-lock';
import type { SetupSafeStatus, SetupStage } from '../setup/service';
import type { RuntimeState } from '../setup/runtime';

export type AgentOnboardingProgress =
    | 'needs_configuration'
    | 'configuration_present'
    | 'running_awaiting_real_reply'
    | 'dialogue_verified';

export type AgentOnboardingNextAction =
    | 'complete_setup'
    | 'validate_in_setup'
    | 'wait_for_runtime'
    | 'send_real_owner_message_and_wait_for_reply'
    | 'none';

export type AgentOnboardingStatus = {
    schemaVersion: 1;
    progress: AgentOnboardingProgress;
    ready: boolean;
    /** `configured` means required values are present; read-only status does not validate them remotely. */
    setup: { configured: boolean; phase: SetupStage };
    runtime: { state: RuntimeState; mode?: RuntimeMode };
    dialogueVerified: boolean;
    doctor: { ready: boolean; failures: string[]; warnings: string[] };
    nextAction: AgentOnboardingNextAction;
};

function safeCheckIds(checks: readonly DoctorCheck[], status: 'fail' | 'warn'): string[] {
    return checks
        .filter((item) => item.status === status)
        .map((item) => (/^[a-z0-9-]{1,64}$/i.test(item.id) ? item.id : 'unknown'));
}

/** Reduce existing read-only setup/doctor evidence to a bounded, non-secret progress contract. */
export function composeAgentOnboardingStatus(
    setupStatus: SetupSafeStatus,
    doctorChecks: readonly DoctorCheck[]
): AgentOnboardingStatus {
    const failures = safeCheckIds(doctorChecks, 'fail');
    const warnings = safeCheckIds(doctorChecks, 'warn');
    const doctorReady = failures.length === 0;
    const setupConfigured =
        setupStatus.provider.configured && setupStatus.telegram.configured && setupStatus.owners.existing;
    const runtimeReady = setupStatus.runtime.state === 'ready';
    const dialogueVerified = runtimeReady && setupStatus.runtime.dialogueVerified === true;

    const progress: AgentOnboardingProgress = dialogueVerified
        ? 'dialogue_verified'
        : runtimeReady
          ? 'running_awaiting_real_reply'
          : setupConfigured && doctorReady
            ? 'configuration_present'
            : 'needs_configuration';
    const nextAction: AgentOnboardingNextAction =
        progress === 'dialogue_verified'
            ? 'none'
            : progress === 'running_awaiting_real_reply'
              ? 'send_real_owner_message_and_wait_for_reply'
              : setupStatus.runtime.state === 'starting'
                ? 'wait_for_runtime'
                : progress === 'configuration_present'
                  ? 'validate_in_setup'
                  : 'complete_setup';

    return {
        schemaVersion: 1,
        progress,
        ready: progress === 'dialogue_verified',
        setup: { configured: setupConfigured, phase: setupStatus.phase },
        runtime: {
            state: setupStatus.runtime.state,
            ...(setupStatus.runtime.mode ? { mode: setupStatus.runtime.mode } : {}),
        },
        dialogueVerified,
        doctor: { ready: doctorReady, failures, warnings },
        nextAction,
    };
}
