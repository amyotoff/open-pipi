import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { renderJournalRange } from '../core/timeline';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { getMembership } from '../db';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireSpace(
    context?: ExecutionContext
): { ok: true; spaceId: string; userId: string } | { ok: false; message: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_ERROR] Chat context missing.' };
    }
    const userId = context?.userId;
    if (!userId) {
        return { ok: false, message: '[TOOL_ERROR] User context missing.' };
    }
    const membership = getMembership(spaceId, userId);
    if (!membership) {
        return { ok: false, message: '[TOOL_ERROR] You do not have access to this space.' };
    }
    return { ok: true, spaceId, userId };
}

const skill: SkillManifest = {
    name: 'journal',
    description: 'View the compressed system timeline and derived daily journal for the current space',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'owner',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'journal_view',
            description: 'Show the current space timeline for today, yesterday, or the last 7 days.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    range: {
                        type: Type.STRING,
                        enum: ['today', 'yesterday', 'week'],
                        description: 'Which journal range to show.',
                    },
                },
                required: ['range'],
            },
        },
    ],
    handlers: {
        async journal_view(args: { range: 'today' | 'yesterday' | 'week' }, context?: ExecutionContext) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            return renderJournalRange(access.spaceId, args.range || 'today');
        },
    },
};

export default skill;
