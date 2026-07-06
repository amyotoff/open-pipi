import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    createHtmlArtifactPage,
    generateTaskBoard,
    HTML_ARTIFACT_KINDS,
    listHtmlArtifactPages,
} from '../core/html-artifacts';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { appendTimelineEvent } from '../core/timeline';
import { sendChannelFile } from '../channels/runtime';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireSpace(context?: ExecutionContext): { ok: true; spaceId: string } | { ok: false; message: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] HTML artifacts require an active chat context.' };
    }
    return { ok: true, spaceId };
}

const skill: SkillManifest = {
    name: 'html_artifacts',
    description:
        'Create shareable HTML pages for long plans, research notes, briefs, reports, meeting notes, complex work summaries, and agent morning plans.',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'office', 'reporter', 'tutor'],
    },
    tools: [
        {
            name: 'html_artifact_create',
            description:
                "Create a polished shareable HTML artifact. Use for long or complex plans, research, reports, meeting notes, work breakdowns, or morning plans ('agent_plan') instead of sending a giant chat message.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    kind: {
                        type: Type.STRING,
                        description: `Artifact kind. Allowed: ${HTML_ARTIFACT_KINDS.join(', ')}.`,
                    },
                    title: { type: Type.STRING, description: 'Short page title.' },
                    summary: { type: Type.STRING, description: 'One-sentence summary shown under the title.' },
                    body: {
                        type: Type.STRING,
                        description:
                            'Main content in simple markdown: headings as **Heading** or ## Heading, bullets as "- item". For \'agent_plan\', use checklists e.g., "- [ ] Task (10:00) [gcal]". If omitted/empty for \'agent_plan\', it auto-queries active tasks from SQLite.',
                    },
                },
                required: ['title'],
            },
        },
        {
            name: 'html_artifact_list',
            description: 'List recently created HTML artifacts on this runtime.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    limit: { type: Type.INTEGER, description: 'Maximum number of artifacts to list, default 10.' },
                },
            },
        },
        {
            name: 'task_board_generate',
            description:
                'Generate or refresh a kanban-style task board page showing all scheduled tasks grouped by status (active, paused, completed). Returns a stable URL that auto-refreshes.',
            parameters: {
                type: Type.OBJECT,
                properties: {},
            },
        },
    ],
    handlers: {
        async html_artifact_create(
            args: { kind?: string; title: string; summary?: string; body?: string },
            context?: ExecutionContext
        ) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const title = args.title?.trim();
            const body = args.body !== undefined ? args.body.trim() : '';
            if (!title || (args.kind !== 'agent_plan' && !body)) {
                return '[TOOL_RESULT] html_artifact_create requires title and body.';
            }

            const page = createHtmlArtifactPage({
                spaceId: access.spaceId,
                kind: args.kind,
                title,
                summary: args.summary?.trim(),
                body,
            });

            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'html_artifact.created',
                refType: 'html_artifact',
                refId: page.fileName,
                summary: `Created HTML artifact "${title}".`,
                details: {
                    title,
                    kind: args.kind || 'brief',
                    file_name: page.fileName,
                    url: page.url,
                },
            });

            if (page.url) {
                return `[TOOL_RESULT] HTML artifact created: ${page.url}`;
            }

            const channel = context?.channel || (context?.chatId ? 'telegram' : undefined);
            const channelRef = context?.channelRef || context?.chatId;
            if (channel && channelRef) {
                const sendResult = await sendChannelFile(channel, channelRef, page.filePath, {
                    filename: page.fileName,
                    caption: `HTML artifact: ${title}`,
                });
                if (sendResult.success) {
                    return `[TOOL_RESULT] HTML artifact created and attached to the chat as ${page.fileName}.`;
                }
                return `[TOOL_RESULT] HTML artifact created at ${page.filePath}, but attachment delivery failed: ${sendResult.error || 'unknown error'}.`;
            }

            return `[TOOL_RESULT] HTML artifact created locally at ${page.filePath}. Public URL is not configured and no channel attachment context is available.`;
        },

        async html_artifact_list(args: { limit?: number }) {
            const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Math.floor(args.limit || 10), 50)) : 10;
            const items = listHtmlArtifactPages(limit);
            if (items.length === 0) {
                return '[TOOL_RESULT] No HTML artifacts found.';
            }

            return `[TOOL_RESULT] Recent HTML artifacts:\n${items
                .map((item) => `- ${item.url || item.filePath} (${item.size} bytes, updated ${item.updatedAt})`)
                .join('\n')}`;
        },

        async task_board_generate(_args: Record<string, never>, context?: ExecutionContext) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const page = generateTaskBoard(access.spaceId);

            if (page.url) {
                return `[TOOL_RESULT] Task board generated: ${page.url}`;
            }

            return `[TOOL_RESULT] Task board generated locally at ${page.filePath}. Public URL is not configured.`;
        },
    },
};

export default skill;
