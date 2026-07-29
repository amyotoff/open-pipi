import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    clearSkillRequests,
    createCapabilityGapRequest,
    getSkillRequest,
    getSpace,
    listSkillRequests,
    memberHasTrustFlag,
    saveImplementationTicket,
} from '../db';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

const SELF_REVIEW_TASK_PREFIX = 'system:atelier-self-review:';
const selfReviewRequestTasks = new Set<string>();

function hasSelfReviewRequestBudget(context?: ExecutionContext): boolean {
    const taskId = context?.taskId;
    return !taskId?.startsWith(SELF_REVIEW_TASK_PREFIX) || !selfReviewRequestTasks.has(taskId);
}

function consumeSelfReviewRequestBudget(context?: ExecutionContext): void {
    const taskId = context?.taskId;
    if (!taskId?.startsWith(SELF_REVIEW_TASK_PREFIX)) return;

    selfReviewRequestTasks.add(taskId);
    if (selfReviewRequestTasks.size > 200) {
        selfReviewRequestTasks.delete(selfReviewRequestTasks.values().next().value!);
    }
}

function requireAtelierContext(
    context?: ExecutionContext
): { ok: true; spaceId: string; packId: string; userId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] Atelier requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Atelier requires an active chat context.' };
    }
    const space = getSpace(spaceId);
    return {
        ok: true,
        spaceId,
        packId: space?.assistant_pack_id || 'jeeves',
        userId: context.userId,
    };
}

function formatAtelierLine(
    request: {
        id?: number;
        skill_name: string;
        capability_gap?: string | null;
        assistant_pack_id?: string | null;
        space_id?: string | null;
        status: string;
        votes?: number;
        user_request: string;
        implementation_ticket_status?: string;
    },
    scope: 'space' | 'pack'
): string {
    const votes = request.votes && request.votes > 1 ? `; votes ${request.votes}` : '';
    const pack = request.assistant_pack_id ? `; pack ${request.assistant_pack_id}` : '';
    const space = scope === 'pack' && request.space_id ? `; space ${request.space_id}` : '';
    const gap = request.capability_gap ? `; gap ${request.capability_gap}` : '';
    const ticket = request.implementation_ticket_status ? `; ticket ${request.implementation_ticket_status}` : '';
    return `- #${request.id} ${request.skill_name}${gap}${pack}${space}; status ${request.status}${votes}${ticket}
  "${request.user_request}"`;
}

function requireTicketAuthority(
    context?: ExecutionContext
): { ok: true; spaceId: string; packId: string; userId: string } | { ok: false; message: string } {
    const access = requireAtelierContext(context);
    if (!access.ok) return access;

    if (!memberHasTrustFlag(access.spaceId, access.userId, 'can_change_policies')) {
        return {
            ok: false,
            message: '[TOOL_RESULT] You do not have permission to create implementation tickets in this space.',
        };
    }

    return access;
}

function stripUserTitlePrefix(text: string): string {
    return text.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function deriveTicketTitle(request: {
    assistant_pack_id?: string | null;
    capability_gap?: string | null;
    skill_name: string;
    description: string;
}): string {
    const titled = request.description.match(/^\[([^\]]+)\]/)?.[1]?.trim();
    if (titled) return titled;

    const gap = request.capability_gap || request.skill_name;
    return `${request.assistant_pack_id || 'jeeves'} / ${gap}`;
}

