import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    getSpaceParticipants,
    SpaceParticipant,
    memberHasTrustFlag,
    updateMembershipReputation,
    updateMembershipRole,
    updateMembershipTrustFlag,
} from '../db';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;
const ALLOWED_MEMBER_ROLES = new Set(['owner', 'admin', 'manager', 'member', 'guest', 'service_bot']);

function requireMembershipAdmin(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] Membership management requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Membership management requires an active chat context.' };
    }
    if (!memberHasTrustFlag(spaceId, context.userId, 'can_change_policies')) {
        return { ok: false, message: '[TOOL_RESULT] You do not have permission to manage members in this space.' };
    }

    return { ok: true, spaceId };
}

function formatParticipantName(participant: SpaceParticipant): string {
    const primary =
        participant.nickname ||
        participant.display_name ||
        participant.username ||
        participant.person_id ||
        participant.tg_id;
    const username = participant.username ? ` @${participant.username.replace(/^@/, '')}` : '';
    return `${primary}${username}`.trim();
}

function resolveParticipant(
    spaceId: string,
    selector: string
): { participant: SpaceParticipant } | { message: string } {
    const normalized = selector.trim().replace(/^@/, '').toLowerCase();
    const matches = getSpaceParticipants(spaceId).filter((participant) => {
        const candidates = [
            participant.person_id,
            participant.tg_id,
            participant.username,
            participant.nickname,
            participant.display_name,
        ]
            .filter(Boolean)
            .map((value) => String(value).replace(/^@/, '').toLowerCase());

        return candidates.includes(normalized);
    });

    if (matches.length === 0) {
        return { message: `[TOOL_RESULT] Member "${selector}" was not found in this space.` };
    }

    if (matches.length > 1) {
        return {
            message: `[TOOL_RESULT] Member "${selector}" is ambiguous. Try one of: ${matches
                .slice(0, 5)
                .map(
                    (participant) =>
                        `${formatParticipantName(participant)} (${participant.person_id || participant.tg_id})`
                )
                .join(', ')}.`,
        };
    }

    return { participant: matches[0] };
}

function formatParticipantLine(participant: ReturnType<typeof getSpaceParticipants>[number]): string {
    const flags = Object.entries(participant.trust_flags)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name.replace(/^can_/, ''))
        .join(', ');

    return `- ${formatParticipantName(participant)} (${participant.person_id || participant.tg_id})
  role: ${participant.membership_role}; authority: ${participant.effective_authority}; reputation_delta: ${participant.reputation_delta}${flags ? `; trust: ${flags}` : ''}`;
}

