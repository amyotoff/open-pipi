import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    createArtifact,
    getArtifact,
    getSpace,
    listArtifacts,
    updateArtifact,
    archiveOldArtifactsForKind,
} from '../db';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import crypto from 'crypto';
import { appendTimelineEvent } from '../core/timeline';

const ALLOWED_KINDS = new Set(['plan', 'walkthrough', 'task_list', 'code', 'diff', 'logs', 'review', 'handoff']);

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireSpace(
    context?: ExecutionContext
): { ok: true; spaceId: string; messageId: string | null } | { ok: false; message: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_ERROR] Chat context missing.' };
    }
    return { ok: true, spaceId, messageId: null };
}

const skill: SkillManifest = {
    name: 'artifacts',
    description:
        'Manage persistent structured markdown documents (artifacts) for the current space like plans, walkthroughs, tasks, or code diffs.',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'office', 'workspace', 'coder'],
    },
    tools: [
        {
            name: 'artifacts_create',
            description:
                'Create a new artifact for the current space. For plans or task_lists, this will automatically archive older artifacts of the same kind.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    kind: {
                        type: Type.STRING,
                        description:
                            'Type of artifact: "plan", "walkthrough", "task_list", "code", "diff", "logs", "review", "handoff", etc.',
                    },
                    title: { type: Type.STRING, description: 'Human-friendly title.' },
                    ref: { type: Type.STRING, description: 'The text content, markdown, or code.' },
                    summary: { type: Type.STRING, description: 'Brief 1-sentence summary for search.' },
                },
                required: ['kind', 'title', 'ref', 'summary'],
            },
        },
        {
            name: 'artifacts_update',
            description: 'Update the content (ref) of an existing mutable artifact (like a task_list or diff).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING, description: 'ID of the artifact to update.' },
                    ref: { type: Type.STRING, description: 'The new fully replaced text content.' },
                    summary: { type: Type.STRING, description: 'Updated summary (optional).' },
                },
                required: ['id', 'ref'],
            },
        },
        {
            name: 'artifacts_list',
            description: 'List all active (unarchived) artifacts in the current space.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'artifacts_archive',
            description: 'Archive an artifact to hide it from the active list.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING, description: 'ID of the artifact to archive.' },
                },
                required: ['id'],
            },
        },
        {
            name: 'artifacts_copy_to_space',
            description:
                'Copy an artifact from the current space to another space. Creates a new independent copy in the target space. Useful for sharing plans, reports, or handoffs across projects.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.STRING, description: 'ID of the artifact to copy.' },
                    target_space_id: {
                        type: Type.STRING,
                        description: 'The space_id to copy the artifact into (e.g. "telegram:-1001234567890").',
                    },
                },
                required: ['id', 'target_space_id'],
            },
        },
        {
            name: 'artifacts_list_other_space',
            description:
                'List active artifacts in another space (read-only). Useful for checking what plans or documents exist in a different project before copying.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    target_space_id: {
                        type: Type.STRING,
                        description: 'The space_id to list artifacts from.',
                    },
                },
                required: ['target_space_id'],
            },
        },
    ],
    handlers: {
        async artifacts_create(
            args: { kind: string; title: string; ref: string; summary: string },
            context?: ExecutionContext
        ) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const kind = args.kind.trim().toLowerCase();
            if (!ALLOWED_KINDS.has(kind)) {
                return `[TOOL_RESULT] Unknown artifact kind '${args.kind}'. Allowed: ${[...ALLOWED_KINDS].join(', ')}.`;
            }

            const newId = 'art_' + crypto.randomUUID();
            createArtifact({
                id: newId,
                space_id: access.spaceId,
                source_message_id: null,
                kind,
                title: args.title,
                ref: args.ref,
                summary: args.summary,
            });

            // Rotation logic: plan/task_list/handoff keep only the latest active sibling
            const rotated = kind === 'plan' || kind === 'task_list' || kind === 'handoff';
            if (rotated) {
                archiveOldArtifactsForKind(access.spaceId, kind, newId);
            }

            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'artifact.created',
                refType: 'artifact_db',
                refId: newId,
                summary: `Created ${kind} artifact "${args.title}".`,
                details: { kind, title: args.title, rotated },
            });

            return `[TOOL_RESULT] Artifact created successfully. ID: ${newId}.${rotated ? ` Old '${kind}' artifacts were archived.` : ''}`;
        },
        async artifacts_update(args: { id: string; ref: string; summary?: string }, context?: ExecutionContext) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const existing = getArtifact(args.id);
            if (!existing || existing.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Artifact ID ${args.id} not found.`;
            }
            if (existing.kind === 'journal_day') {
                return `[TOOL_RESULT] Artifact ${args.id} is a derived journal and cannot be edited directly.`;
            }

            const updated = updateArtifact(args.id, { ref: args.ref, summary: args.summary });
            if (!updated) {
                return `[TOOL_RESULT] Artifact ID ${args.id} not found.`;
            }

            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'artifact.updated',
                refType: 'artifact_db',
                refId: args.id,
                summary: `Updated ${updated.kind} artifact "${updated.title}".`,
                details: { kind: updated.kind, title: updated.title },
            });
            return `[TOOL_RESULT] Artifact ${args.id} updated successfully.`;
        },
        async artifacts_list(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const items = listArtifacts(access.spaceId, { includeArchived: false, limit: 20 }).filter(
                (item) => item.kind !== 'journal_day'
            );
            if (items.length === 0) return '[TOOL_RESULT] No active artifacts found for this space.';

            return (
                '[TOOL_RESULT] Active artifacts:\n' +
                items
                    .map(
                        (i) => `[${i.id}] ${i.kind.toUpperCase()}: ${i.title} - ${i.summary} (Updated: ${i.updated_at})`
                    )
                    .join('\n')
            );
        },
        async artifacts_archive(args: { id: string }, context?: ExecutionContext) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const existing = getArtifact(args.id);
            if (!existing || existing.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Artifact ID ${args.id} not found.`;
            }
            if (existing.kind === 'journal_day') {
                return `[TOOL_RESULT] Artifact ${args.id} is a derived journal and cannot be archived manually.`;
            }

            const archivedAt = new Date().toISOString();
            const updated = updateArtifact(args.id, { archived_at: archivedAt });
            if (!updated) {
                return `[TOOL_RESULT] Artifact ID ${args.id} not found.`;
            }

            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'artifact.archived',
                refType: 'artifact_db',
                refId: args.id,
                summary: `Archived ${existing.kind} artifact "${existing.title}".`,
                details: { kind: existing.kind, title: existing.title },
            });
            return `[TOOL_RESULT] Artifact ${args.id} has been archived.`;
        },
        async artifacts_copy_to_space(args: { id: string; target_space_id: string }, context?: ExecutionContext) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const existing = getArtifact(args.id);
            if (!existing || existing.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Artifact ID ${args.id} not found in current space.`;
            }

            const targetSpace = getSpace(args.target_space_id);
            if (!targetSpace) {
                return `[TOOL_RESULT] Target space '${args.target_space_id}' not found.`;
            }

            const copyId = 'art_' + crypto.randomUUID();
            const copySummary = `${existing.summary} [copied from ${access.spaceId}]`;
            createArtifact({
                id: copyId,
                space_id: args.target_space_id,
                source_message_id: null,
                kind: existing.kind,
                title: existing.title,
                ref: existing.ref,
                summary: copySummary,
            });

            appendTimelineEvent({
                spaceId: access.spaceId,
                type: 'artifact.copied_out',
                refType: 'artifact_db',
                refId: args.id,
                summary: `Copied ${existing.kind} artifact "${existing.title}" to space ${args.target_space_id}.`,
                details: {
                    kind: existing.kind,
                    title: existing.title,
                    target_space_id: args.target_space_id,
                    copy_id: copyId,
                },
            });
            appendTimelineEvent({
                spaceId: args.target_space_id,
                type: 'artifact.copied_in',
                refType: 'artifact_db',
                refId: copyId,
                summary: `Received ${existing.kind} artifact "${existing.title}" from space ${access.spaceId}.`,
                details: {
                    kind: existing.kind,
                    title: existing.title,
                    source_space_id: access.spaceId,
                    original_id: args.id,
                },
            });

            return `[TOOL_RESULT] Artifact copied successfully. New copy ID: ${copyId} in space ${args.target_space_id}.`;
        },
        async artifacts_list_other_space(args: { target_space_id: string }, context?: ExecutionContext) {
            const access = requireSpace(context);
            if (!access.ok) return access.message;

            const targetSpace = getSpace(args.target_space_id);
            if (!targetSpace) {
                return `[TOOL_RESULT] Target space '${args.target_space_id}' not found.`;
            }

            const items = listArtifacts(args.target_space_id, { includeArchived: false, limit: 20 }).filter(
                (item) => item.kind !== 'journal_day'
            );
            if (items.length === 0) {
                return `[TOOL_RESULT] No active artifacts found in space '${args.target_space_id}'.`;
            }

            return (
                `[TOOL_RESULT] Active artifacts in space '${args.target_space_id}':\n` +
                items
                    .map(
                        (i) => `[${i.id}] ${i.kind.toUpperCase()}: ${i.title} - ${i.summary} (Updated: ${i.updated_at})`
                    )
                    .join('\n')
            );
        },
    },
};

export default skill;