function buildImplementationTicket(
    request: {
        id?: number;
        space_id?: string | null;
        assistant_pack_id?: string | null;
        capability_gap?: string | null;
        skill_name: string;
        description: string;
        user_request: string;
        hardware_needed?: string;
    },
    overrides?: {
        summary?: string;
        acceptance_criteria?: string;
        implementation_notes?: string;
    }
): string {
    const title = deriveTicketTitle(request);
    const summary = overrides?.summary?.trim() || stripUserTitlePrefix(request.description);
    const acceptance =
        overrides?.acceptance_criteria?.trim() ||
        [
            '- the assistant has a concrete supported path for this gap',
            '- the relevant pack exposes the capability in a minimal usable form',
            '- at least one happy-path test covers the new behavior',
        ].join('\n');
    const notes = [
        request.hardware_needed?.trim() ? `- hardware/integration: ${request.hardware_needed.trim()}` : '',
        overrides?.implementation_notes?.trim()
            ? `- implementation notes: ${overrides.implementation_notes.trim()}`
            : '',
    ]
        .filter(Boolean)
        .join('\n');

    return [
        `[IMPLEMENTATION_TICKET ATL-${request.id}]`,
        `Title: ${title}`,
        `Pack: ${request.assistant_pack_id || 'jeeves'}`,
        `Space: ${request.space_id || 'n/a'}`,
        `Gap: ${request.capability_gap || request.skill_name}`,
        `Request: #${request.id}`,
        'Ticket status: draft',
        '',
        'Summary:',
        summary,
        '',
        'Triggering user request:',
        request.user_request.trim(),
        '',
        'Deliver the smallest working change:',
        '- solve this gap with the minimum viable capability or tool path',
        '- prefer extending existing primitives or skills over adding a large new subsystem',
        '- avoid unrelated refactors',
        '',
        'Acceptance criteria:',
        acceptance,
        ...(notes ? ['', 'Notes:', notes] : []),
    ].join('\n');
}

function formatTicketSummaryLine(
    request: {
        id?: number;
        skill_name: string;
        capability_gap?: string | null;
        assistant_pack_id?: string | null;
        space_id?: string | null;
        implementation_ticket_status?: string;
        implementation_ticket_updated_at?: string | null;
    },
    scope: 'space' | 'pack'
): string {
    const pack = request.assistant_pack_id ? `; pack ${request.assistant_pack_id}` : '';
    const space = scope === 'pack' && request.space_id ? `; space ${request.space_id}` : '';
    const gap = request.capability_gap ? `; gap ${request.capability_gap}` : '';
    const updated = request.implementation_ticket_updated_at
        ? `; updated ${request.implementation_ticket_updated_at.substring(0, 10)}`
        : '';
    return `- ATL-${request.id} ${request.skill_name}${gap}${pack}${space}; ticket ${request.implementation_ticket_status || 'draft'}${updated}`;
}

