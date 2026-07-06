export const MEMBERS_USAGE = `Usage:
/members
/members show <person_id|@username|nickname|display name>
/members role <person_id|@username|nickname|display name> <owner|admin|manager|member|guest|service_bot>
/members rep <person_id|@username|nickname|display name> <number>
/members trust <person_id|@username|nickname|display name> <can_assign_tasks|can_change_policies|can_override_instructions|can_issue_high_impact_commands> <on|off>

Tip: reply to someone's message and use:
/members
/members role <role>
/members rep <number>
/members trust <flag> <on|off>`;

type TrustFlagName =
    | 'can_assign_tasks'
    | 'can_change_policies'
    | 'can_override_instructions'
    | 'can_issue_high_impact_commands';

const TRUST_FLAGS: TrustFlagName[] = [
    'can_assign_tasks',
    'can_change_policies',
    'can_override_instructions',
    'can_issue_high_impact_commands',
];

const ROLES = ['owner', 'admin', 'manager', 'member', 'guest', 'service_bot'] as const;
type RoleName = (typeof ROLES)[number];

export type MembersCommandRequest =
    | { action: 'list' }
    | { action: 'show'; selector: string }
    | { action: 'role'; selector: string; role: string }
    | { action: 'rep'; selector: string; reputation_delta: number }
    | {
          action: 'trust';
          selector: string;
          flag: TrustFlagName;
          enabled: boolean;
      }
    | { action: 'usage'; message: string };

function parseToggle(value: string): boolean | null {
    const normalized = value.trim().toLowerCase();
    if (['on', 'true', '1', 'yes'].includes(normalized)) return true;
    if (['off', 'false', '0', 'no'].includes(normalized)) return false;
    return null;
}

function usage(): MembersCommandRequest {
    return { action: 'usage', message: MEMBERS_USAGE };
}

function parseTrustFlag(value: string): TrustFlagName | null {
    return TRUST_FLAGS.includes(value as TrustFlagName) ? (value as TrustFlagName) : null;
}

function parseRole(value: string): RoleName | null {
    const normalized = value.trim().toLowerCase();
    return ROLES.includes(normalized as RoleName) ? (normalized as RoleName) : null;
}

export function parseMembersCommandRequest(text: string, replyTargetId?: string | null): MembersCommandRequest {
    const body = text.replace(/^\/members(?:@\w+)?/i, '').trim();
    if (!body) {
        return replyTargetId ? { action: 'show', selector: replyTargetId } : { action: 'list' };
    }

    const parts = body.split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase();

    if (action === 'show') {
        const selector = parts.slice(1).join(' ').trim() || replyTargetId || '';
        return selector ? { action: 'show', selector } : usage();
    }

    if (action === 'role') {
        if (replyTargetId && parts.length === 2) {
            const role = parseRole(parts[1]);
            return role ? { action: 'role', selector: replyTargetId, role } : usage();
        }

        if (parts.length >= 3) {
            const role = parseRole(parts[parts.length - 1]);
            if (!role) return usage();
            return {
                action: 'role',
                selector: parts.slice(1, -1).join(' ').trim(),
                role,
            };
        }

        return usage();
    }

    if (action === 'rep') {
        if (replyTargetId && parts.length === 2) {
            const reputationDelta = Number(parts[1]);
            return Number.isFinite(reputationDelta)
                ? { action: 'rep', selector: replyTargetId, reputation_delta: reputationDelta }
                : usage();
        }

        if (parts.length >= 3) {
            const reputationDelta = Number(parts[parts.length - 1]);
            return Number.isFinite(reputationDelta)
                ? {
                      action: 'rep',
                      selector: parts.slice(1, -1).join(' ').trim(),
                      reputation_delta: reputationDelta,
                  }
                : usage();
        }

        return usage();
    }

    if (action === 'trust') {
        if (replyTargetId && parts.length === 3) {
            const enabled = parseToggle(parts[2]);
            const flag = parseTrustFlag(parts[1]);
            if (enabled === null || !flag) return usage();
            return {
                action: 'trust',
                selector: replyTargetId,
                flag,
                enabled,
            };
        }

        if (parts.length >= 4) {
            const enabled = parseToggle(parts[parts.length - 1]);
            const flag = parseTrustFlag(parts[parts.length - 2]);
            if (enabled === null || !flag) return usage();
            return {
                action: 'trust',
                selector: parts.slice(1, -2).join(' ').trim(),
                flag,
                enabled,
            };
        }

        return usage();
    }

    return usage();
}
