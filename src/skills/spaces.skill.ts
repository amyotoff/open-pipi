import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    getSpace,
    getSpaceParticipants,
    listGroundingOverrides,
    listMemorySprints,
    memberHasTrustFlag,
    updateSpaceAssistantPack,
    updateSpacePolicy,
} from '../db';
import { getAssistantPack, getAssistantPackIds } from '../core/assistant-pack';
import { getGroundingPack } from '../core/grounding-loader';
import { resolveAllowedCapabilities, resolveSpacePolicy } from '../core/policy';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { validateWorkspaceRootPath } from '../core/workspace-path';
import { normalizeAuditMode } from '../core/tool-execution';
import { appendTimelineEvent } from '../core/timeline';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requirePolicyAuthority(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] Space management requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Space management requires an active chat context.' };
    }
    if (!memberHasTrustFlag(spaceId, context.userId, 'can_change_policies')) {
        return { ok: false, message: '[TOOL_RESULT] You do not have permission to change this space configuration.' };
    }

    return { ok: true, spaceId };
}

const skill: SkillManifest = {
    name: 'spaces',
    description:
        'Inspect and configure the current space: assistant pack, policies, and participant authority overview',
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
            name: 'space_status',
            description:
                'Show the current space configuration: assistant pack, policies, and participant authority summary.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'space_list_packs',
            description: 'List available assistant packs that can be attached to this space.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'space_list_sprints',
            description: 'Show recent memory sprint history for the current space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    limit: { type: Type.INTEGER, description: 'Maximum number of sprints to show, default 6.' },
                },
            },
        },
        {
            name: 'space_set_pack',
            description:
                'Switch the current space to a different assistant pack such as jeeves, tutor, office, or reporter.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    pack_id: { type: Type.STRING, description: 'Assistant pack ID.' },
                },
                required: ['pack_id'],
            },
        },
        {
            name: 'space_set_policy',
            description: 'Update the current space policy flags for browser or scheduled tasks.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    browser: { type: Type.BOOLEAN, description: 'Allow browsing and research tools.' },
                    tasks: { type: Type.BOOLEAN, description: 'Allow scheduled assistant tasks in this space.' },
                    memory_sprint_days: {
                        type: Type.INTEGER,
                        description: 'Optional number of days to keep the current memory sprint hot in context.',
                    },
                    sandbox_enabled: { type: Type.BOOLEAN, description: 'Allow sandbox-only tools in this space.' },
                    audit_trail: {
                        type: Type.STRING,
                        enum: ['off', 'errors', 'all'],
                        description: 'Default audit trail mode for tool execution in this space.',
                    },
                },
            },
        },
        {
            name: 'space_set_workspace',
            description:
                'Attach or clear an optional workspace path for this space. Use an absolute path, or "off" to clear it.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    workspace_path: {
                        type: Type.STRING,
                        description: 'Absolute workspace path, or "off" to clear it.',
                    },
                },
                required: ['workspace_path'],
            },
        },
    ],
    handlers: {
        async space_status(_: Record<string, never>, context?: ExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!spaceId) {
                return '[TOOL_RESULT] Space status requires an active chat context.';
            }

            const space = getSpace(spaceId);
            if (!space) {
                return '[TOOL_RESULT] This space is not initialized yet.';
            }

            const pack = getAssistantPack(space.assistant_pack_id);
            const grounding = getGroundingPack(space.grounding_pack_id);
            const policy = resolveSpacePolicy(spaceId);
            const allowedCapabilities = resolveAllowedCapabilities(policy);
            const participants = getSpaceParticipants(spaceId);
            const activeOverrides = listGroundingOverrides(spaceId).length;

            const participantLines =
                participants.length > 0
                    ? participants
                          .map((participant) => {
                              const flags = Object.entries(participant.trust_flags)
                                  .filter(([, enabled]) => enabled)
                                  .map(([name]) => name.replace(/^can_/, ''))
                                  .join(', ');
                              return `- ${participant.nickname || participant.display_name || participant.username || participant.person_id || participant.tg_id}: ${participant.membership_role}, authority ${participant.effective_authority}${flags ? `, trust ${flags}` : ''}`;
                          })
                          .join('\n')
                    : '- no participants recorded yet';

            return `[TOOL_RESULT] Space ${spaceId}
Pack: ${pack.id}
Persona: ${pack.persona_id}
Grounding: ${grounding.id} (${grounding.title})
Grounding overrides: ${activeOverrides}
Policies:
- browser: ${policy.browser}
- tasks: ${policy.tasks}
- memory_sprint_days: ${policy.memory_sprint_days}
- sandbox_enabled: ${policy.sandbox_enabled}
- audit_trail: ${policy.audit_trail}
- allowed_capabilities: ${allowedCapabilities.join(', ')}
- workspace_path: ${policy.workspace_path || 'none'}
Participants:
${participantLines}`;
        },

        async space_list_packs(_: Record<string, never>) {
            const lines = getAssistantPackIds().map((id) => {
                const pack = getAssistantPack(id);
                return `- ${pack.id}: persona ${pack.persona_id}; capabilities ${pack.enabled_capabilities.join(', ')}`;
            });
            return `[TOOL_RESULT] Available assistant packs:\n${lines.join('\n')}`;
        },

        async space_list_sprints(args: { limit?: number }, context?: ExecutionContext) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const sprints = listMemorySprints(access.spaceId, Math.min(Math.max(args.limit || 6, 1), 12));
            if (sprints.length === 0) {
                return `[TOOL_RESULT] No memory sprints were recorded for ${access.spaceId} yet.`;
            }

            return `[TOOL_RESULT] Memory sprint history for ${access.spaceId}:\n${sprints
                .map((sprint) => {
                    const summary = sprint.summary
                        ? sprint.summary.replace(/\s+/g, ' ').trim().substring(0, 140)
                        : 'no summary yet';
                    return `- ${sprint.opened_at.substring(0, 10)} -> ${sprint.closes_at.substring(0, 10)}; ${sprint.status}; ${sprint.cadence_days} days; ${summary}`;
                })
                .join('\n')}`;
        },

        async space_set_pack(args: { pack_id: string }, context?: ExecutionContext) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const packId = args.pack_id.trim();
            if (!getAssistantPackIds().includes(packId)) {
                return `[TOOL_RESULT] Unknown assistant pack "${packId}". Use space_list_packs first.`;
            }

            const previousPackId = getSpace(access.spaceId)?.assistant_pack_id || 'jeeves';
            updateSpaceAssistantPack(access.spaceId, packId);
            const { ensureDefaultAssistantTasksForSpace, registerScheduledTasks } = await import('../core/tasks');
            ensureDefaultAssistantTasksForSpace(access.spaceId);
            registerScheduledTasks();
            const pack = getAssistantPack(packId);
            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'space.pack_changed',
                refType: 'space',
                refId: access.spaceId,
                summary: `Switched pack from "${previousPackId}" to "${pack.id}".`,
                details: { from: previousPackId, to: pack.id },
            });
            return `[TOOL_RESULT] Space ${access.spaceId} now uses pack "${pack.id}" with persona "${pack.persona_id}". Default scheduled tasks were reseeded for this space.`;
        },

        async space_set_policy(
            args: {
                browser?: boolean;
                tasks?: boolean;
                memory_sprint_days?: number;
                sandbox_enabled?: boolean;
                audit_trail?: string;
            },
            context?: ExecutionContext
        ) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const previous = resolveSpacePolicy(access.spaceId);
            const patch = Object.fromEntries(
                Object.entries(args).filter(
                    ([, value]) =>
                        typeof value === 'boolean' ||
                        (typeof value === 'number' && Number.isFinite(value)) ||
                        typeof value === 'string'
                )
            );

            if (Object.keys(patch).length === 0) {
                return '[TOOL_RESULT] No policy changes were provided.';
            }

            if (typeof patch.memory_sprint_days === 'number') {
                const days = Math.round(patch.memory_sprint_days);
                if (days < 1 || days > 365) {
                    return '[TOOL_RESULT] memory_sprint_days must be between 1 and 365.';
                }
                patch.memory_sprint_days = days;
            }

            if (typeof patch.audit_trail === 'string') {
                patch.audit_trail = normalizeAuditMode(patch.audit_trail);
            }

            updateSpacePolicy(access.spaceId, patch);
            const resolved = resolveSpacePolicy(access.spaceId);
            const allowedCapabilities = resolveAllowedCapabilities(resolved);
            const changes = Object.keys(patch).map((key) => {
                const previousValue = (previous as any)[key];
                const nextValue = (resolved as any)[key];
                return `${key}: ${String(previousValue)} -> ${String(nextValue)}`;
            });
            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'space.policy_changed',
                refType: 'space',
                refId: access.spaceId,
                summary: `Updated space policy: ${changes.join('; ')}.`,
                details: { patch },
            });
            return `[TOOL_RESULT] Updated policy for ${access.spaceId}.
- browser: ${resolved.browser}
- tasks: ${resolved.tasks}
- memory_sprint_days: ${resolved.memory_sprint_days}
- sandbox_enabled: ${resolved.sandbox_enabled}
- audit_trail: ${resolved.audit_trail}
- allowed_capabilities: ${allowedCapabilities.join(', ')}
- workspace_path: ${resolved.workspace_path || 'none'}`;
        },

        async space_set_workspace(args: { workspace_path: string }, context?: ExecutionContext) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const rawPath = args.workspace_path.trim();
            if (!rawPath) {
                return '[TOOL_RESULT] Workspace path cannot be empty.';
            }

            if (['off', 'none', 'clear'].includes(rawPath.toLowerCase())) {
                updateSpacePolicy(access.spaceId, { workspace_path: null });
                appendTimelineEvent({
                    spaceId: access.spaceId,
                    type: 'space.workspace_cleared',
                    refType: 'space',
                    refId: access.spaceId,
                    summary: 'Cleared the attached workspace path.',
                });
                return `[TOOL_RESULT] Cleared workspace path for ${access.spaceId}.`;
            }

            if (!rawPath.startsWith('/')) {
                return '[TOOL_RESULT] Workspace path must be absolute.';
            }

            const validated = validateWorkspaceRootPath(rawPath);
            if (!validated.ok) {
                return `[TOOL_RESULT] ${validated.message}`;
            }

            updateSpacePolicy(access.spaceId, { workspace_path: validated.resolvedPath });
            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'space.workspace_set',
                refType: 'space',
                refId: access.spaceId,
                summary: `Attached workspace path ${validated.resolvedPath}.`,
                details: { workspace_path: validated.resolvedPath },
            });
            return `[TOOL_RESULT] Workspace path for ${access.spaceId} is now ${validated.resolvedPath}.`;
        },
    },
};

export default skill;