const skill: SkillManifest = {
    name: 'atelier',
    description: 'Log and inspect capability gaps for the current space and assistant pack',
    version: '1.1.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'atelier_request_capability',
            description:
                'Log a missing capability in the Atelier for the current space and current assistant pack. Use this when the assistant cannot fulfill the request with current tools.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    capability_gap: {
                        type: Type.STRING,
                        description:
                            'Short stable label for the missing capability, e.g. "slack_channel_sync" or "workspace_file_editing".',
                    },
                    skill_name: {
                        type: Type.STRING,
                        description:
                            'Optional short snake_case skill or feature ID. Defaults to capability_gap if omitted.',
                    },
                    user_title: {
                        type: Type.STRING,
                        description: 'Optional human-readable title close to the user wording.',
                    },
                    description: {
                        type: Type.STRING,
                        description: 'What is missing and why it matters in this space.',
                    },
                    user_request: { type: Type.STRING, description: 'The triggering user request or paraphrase.' },
                    hardware_needed: {
                        type: Type.STRING,
                        description: 'Optional hardware, integration, or service dependency.',
                    },
                },
                required: ['capability_gap', 'description', 'user_request'],
            },
        },
        {
            name: 'atelier_list_requests',
            description:
                'List Atelier capability-gap requests for the current space, or across the current assistant pack.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    scope: {
                        type: Type.STRING,
                        description: 'Listing scope.',
                        enum: ['space', 'pack'],
                    },
                    include_resolved: {
                        type: Type.BOOLEAN,
                        description: 'Whether to include done, rejected, or cleared requests.',
                    },
                },
            },
        },
        {
            name: 'atelier_clear_requests',
            description:
                'Clear open Atelier requests for the current space. Only members with can_change_policies can do this.',
            parameters: {
                type: Type.OBJECT,
                properties: {},
            },
        },
        {
            name: 'atelier_create_ticket',
            description:
                'Create a minimal implementation ticket for an Atelier request. Use this when a logged gap should become a concrete coding task.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    request_id: {
                        type: Type.INTEGER,
                        description: 'Atelier request ID to turn into an implementation ticket.',
                    },
                    summary: { type: Type.STRING, description: 'Optional replacement summary for the ticket.' },
                    acceptance_criteria: {
                        type: Type.STRING,
                        description: 'Optional acceptance criteria, preferably one bullet per line.',
                    },
                    implementation_notes: {
                        type: Type.STRING,
                        description: 'Optional implementation notes, constraints, or hints.',
                    },
                    force_regenerate: {
                        type: Type.BOOLEAN,
                        description: 'Whether to overwrite an existing implementation ticket.',
                    },
                },
                required: ['request_id'],
            },
        },
        {
            name: 'atelier_list_tickets',
            description:
                'List implementation tickets created from Atelier requests for the current space or current pack.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    scope: {
                        type: Type.STRING,
                        description: 'Listing scope.',
                        enum: ['space', 'pack'],
                    },
                    include_resolved: {
                        type: Type.BOOLEAN,
                        description: 'Whether to include tickets whose source requests are already resolved.',
                    },
                    include_body: {
                        type: Type.BOOLEAN,
                        description: 'Whether to include full ticket bodies instead of only summary lines.',
                    },
                },
            },
        },
    ],
    handlers: {
        async atelier_request_capability(
            args: {
                capability_gap: string;
                skill_name?: string;
                user_title?: string;
                description: string;
                user_request: string;
                hardware_needed?: string;
            },
            context?: ExecutionContext
        ) {
            const access = requireAtelierContext(context);
            if (!access.ok) return access.message;
            if (!hasSelfReviewRequestBudget(context)) {
                return '[TOOL_RESULT] This private self-review already used its one Atelier request. Do not request another capability in this cycle.';
            }

            const result = createCapabilityGapRequest({
                space_id: access.spaceId,
                assistant_pack_id: access.packId,
                capability_gap: args.capability_gap,
                skill_name: args.skill_name,
                user_title: args.user_title,
                description: args.description,
                requested_by: access.userId,
                user_request: args.user_request,
                hardware_needed: args.hardware_needed,
            });
            consumeSelfReviewRequestBudget(context);

            if (result.deduped) {
                return `[TOOL_RESULT] Atelier request updated for gap "${result.request.capability_gap}" in pack "${access.packId}" and space "${access.spaceId}". Votes: ${result.votes}.`;
            }

            const hardwareNote = args.hardware_needed?.trim()
                ? ` Hardware/integration noted: ${args.hardware_needed.trim()}.`
                : '';
            return `[TOOL_RESULT] Atelier request logged for gap "${result.request.capability_gap}" in pack "${access.packId}" and space "${access.spaceId}".${hardwareNote}`;
        },

        async atelier_list_requests(
            args: { scope?: 'space' | 'pack'; include_resolved?: boolean },
            context?: ExecutionContext
        ) {
            const access = requireAtelierContext(context);
            if (!access.ok) return access.message;

            const scope = args.scope === 'pack' ? 'pack' : 'space';
            const requests = listSkillRequests({
                spaceId: scope === 'space' ? access.spaceId : undefined,
                assistantPackId: access.packId,
                includeResolved: args.include_resolved,
            });

            if (requests.length === 0) {
                return scope === 'pack'
                    ? `[TOOL_RESULT] No Atelier requests found for pack "${access.packId}".`
                    : `[TOOL_RESULT] No Atelier requests found for space "${access.spaceId}".`;
            }

            const label =
                scope === 'pack'
                    ? `Atelier requests for pack "${access.packId}"`
                    : `Atelier requests for space "${access.spaceId}"`;

            return `[TOOL_RESULT] ${label}:\n${requests.map((request) => formatAtelierLine(request, scope)).join('\n')}`;
        },

        async atelier_clear_requests(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireAtelierContext(context);
            if (!access.ok) return access.message;

            if (!memberHasTrustFlag(access.spaceId, access.userId, 'can_change_policies')) {
                return '[TOOL_RESULT] You do not have permission to clear Atelier requests in this space.';
            }

            const changes = clearSkillRequests({ spaceId: access.spaceId });
            return `[TOOL_RESULT] Cleared ${changes} open Atelier request(s) in ${access.spaceId}.`;
        },

        async atelier_create_ticket(
            args: {
                request_id: number;
                summary?: string;
                acceptance_criteria?: string;
                implementation_notes?: string;
                force_regenerate?: boolean;
            },
            context?: ExecutionContext
        ) {
            const access = requireTicketAuthority(context);
            if (!access.ok) return access.message;

            const request = getSkillRequest(args.request_id);
            if (!request) {
                return `[TOOL_RESULT] Atelier request #${args.request_id} was not found.`;
            }

            if ((request.assistant_pack_id || 'jeeves') !== access.packId) {
                return `[TOOL_RESULT] Atelier request #${args.request_id} belongs to pack "${request.assistant_pack_id || 'jeeves'}", not "${access.packId}".`;
            }

            if (request.implementation_ticket?.trim() && !args.force_regenerate) {
                return `[TOOL_RESULT] Implementation ticket already exists for Atelier request #${request.id}.\n\n${request.implementation_ticket.trim()}`;
            }

            const ticket = buildImplementationTicket(request, {
                summary: args.summary,
                acceptance_criteria: args.acceptance_criteria,
                implementation_notes: args.implementation_notes,
            });
            const updated = saveImplementationTicket({
                request_id: args.request_id,
                ticket,
                created_by: access.userId,
                status: 'draft',
            });

            if (!updated) {
                return `[TOOL_RESULT] Failed to save implementation ticket for Atelier request #${args.request_id}.`;
            }

            const action = request.implementation_ticket?.trim() && args.force_regenerate ? 'Regenerated' : 'Created';
            return `[TOOL_RESULT] ${action} implementation ticket for Atelier request #${updated.id}.\n\n${updated.implementation_ticket?.trim()}`;
        },

        async atelier_list_tickets(
            args: { scope?: 'space' | 'pack'; include_resolved?: boolean; include_body?: boolean },
            context?: ExecutionContext
        ) {
            const access = requireAtelierContext(context);
            if (!access.ok) return access.message;

            const scope = args.scope === 'pack' ? 'pack' : 'space';
            const requests = listSkillRequests({
                spaceId: scope === 'space' ? access.spaceId : undefined,
                assistantPackId: access.packId,
                includeResolved: args.include_resolved,
            }).filter((request) => !!request.implementation_ticket?.trim());

            if (requests.length === 0) {
                return scope === 'pack'
                    ? `[TOOL_RESULT] No implementation tickets found for pack "${access.packId}".`
                    : `[TOOL_RESULT] No implementation tickets found for space "${access.spaceId}".`;
            }

            const label =
                scope === 'pack'
                    ? `Implementation tickets for pack "${access.packId}"`
                    : `Implementation tickets for space "${access.spaceId}"`;

            if (args.include_body) {
                return `[TOOL_RESULT] ${label}:\n${requests
                    .map((request) => `---\n${request.implementation_ticket?.trim()}`)
                    .join('\n')}`;
            }

            return `[TOOL_RESULT] ${label}:\n${requests
                .map((request) => formatTicketSummaryLine(request, scope))
                .join('\n')}`;
        },
    },
    crons: [
        {
            expression: '17 * * * *',
            description: '48-hour private self-improvement Atelier review',
            handler: async () => {
                const { runAtelierSelfReviewIfDue } = await import('../core/atelier-self-review');
                await runAtelierSelfReviewIfDue();
            },
        },
    ],
};

export default skill;
