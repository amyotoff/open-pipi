import { describe, expect, it } from 'vitest';
import { authorityPresetForRole, effectiveAuthority, hasTrustFlag, shouldEscalateAuthorityConflict } from './authority';

describe('core/authority', () => {
    it('provides strong defaults for owners', () => {
        const profile = authorityPresetForRole('owner');

        expect(profile.base_authority).toBe(1000);
        expect(hasTrustFlag(profile, 'can_assign_tasks')).toBe(true);
        expect(hasTrustFlag(profile, 'can_change_policies')).toBe(true);
        expect(hasTrustFlag(profile, 'can_override_instructions')).toBe(true);
        expect(hasTrustFlag(profile, 'can_issue_high_impact_commands')).toBe(true);
    });

    it('keeps service bots low-authority by default', () => {
        const profile = authorityPresetForRole('service_bot');

        expect(profile.base_authority).toBe(10);
        expect(hasTrustFlag(profile, 'can_assign_tasks')).toBe(false);
    });

    it('computes effective authority and escalation threshold simply', () => {
        const owner = { base_authority: 1000, reputation_delta: 0 };
        const member = { base_authority: 100, reputation_delta: 50 };

        expect(effectiveAuthority(owner)).toBe(1000);
        expect(effectiveAuthority(member)).toBe(150);
        expect(shouldEscalateAuthorityConflict(owner, member)).toBe(false);
        expect(shouldEscalateAuthorityConflict(member, { base_authority: 100, reputation_delta: -50 })).toBe(true);
    });
});
