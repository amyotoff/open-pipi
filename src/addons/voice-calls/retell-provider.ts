/**
 * Retell.ai as the telephony backend.
 *
 * One agent configured once in Retell's dashboard, parameterized per call
 * through dynamic variables. That is the whole trick: the prompt lives with
 * the provider, the task lives here, and neither has to know much about the
 * other.
 *
 * Results are polled rather than pushed. A webhook would be faster, but it
 * needs a publicly reachable URL — and this runtime is meant to work on a Pi
 * behind a home router, where that is a real obstacle rather than a detail.
 *
 * The SDK is an optional dependency and is imported lazily, so an install that
 * never makes calls neither carries it nor fails without it.
 */

import { logInfo, logWarn } from '../../utils/logging';
import { buildAnalysisSchema, buildCallVariables } from './prompt-builder';
import { registerVoiceProvider } from './registry';
import type { CallOptions, CallOutcome, VoiceProvider } from './types';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 300_000;

/**
 * Post-call extraction is computed after the line drops, so a call that has
 * just ended usually has no analysis yet. Wait for it rather than reporting a
 * finished call as having produced nothing.
 */
const ANALYSIS_GRACE_MS = 60_000;

/** Retell wants BCP-47; the rest of the addon speaks ISO 639-1. */
function toRetellLocale(language?: string): string {
    if (!language || language === 'multi') return 'multi';

    const locales: Record<string, string> = {
        it: 'it-IT',
        ru: 'ru-RU',
        es: 'es-ES',
        en: 'en-US',
        nl: 'nl-NL',
        pl: 'pl-PL',
        fr: 'fr-FR',
        de: 'de-DE',
        pt: 'pt-PT',
        ka: 'ka-GE',
        tr: 'tr-TR',
        ja: 'ja-JP',
    };

    return locales[language] || 'multi';
}

export interface RetellProviderConfig {
    apiKey: string;
    agentId: string;
    fromNumber: string;
}

export class RetellVoiceProvider implements VoiceProvider {
    readonly name = 'retell';

    constructor(private readonly config: RetellProviderConfig) {}

    isConfigured(): boolean {
        return Boolean(this.config.apiKey && this.config.agentId && this.config.fromNumber);
    }

    /**
     * The SDK is not a dependency of this repo at all.
     *
     * Deliberately loaded through a variable specifier so TypeScript does not
     * try to resolve it either: an install that will never make a phone call
     * should not carry a telephony SDK, and should not fail to typecheck for
     * lacking one. Anyone turning calling on installs it themselves.
     */
    private async client(): Promise<any> {
        const moduleName = 'retell-sdk';

        try {
            const imported: any = await import(moduleName);
            const Retell = imported.default ?? imported;
            return new Retell({ apiKey: this.config.apiKey });
        } catch (error) {
            throw new Error(
                'Calling needs the retell-sdk package, which is not installed. Run `pnpm add retell-sdk`.',
                { cause: error }
            );
        }
    }

    async placeCall(toNumber: string, options: CallOptions): Promise<CallOutcome> {
        const client = await this.client();
        const variables = buildCallVariables(options.payload, options.identity);

        logInfo('VOICE', 'call_started', {
            provider: this.name,
            task_type: options.payload.task_type,
            language: variables.expected_language,
        });

        const call = await client.call.createPhoneCall({
            from_number: this.config.fromNumber,
            to_number: toNumber,
            override_agent_id: this.config.agentId,
            retell_llm_dynamic_variables: variables,
            metadata: {
                task_type: options.payload.task_type,
                call_mode: options.payload.call_mode,
                ...options.metadata,
            },
            agent_override: {
                agent: {
                    language: toRetellLocale(options.payload.expected_language),
                    post_call_analysis_data: buildAnalysisSchema(options.payload.task_type),
                },
            },
        });

        const outcome = await this.waitForCall(client, call.call_id);

        logInfo('VOICE', 'call_finished', {
            provider: this.name,
            disconnection: outcome.status,
            has_analysis: Boolean(outcome.analysis),
        });

        // Reducing this to a result contract is runCall's job, not a
        // provider's — see run-call.ts.
        return outcome;
    }

    private async waitForCall(client: any, callId: string): Promise<CallOutcome> {
        const startedAt = Date.now();
        let endedAt: number | null = null;

        while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

            const call = await client.call.retrieve(callId);
            if (call.call_status !== 'ended' && call.call_status !== 'error') continue;

            endedAt ??= Date.now();

            const analysis = call.call_analysis;
            const hasAnalysis =
                Boolean(analysis?.call_summary) || Object.keys(analysis?.custom_analysis_data ?? {}).length > 0;

            if (!hasAnalysis && Date.now() - endedAt < ANALYSIS_GRACE_MS) continue;

            if (!hasAnalysis) {
                logWarn('VOICE', 'analysis_missing', { call_id: callId });
            }

            return {
                transcript: call.transcript || '',
                duration_ms: call.end_timestamp && call.start_timestamp ? call.end_timestamp - call.start_timestamp : 0,
                status: call.disconnection_reason || 'completed',
                summary: analysis?.call_summary || '',
                analysis,
            };
        }

        throw new Error(`Call ${callId} did not finish within ${POLL_TIMEOUT_MS / 1000} seconds.`);
    }
}

/**
 * Register Retell as a candidate backend.
 *
 * Call this from wherever the addon is wired up. It is not done at import time
 * so that importing the addon's pure parts — for a test, or for another
 * provider — does not quietly register a phone line.
 */
export function registerRetellProvider(): void {
    registerVoiceProvider('retell', () => {
        const apiKey = process.env.RETELL_API_KEY;
        const agentId = process.env.RETELL_AGENT_ID;
        const fromNumber = process.env.RETELL_FROM_NUMBER;

        if (!apiKey || !agentId || !fromNumber) return null;

        return new RetellVoiceProvider({ apiKey, agentId, fromNumber });
    });
}
