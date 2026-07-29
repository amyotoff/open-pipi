/**
 * Outbound phone calls, as an optional addon.
 *
 * Nothing here runs unless three things are true: a pack lists `phone` in its
 * enabled capabilities, a provider's environment variables are set, and the
 * owner approves the individual call. Any one of them missing and the addon is
 * inert — which is the intended state for most installs.
 *
 * This is also the repo's worked example of a **subagent**: a delegate that
 * runs where the orchestrator cannot watch it, given a task contract on the way
 * in and returning a result contract on the way out. See docs/addons.md.
 */

export { TASK_TEMPLATES } from './templates';
export {
    buildAnalysisSchema,
    buildCallVariables,
    buildGlobalGuardrails,
    buildTaskPayload,
    inferLanguageFromPhone,
} from './prompt-builder';
export { extractCallResult } from './result-extractor';
export { getVoiceProvider, listVoiceProviders, registerVoiceProvider, resetVoiceProviders } from './registry';
export { RetellVoiceProvider, registerRetellProvider } from './retell-provider';
export type {
    AnalysisSchemaItem,
    CallAnalysis,
    CallMode,
    CallOptions,
    CallOutcome,
    CallResultContract,
    CallTaskPayload,
    CallTaskType,
    CallVariables,
    GuardrailIdentity,
    VoiceProvider,
    VoiceProviderFactory,
} from './types';
