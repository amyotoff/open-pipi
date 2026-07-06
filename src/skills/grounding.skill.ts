import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    disableGroundingOverride,
    getGroundingOverride,
    getSpace,
    listGroundingOverrides,
    memberHasTrustFlag,
    updateSpaceGroundingPack,
    upsertGroundingOverride,
} from '../db';
import { getGroundingPack, getGroundingPackIds } from '../core/grounding-loader';
import { getGroundingSnapshot } from '../core/grounding-context';
import type { GroundingOverrideKind } from '../core/grounding-types';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

const ALLOWED_OVERRIDE_KINDS: GroundingOverrideKind[] = ['person', 'place', 'rule', 'org', 'glossary'];

function requirePolicyAuthority(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] Grounding management requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Grounding management requires an active chat context.' };
    }
    if (!memberHasTrustFlag(spaceId, context.userId, 'can_change_policies')) {
        return { ok: false, message: '[TOOL_RESULT] You do not have permission to change grounding in this space.' };
    }

    return { ok: true, spaceId };
}

const skill: SkillManifest = {
    name: 'grounding',
    description:
        'Inspect and adjust the world-model for the current space using installable grounding packs and small reality overrides',
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
            name: 'grounding_status',
            description: 'Show the current grounding pack and active overrides for this space.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'grounding_list_packs',
            description: 'List available grounding packs that can describe the world-model of this space.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'grounding_set_pack',
            description: 'Switch the current space to a different grounding pack.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    grounding_pack_id: { type: Type.STRING, description: 'Grounding pack ID.' },
                },
                required: ['grounding_pack_id'],
            },
        },
        {
            name: 'grounding_list_overrides',
            description: 'List active grounding overrides for this space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    include_inactive: { type: Type.BOOLEAN, description: 'Include inactive overrides.' },
                },
            },
        },
        {
            name: 'grounding_add_override',
            description: 'Add or update a small grounding override when reality in this space has changed.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    kind: { type: Type.STRING, description: 'One of: person, place, rule, org, glossary.' },
                    subject: {
                        type: Type.STRING,
                        description: 'Short subject, such as Alice, Family home, or Project Atlas.',
                    },
                    content: { type: Type.STRING, description: 'Current reality to remember.' },
                },
                required: ['kind', 'subject', 'content'],
            },
        },
        {
            name: 'grounding_disable_override',
            description: 'Disable an active grounding override by its numeric ID.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    override_id: { type: Type.INTEGER, description: 'Numeric grounding override ID.' },
                },
                required: ['override_id'],
            },
        },
    ],
    handlers: {
        async grounding_status(_: Record<string, never>, context?: ExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!spaceId) {
                return '[TOOL_RESULT] Grounding status requires an active chat context.';
            }

            const space = getSpace(spaceId);
            if (!space) {
                return '[TOOL_RESULT] This space is not initialized yet.';
            }

            const snapshot = getGroundingSnapshot(spaceId);
            if (!snapshot) {
                return '[TOOL_RESULT] No grounding snapshot is available for this space yet.';
            }

            const overrideLines =
                snapshot.overrides.length > 0
                    ? snapshot.overrides
                          .map(
                              (override) =>
                                  `- #${override.id} ${override.kind} / ${override.subject}: ${override.content}`
                          )
                          .join('\n')
                    : '- no active overrides';

            return `[TOOL_RESULT] Grounding for ${spaceId}
Pack: ${snapshot.pack.id}
Title: ${snapshot.pack.title}
Memory focus: ${snapshot.pack.memory_focus.join(', ') || 'none'}
Attention bias: ${snapshot.pack.attention_bias.join(', ') || 'none'}
Overrides:
${overrideLines}`;
        },

        async grounding_list_packs(_: Record<string, never>) {
            const lines = getGroundingPackIds().map((id) => {
                const pack = getGroundingPack(id);
                return `- ${pack.id}: ${pack.title}`;
            });
            return `[TOOL_RESULT] Available grounding packs:\n${lines.join('\n')}`;
        },

        async grounding_set_pack(args: { grounding_pack_id: string }, context?: ExecutionContext) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const groundingPackId = args.grounding_pack_id.trim();
            if (!getGroundingPackIds().includes(groundingPackId)) {
                return `[TOOL_RESULT] Unknown grounding pack "${groundingPackId}". Use grounding_list_packs first.`;
            }

            updateSpaceGroundingPack(access.spaceId, groundingPackId);
            const pack = getGroundingPack(groundingPackId);
            return `[TOOL_RESULT] Space ${access.spaceId} now uses grounding pack "${pack.id}" (${pack.title}).`;
        },

        async grounding_list_overrides(args: { include_inactive?: boolean }, context?: ExecutionContext) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const overrides = listGroundingOverrides(access.spaceId, {
                includeInactive: args.include_inactive === true,
            });
            if (overrides.length === 0) {
                return `[TOOL_RESULT] No grounding overrides are recorded for ${access.spaceId}.`;
            }

            return `[TOOL_RESULT] Grounding overrides for ${access.spaceId}:\n${overrides
                .map(
                    (override) =>
                        `- #${override.id} ${override.status} ${override.kind} / ${override.subject}: ${override.content}`
                )
                .join('\n')}`;
        },

        async grounding_add_override(
            args: {
                kind: string;
                subject: string;
                content: string;
            },
            context?: ExecutionContext
        ) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const kind = args.kind.trim().toLowerCase() as GroundingOverrideKind;
            if (!ALLOWED_OVERRIDE_KINDS.includes(kind)) {
                return `[TOOL_RESULT] Unknown grounding override kind "${args.kind}". Allowed: ${ALLOWED_OVERRIDE_KINDS.join(', ')}.`;
            }
            if (!args.subject.trim()) {
                return '[TOOL_RESULT] Grounding override subject cannot be empty.';
            }
            if (!args.content.trim()) {
                return '[TOOL_RESULT] Grounding override content cannot be empty.';
            }

            const override = upsertGroundingOverride({
                space_id: access.spaceId,
                kind,
                subject: args.subject,
                content: args.content,
                created_by: context?.userId || null,
            });

            return `[TOOL_RESULT] Grounding override #${override.id} is active for ${access.spaceId}: ${override.kind} / ${override.subject} -> ${override.content}`;
        },

        async grounding_disable_override(args: { override_id: number }, context?: ExecutionContext) {
            const access = requirePolicyAuthority(context);
            if (!access.ok) return access.message;

            const overrideId = Math.round(Number(args.override_id));
            if (!Number.isFinite(overrideId) || overrideId < 1) {
                return '[TOOL_RESULT] override_id must be a positive integer.';
            }

            const existing = getGroundingOverride(overrideId);
            if (!existing || existing.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Grounding override #${overrideId} was not found in ${access.spaceId}.`;
            }
            const override = disableGroundingOverride(overrideId)!;

            return `[TOOL_RESULT] Disabled grounding override #${override.id} for ${access.spaceId}.`;
        },
    },
};

export default skill;
