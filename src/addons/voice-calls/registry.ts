/**
 * Which telephony backend to use, if any.
 *
 * Providers register a factory rather than an instance, because "is this
 * configured" is a question about the environment and the answer can change
 * between a test and the next test. The factory returns null when its
 * configuration is absent, which is the normal case: most installs never turn
 * calling on.
 */

import type { VoiceProvider, VoiceProviderFactory } from './types';

const factories = new Map<string, VoiceProviderFactory>();

/** `undefined` means "not resolved yet", `null` means "resolved to nothing". */
let resolved: VoiceProvider | null | undefined;

export function registerVoiceProvider(name: string, factory: VoiceProviderFactory): void {
    factories.set(name, factory);
    resolved = undefined;
}

/**
 * The active provider, or null when calling is not configured.
 *
 * First configured registration wins. There is no ranking because there is no
 * sensible way to rank two working phone lines.
 */
export function getVoiceProvider(): VoiceProvider | null {
    if (resolved !== undefined) return resolved;

    for (const factory of factories.values()) {
        const provider = factory();
        if (provider?.isConfigured()) {
            resolved = provider;
            return resolved;
        }
    }

    resolved = null;
    return resolved;
}

export function listVoiceProviders(): string[] {
    return [...factories.keys()];
}

/** Test seam: forget both the registrations and the resolution. */
export function resetVoiceProviders(): void {
    factories.clear();
    resolved = undefined;
}
