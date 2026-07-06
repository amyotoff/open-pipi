export type TrustFlag =
    | 'can_assign_tasks'
    | 'can_change_policies'
    | 'can_override_instructions'
    | 'can_issue_high_impact_commands';

export type TrustFlags = Record<TrustFlag, boolean>;

export interface AuthorityProfile {
    base_authority: number;
    reputation_delta: number;
    trust_flags: TrustFlags;
    authority_note: string;
}

export const DEFAULT_AUTHORITY_THRESHOLD = 300;

export function emptyTrustFlags(): TrustFlags {
    return {
        can_assign_tasks: false,
        can_change_policies: false,
        can_override_instructions: false,
        can_issue_high_impact_commands: false,
    };
}

export function authorityPresetForRole(role: string): AuthorityProfile {
    const normalized = role.toLowerCase();

    if (normalized === 'owner' || normalized === 'admin') {
        return {
            base_authority: 1000,
            reputation_delta: 0,
            trust_flags: {
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            },
            authority_note: 'space owner',
        };
    }

    if (normalized === 'manager') {
        return {
            base_authority: 500,
            reputation_delta: 0,
            trust_flags: {
                can_assign_tasks: true,
                can_change_policies: false,
                can_override_instructions: true,
                can_issue_high_impact_commands: false,
            },
            authority_note: 'manager',
        };
    }

    if (normalized === 'bot' || normalized === 'service_bot') {
        return {
            base_authority: 10,
            reputation_delta: 0,
            trust_flags: emptyTrustFlags(),
            authority_note: 'service bot',
        };
    }

    if (normalized === 'guest') {
        return {
            base_authority: 30,
            reputation_delta: 0,
            trust_flags: emptyTrustFlags(),
            authority_note: 'guest',
        };
    }

    return {
        base_authority: 100,
        reputation_delta: 0,
        trust_flags: {
            can_assign_tasks: true,
            can_change_policies: false,
            can_override_instructions: false,
            can_issue_high_impact_commands: false,
        },
        authority_note: 'member',
    };
}

export function effectiveAuthority(profile: Pick<AuthorityProfile, 'base_authority' | 'reputation_delta'>): number {
    return profile.base_authority + profile.reputation_delta;
}

export function hasTrustFlag(profile: Pick<AuthorityProfile, 'trust_flags'>, flag: TrustFlag): boolean {
    return !!profile.trust_flags[flag];
}

export function authorityGap(
    left: Pick<AuthorityProfile, 'base_authority' | 'reputation_delta'>,
    right: Pick<AuthorityProfile, 'base_authority' | 'reputation_delta'>
): number {
    return effectiveAuthority(left) - effectiveAuthority(right);
}

export function shouldEscalateAuthorityConflict(
    left: Pick<AuthorityProfile, 'base_authority' | 'reputation_delta'>,
    right: Pick<AuthorityProfile, 'base_authority' | 'reputation_delta'>,
    options?: { threshold?: number; highImpact?: boolean }
): boolean {
    const threshold = options?.threshold ?? DEFAULT_AUTHORITY_THRESHOLD;
    if (options?.highImpact) return true;
    return Math.abs(authorityGap(left, right)) < threshold;
}
