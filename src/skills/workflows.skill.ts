import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getSpace } from '../db';
import { listWorkspaceArtifacts, writeWorkspaceArtifact } from '../core/workspace';
import { listWorkflowTemplatesForPack, renderWorkflowArtifact, WorkflowTemplateId } from '../core/workflows';
import { rememberWorkflowArtifact } from '../core/memory-write';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { appendTimelineEvent } from '../core/timeline';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireWorkflowContext(
    context?: ExecutionContext
): { ok: true; spaceId: string; packId: string } | { ok: false; message: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Workflow tools require an active chat context.' };
    }

    const packId = getSpace(spaceId)?.assistant_pack_id || 'jeeves';
    return { ok: true, spaceId, packId };
}

function formatArtifactList(entries: Awaited<ReturnType<typeof listWorkspaceArtifacts>>): string {
    return entries
        .map(
            (entry) => `- ${entry.relative_path} (${entry.type}${entry.type === 'file' ? `, ${entry.size} bytes` : ''})`
        )
        .join('\n');
}

async function saveWorkflowArtifact(
    templateId: WorkflowTemplateId,
    args: { title: string; summary?: string; body?: string; bullets?: string; extra?: string },
    context?: ExecutionContext
): Promise<string> {
    const access = requireWorkflowContext(context);
    if (!access.ok) return access.message;

    const templates = listWorkflowTemplatesForPack(access.packId);
    if (!templates.some((template) => template.id === templateId)) {
        return `[TOOL_RESULT] Template "${templateId}" is not available for pack "${access.packId}".`;
    }

    try {
        const rendered = renderWorkflowArtifact(templateId, args);
        const saved = await writeWorkspaceArtifact(access.spaceId, rendered.title, rendered.content, rendered.folder);
        rememberWorkflowArtifact(access.spaceId, templateId, rendered.title, saved.relativePath, access.packId);
        appendTimelineEvent({
            spaceId: access.spaceId,
            type: 'workflow.artifact_saved',
            refType: 'artifact_file',
            refId: saved.relativePath,
            summary: `Saved ${templateId} artifact "${rendered.title}" to ${saved.relativePath}.`,
            details: {
                template_id: templateId,
                title: rendered.title,
                path: saved.relativePath,
                pack_id: access.packId,
            },
        });
        return `[TOOL_RESULT] Saved ${templateId} artifact to ${saved.relativePath} (${saved.absolutePath}).`;
    } catch (error: any) {
        return `[TOOL_RESULT] ${error.message}`;
    }
}

const skill: SkillManifest = {
    name: 'workflows',
    description: 'Pack-aware workflow artifacts for tutor, office, and reporter workspaces',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        requires_workspace: true,
        pack_tags: ['tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'workflow_list_templates',
            description: 'List the workflow artifact templates available for the current assistant pack.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'workflow_list_recent_artifacts',
            description: 'List recently saved workflow artifacts for the current pack.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'tutor_create_lesson_note',
            description: 'Save a lesson note artifact for the tutor pack.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Short lesson note title.' },
                    summary: { type: Type.STRING, description: 'Learning goal or lesson focus.' },
                    body: { type: Type.STRING, description: 'Lesson summary.' },
                    bullets: { type: Type.STRING, description: 'Key points, one per line.' },
                    extra: { type: Type.STRING, description: 'Next steps, one per line.' },
                },
                required: ['title'],
            },
        },
        {
            name: 'office_create_followup',
            description: 'Save a team follow-up artifact for the office pack.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Follow-up title.' },
                    summary: { type: Type.STRING, description: 'Short summary of the meeting or thread.' },
                    body: { type: Type.STRING, description: 'Decisions taken.' },
                    bullets: { type: Type.STRING, description: 'Action items, one per line.' },
                    extra: { type: Type.STRING, description: 'Open questions, one per line.' },
                },
                required: ['title'],
            },
        },
        {
            name: 'reporter_create_brief',
            description: 'Save an article brief artifact for the reporter pack.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Working title.' },
                    summary: { type: Type.STRING, description: 'Angle or thesis.' },
                    body: { type: Type.STRING, description: 'Brief body.' },
                    bullets: { type: Type.STRING, description: 'Source targets, one per line.' },
                    extra: { type: Type.STRING, description: 'Filing notes, one per line.' },
                },
                required: ['title'],
            },
        },
        {
            name: 'reporter_create_draft',
            description: 'Save an article draft artifact for the reporter pack.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Draft title.' },
                    summary: { type: Type.STRING, description: 'Short deck or framing line.' },
                    body: { type: Type.STRING, description: 'Draft body text.' },
                    bullets: { type: Type.STRING, description: 'Notes, one per line.' },
                    extra: { type: Type.STRING, description: 'Editorial notes, one per line.' },
                },
                required: ['title', 'body'],
            },
        },
    ],
    handlers: {
        async workflow_list_templates(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireWorkflowContext(context);
            if (!access.ok) return access.message;

            const templates = listWorkflowTemplatesForPack(access.packId);
            if (templates.length === 0) {
                return `[TOOL_RESULT] No workflow templates are available for pack "${access.packId}".`;
            }

            return `[TOOL_RESULT] Workflow templates for "${access.packId}":\n${templates
                .map((template) => `- ${template.id}: ${template.title} (${template.description})`)
                .join('\n')}`;
        },

        async workflow_list_recent_artifacts(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireWorkflowContext(context);
            if (!access.ok) return access.message;

            const templates = listWorkflowTemplatesForPack(access.packId);
            const folder = templates[0]?.folder || access.packId;

            try {
                const entries = await listWorkspaceArtifacts(access.spaceId, folder);
                if (entries.length === 0) {
                    return `[TOOL_RESULT] No workflow artifacts were found yet for pack "${access.packId}".`;
                }

                return `[TOOL_RESULT] Recent workflow artifacts for "${access.packId}":\n${formatArtifactList(entries)}`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async tutor_create_lesson_note(
            args: { title: string; summary?: string; body?: string; bullets?: string; extra?: string },
            context?: ExecutionContext
        ) {
            return saveWorkflowArtifact('tutor_lesson_note', args, context);
        },

        async office_create_followup(
            args: { title: string; summary?: string; body?: string; bullets?: string; extra?: string },
            context?: ExecutionContext
        ) {
            return saveWorkflowArtifact('office_followup', args, context);
        },

        async reporter_create_brief(
            args: { title: string; summary?: string; body?: string; bullets?: string; extra?: string },
            context?: ExecutionContext
        ) {
            return saveWorkflowArtifact('reporter_brief', args, context);
        },

        async reporter_create_draft(
            args: { title: string; summary?: string; body: string; bullets?: string; extra?: string },
            context?: ExecutionContext
        ) {
            return saveWorkflowArtifact('reporter_draft', args, context);
        },
    },
};

export default skill;