const skill: SkillManifest = {
    name: 'members',
    description: 'Inspect and manage space members, roles, reputation, and trust flags',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        required_trust_flag: 'can_change_policies',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'member_list',
            description: 'List members of the current space with role, authority, reputation, and trust flags.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'member_show',
            description:
                'Show a single member in the current space by person_id, @username, nickname, or display name.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: {
                        type: Type.STRING,
                        description: 'Member selector: person_id, @username, nickname, or display name.',
                    },
                },
                required: ['person_id'],
            },
        },
        {
            name: 'member_set_role',
            description:
                'Change a member role in the current space. Roles reset the member base authority and default trust flags.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: {
                        type: Type.STRING,
                        description: 'Member selector: person_id, @username, nickname, or display name.',
                    },
                    role: {
                        type: Type.STRING,
                        description: 'New role: owner, admin, manager, member, guest, service_bot.',
                    },
                },
                required: ['person_id', 'role'],
            },
        },
        {
            name: 'member_set_reputation',
            description: 'Set the absolute reputation_delta for a member in the current space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: {
                        type: Type.STRING,
                        description: 'Member selector: person_id, @username, nickname, or display name.',
                    },
                    reputation_delta: {
                        type: Type.INTEGER,
                        description: 'Absolute reputation delta, e.g. -50, 0, 120.',
                    },
                },
                required: ['person_id', 'reputation_delta'],
            },
        },
        {
            name: 'member_set_trust_flag',
            description: 'Enable or disable a trust flag for a member in the current space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: {
                        type: Type.STRING,
                        description: 'Member selector: person_id, @username, nickname, or display name.',
                    },
                    flag: {
                        type: Type.STRING,
                        description: 'Trust flag name.',
                        enum: [
                            'can_assign_tasks',
                            'can_change_policies',
                            'can_override_instructions',
                            'can_issue_high_impact_commands',
                        ],
                    },
                    enabled: { type: Type.BOOLEAN, description: 'Whether the flag should be enabled.' },
                },
                required: ['person_id', 'flag', 'enabled'],
            },
        },
    ],
    handlers: {
        async member_list(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireMembershipAdmin(context);
            if (!access.ok) return access.message;

            const participants = getSpaceParticipants(access.spaceId);
            if (participants.length === 0) {
                return '[TOOL_RESULT] No participants are registered in this space yet.';
            }

            return `[TOOL_RESULT] Members in ${access.spaceId}:\n${participants.map(formatParticipantLine).join('\n')}`;
        },

        async member_show(args: { person_id: string }, context?: ExecutionContext) {
            const access = requireMembershipAdmin(context);
            if (!access.ok) return access.message;

            const resolved = resolveParticipant(access.spaceId, args.person_id);
            if ('message' in resolved) return resolved.message;

            return `[TOOL_RESULT] ${formatParticipantLine(resolved.participant)}`;
        },

        async member_set_role(args: { person_id: string; role: string }, context?: ExecutionContext) {
            const access = requireMembershipAdmin(context);
            if (!access.ok) return access.message;

            const normalizedRole = args.role.trim().toLowerCase();
            if (!ALLOWED_MEMBER_ROLES.has(normalizedRole)) {
                return '[TOOL_RESULT] Invalid role. Allowed roles: owner, admin, manager, member, guest, service_bot.';
            }

            const resolved = resolveParticipant(access.spaceId, args.person_id);
            if ('message' in resolved) return resolved.message;

            const updated = updateMembershipRole(
                access.spaceId,
                resolved.participant.person_id || resolved.participant.tg_id,
                normalizedRole
            );
            if (!updated) {
                return `[TOOL_RESULT] Member "${args.person_id}" was not found in this space.`;
            }

            return `[TOOL_RESULT] Member ${resolved.participant.person_id || resolved.participant.tg_id} now has role "${updated.role}" with base authority ${updated.base_authority}.`;
        },

        async member_set_reputation(args: { person_id: string; reputation_delta: number }, context?: ExecutionContext) {
            const access = requireMembershipAdmin(context);
            if (!access.ok) return access.message;

            const resolved = resolveParticipant(access.spaceId, args.person_id);
            if ('message' in resolved) return resolved.message;

            const updated = updateMembershipReputation(
                access.spaceId,
                resolved.participant.person_id || resolved.participant.tg_id,
                args.reputation_delta
            );
            if (!updated) {
                return `[TOOL_RESULT] Member "${args.person_id}" was not found in this space.`;
            }

            return `[TOOL_RESULT] Member ${resolved.participant.person_id || resolved.participant.tg_id} now has reputation_delta ${updated.reputation_delta}.`;
        },

        async member_set_trust_flag(
            args: {
                person_id: string;
                flag:
                    | 'can_assign_tasks'
                    | 'can_change_policies'
                    | 'can_override_instructions'
                    | 'can_issue_high_impact_commands';
                enabled: boolean;
            },
            context?: ExecutionContext
        ) {
            const access = requireMembershipAdmin(context);
            if (!access.ok) return access.message;

            const resolved = resolveParticipant(access.spaceId, args.person_id);
            if ('message' in resolved) return resolved.message;

            const updated = updateMembershipTrustFlag(
                access.spaceId,
                resolved.participant.person_id || resolved.participant.tg_id,
                args.flag,
                args.enabled
            );
            if (!updated) {
                return `[TOOL_RESULT] Member "${args.person_id}" was not found in this space.`;
            }

            return `[TOOL_RESULT] Member ${resolved.participant.person_id || resolved.participant.tg_id}: ${args.flag} is now ${args.enabled ? 'enabled' : 'disabled'}.`;
        },
    },
};

export default skill;
