import { describe, expect, it } from 'vitest';
import {
    mergeSpaceOperationalPolicy,
    resolveSpaceOperationalSettings,
    normalizeSpaceChannelMode,
    normalizeSpaceOnboardingState,
} from './space-preferences';

describe('core/space-preferences', () => {
    it('resolves safe defaults for existing spaces', () => {
        expect(resolveSpaceOperationalSettings(null)).toEqual({
            onboarding_state: 'active',
            setup_version: 1,
            channel_mode: 'full',
        });
    });

    it('supports a new-space onboarding default override', () => {
        expect(resolveSpaceOperationalSettings('{}', { defaultOnboardingState: 'new' })).toEqual({
            onboarding_state: 'new',
            setup_version: 1,
            channel_mode: 'full',
        });
    });

    it('falls back for invalid onboarding and channel mode values', () => {
        expect(normalizeSpaceOnboardingState('weird')).toBe('active');
        expect(normalizeSpaceChannelMode('sidecar')).toBe('full');
        expect(
            resolveSpaceOperationalSettings(
                JSON.stringify({
                    onboarding_state: '???',
                    setup_version: 0,
                    channel_mode: '???',
                })
            )
        ).toEqual({
            onboarding_state: 'active',
            setup_version: 1,
            channel_mode: 'full',
        });
    });

    it('merges known operational keys while preserving unrelated policy fields', () => {
        expect(
            mergeSpaceOperationalPolicy(
                JSON.stringify({
                    browser: true,
                    channel_mode: 'off',
                    custom_flag: 'keep-me',
                }),
                {
                    onboarding_state: 'new',
                    channel_mode: 'notify_only',
                }
            )
        ).toEqual({
            browser: true,
            custom_flag: 'keep-me',
            onboarding_state: 'new',
            setup_version: 1,
            channel_mode: 'notify_only',
        });
    });

    it('ignores undefined patches and keeps normalized base settings', () => {
        expect(
            mergeSpaceOperationalPolicy(
                JSON.stringify({
                    onboarding_state: 'active',
                    channel_mode: 'inbox',
                    setup_version: 2,
                }),
                {
                    onboarding_state: undefined,
                    channel_mode: undefined,
                }
            )
        ).toEqual({
            onboarding_state: 'active',
            setup_version: 2,
            channel_mode: 'inbox',
        });
    });
});
