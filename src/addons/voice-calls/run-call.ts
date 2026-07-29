/**
 * Placing a call, and reducing what comes back.
 *
 * The extraction lives here rather than inside each provider on purpose. A
 * provider's job is to get a conversation to happen and report what it heard;
 * turning that into a result contract is the addon's job, and identical for
 * every backend. Leaving it to providers means a new one can forget, and the
 * failure is silent — a call that went through, returning nothing.
 */

import { extractCallResult } from './result-extractor';
import type { CallOptions, CallOutcome, VoiceProvider } from './types';

export async function runCall(provider: VoiceProvider, toNumber: string, options: CallOptions): Promise<CallOutcome> {
    const outcome = await provider.placeCall(toNumber, options);

    return {
        ...outcome,
        // Recomputed even when a provider supplied one, so there is exactly one
        // implementation of what a result means.
        structuredResult: extractCallResult(
            outcome.transcript,
            outcome.analysis,
            options.payload.task_type,
            outcome.status
        ),
    };
}
