import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { searchMessages, searchRecollections } from '../db';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function formatHistoryLine(hit: {
    timestamp: string;
    space_title: string | null;
    channel_ref: string;
    sender_name: string | null;
    content: string;
}): string {
    const when = hit.timestamp.substring(0, 16).replace('T', ' ');
    const where = hit.space_title || hit.channel_ref;
    const who = hit.sender_name || 'unknown';
    const snippet = hit.content.length > 180 ? `${hit.content.substring(0, 180)}...` : hit.content;
    return `- [${when}] ${where} / ${who}: ${snippet}`;
}

function formatRecollectionLine(hit: {
    updated_at: string;
    space_title: string | null;
    space_id: string;
    scope_type: string;
    content: string;
}): string {
    const when = hit.updated_at.substring(0, 10);
    const where = hit.space_title || hit.space_id;
    const lane =
        hit.scope_type === 'work'
            ? 'work recollection'
            : hit.scope_type === 'project'
              ? 'project recollection'
              : 'space recollection';
    const snippet = hit.content.length > 180 ? `${hit.content.substring(0, 180)}...` : hit.content;
    return `- [${when}] ${where} / ${lane}: ${snippet}`;
}

const skill: SkillManifest = {
    name: 'history',
    description: 'Search prior chat history across tracked spaces when memory is incomplete',
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
            name: 'chat_search',
            description:
                'Search prior messages or long recollections when memory is incomplete. Use messages for exact phrasing and recollections for compacted long memory.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'Plain text fragment to search for in prior messages.' },
                    scope: {
                        type: Type.STRING,
                        description: 'Whether to search only the current space or all tracked spaces.',
                        enum: ['current_space', 'all_spaces'],
                    },
                    mode: {
                        type: Type.STRING,
                        description: 'Search exact prior messages or compacted long recollections.',
                        enum: ['messages', 'recollections'],
                    },
                    limit: { type: Type.INTEGER, description: 'Maximum results to return, default 6, max 12.' },
                },
                required: ['query'],
            },
        },
    ],
    handlers: {
        async chat_search(
            args: {
                query: string;
                scope?: 'current_space' | 'all_spaces';
                mode?: 'messages' | 'recollections';
                limit?: number;
            },
            context?: ExecutionContext
        ) {
            if (!context) {
                return '[TOOL_RESULT] Chat search requires an active chat context.';
            }

            const scopeId = args.scope === 'current_space' ? resolveSpaceIdFromExecutionContext(context) : undefined;
            if (args.scope === 'current_space' && !scopeId) {
                return '[TOOL_RESULT] Chat search requires an active chat context.';
            }
            const mode = args.mode || 'messages';
            const limit = Math.min(Math.max(args.limit || 6, 1), 12);

            if (mode === 'recollections') {
                const hits = searchRecollections(args.query, { spaceId: scopeId, limit });
                if (hits.length === 0) {
                    return args.scope === 'current_space'
                        ? `[TOOL_RESULT] No matching recollections were found in the current space for "${args.query}".`
                        : `[TOOL_RESULT] No matching recollections were found across tracked spaces for "${args.query}".`;
                }

                const scopeLabel = args.scope === 'current_space' ? 'current space' : 'tracked spaces';
                return `[TOOL_RESULT] Recollection search results for "${args.query}" in ${scopeLabel}:\n${hits.map(formatRecollectionLine).join('\n')}`;
            }

            const hits = searchMessages(args.query, {
                spaceId: scopeId,
                limit,
            });

            if (hits.length === 0) {
                return args.scope === 'current_space'
                    ? `[TOOL_RESULT] No matching history was found in the current space for "${args.query}".`
                    : `[TOOL_RESULT] No matching history was found across tracked spaces for "${args.query}".`;
            }

            const scopeLabel = args.scope === 'current_space' ? 'current space' : 'tracked spaces';
            return `[TOOL_RESULT] Message search results for "${args.query}" in ${scopeLabel}:\n${hits.map(formatHistoryLine).join('\n')}`;
        },
    },
};

export default skill;
