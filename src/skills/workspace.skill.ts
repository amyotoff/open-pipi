import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { appendToolExecutionLogData } from '../db';
import {
    findWorkspaceFiles,
    findWorkspaceText,
    getWorkspaceSnapshot,
    getWorkspaceStatus,
    listWorkspaceArtifacts,
    listWorkspaceEntries,
    readWorkspaceText,
    writeWorkspaceArtifact,
} from '../core/workspace';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { appendTimelineEvent } from '../core/timeline';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireWorkspaceContext(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Workspace tools require an active chat context.' };
    }

    return { ok: true, spaceId };
}

const skill: SkillManifest = {
    name: 'workspace',
    description: 'Inspect an attached workspace, read text files, and save safe assistant artifacts',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        requires_workspace: true,
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'workspace_status',
            description: 'Show the currently attached workspace path for this space.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'workspace_list',
            description: 'List visible entries in the attached workspace. Use a relative path to inspect a subfolder.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    relative_path: {
                        type: Type.STRING,
                        description: 'Optional relative subfolder path inside the workspace.',
                    },
                },
            },
        },
        {
            name: 'workspace_read_text',
            description: 'Read a text file from the attached workspace using a relative path.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    relative_path: {
                        type: Type.STRING,
                        description: 'Relative path to a text file inside the workspace.',
                    },
                },
                required: ['relative_path'],
            },
        },
        {
            name: 'workspace_find_files',
            description: 'Search file and folder names inside the attached workspace.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: {
                        type: Type.STRING,
                        description: 'Case-insensitive fragment to look for in workspace paths.',
                    },
                },
                required: ['query'],
            },
        },
        {
            name: 'workspace_find_text',
            description: 'Search plain-text file contents inside the attached workspace and return short previews.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'Text fragment to search for in workspace files.' },
                },
                required: ['query'],
            },
        },
        {
            name: 'workspace_list_artifacts',
            description: 'List saved assistant artifacts under .pipi/artifacts in the attached workspace.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    folder: { type: Type.STRING, description: 'Optional artifact subfolder under .pipi/.' },
                },
            },
        },
        {
            name: 'workspace_save_artifact',
            description:
                'Save assistant output as a markdown artifact under .pipi/artifacts in the attached workspace.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Short artifact title.' },
                    content: { type: Type.STRING, description: 'Artifact body content.' },
                    folder: { type: Type.STRING, description: 'Optional artifact subfolder under .pipi/.' },
                },
                required: ['title', 'content'],
            },
        },
    ],
    handlers: {
        async workspace_status(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireWorkspaceContext(context);
            if (!access.ok) return access.message;

            try {
                const status = await getWorkspaceStatus(access.spaceId);
                const snapshot = getWorkspaceSnapshot(access.spaceId);
                const entries =
                    snapshot.entries.length > 0 ? `\nTop-level entries: ${snapshot.entries.join(', ')}` : '';
                if (context?.toolExecutionId) {
                    appendToolExecutionLogData(context.toolExecutionId, {
                        files_read: ['.'],
                        workspace_root: status.root,
                    });
                }
                return `[TOOL_RESULT] Workspace for ${access.spaceId}: ${status.root} (${status.exists ? 'available' : 'missing'})${entries}`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async workspace_list(args: { relative_path?: string }, context?: ExecutionContext) {
            const access = requireWorkspaceContext(context);
            if (!access.ok) return access.message;

            try {
                const entries = await listWorkspaceEntries(access.spaceId, args.relative_path);
                if (context?.toolExecutionId) {
                    appendToolExecutionLogData(context.toolExecutionId, {
                        files_read: [args.relative_path || '.'],
                    });
                }
                if (entries.length === 0) {
                    return '[TOOL_RESULT] The requested workspace folder is empty.';
                }
                return `[TOOL_RESULT] Workspace entries:\n${entries
                    .map(
                        (entry) =>
                            `- ${entry.relative_path} (${entry.type}${entry.type === 'file' ? `, ${entry.size} bytes` : ''})`
                    )
                    .join('\n')}`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async workspace_read_text(args: { relative_path: string }, context?: ExecutionContext) {
            const access = requireWorkspaceContext(context);
            if (!access.ok) return access.message;

            try {
                const text = await readWorkspaceText(access.spaceId, args.relative_path);
                if (context?.toolExecutionId) {
                    appendToolExecutionLogData(context.toolExecutionId, {
                        files_read: [args.relative_path],
                    });
                }
                return `[TOOL_RESULT] <WORKSPACE_FILE path="${args.relative_path}">\n${text}\n</WORKSPACE_FILE>`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async workspace_find_files(args: { query: string }, context?: ExecutionContext) {
            const access = requireWorkspaceContext(context);
            if (!access.ok) return access.message;

            try {
                const matches = await findWorkspaceFiles(access.spaceId, args.query);
                if (matches.length === 0) {
                    return `[TOOL_RESULT] No workspace files or folders matched "${args.query}".`;
                }
                return `[TOOL_RESULT] Workspace path matches:\n${matches.map((entry) => `- ${entry.relative_path} (${entry.type})`).join('\n')}`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async workspace_find_text(args: { query: string }, context?: ExecutionContext) {
            const access = requireWorkspaceContext(context);
            if (!access.ok) return access.message;

            try {
                const matches = await findWorkspaceText(access.spaceId, args.query);
                if (matches.length === 0) {
                    return `[TOOL_RESULT] No workspace text matched "${args.query}".`;
                }
                return `[TOOL_RESULT] Workspace text matches:\n${matches.map((entry) => `- ${entry.relative_path}: ${entry.preview}`).join('\n')}`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async workspace_list_artifacts(args: { folder?: string }, context?: ExecutionContext) {
            const access = requireWorkspaceContext(context);
            if (!access.ok) return access.message;

            try {
                const entries = await listWorkspaceArtifacts(access.spaceId, args.folder);
                if (context?.toolExecutionId) {
                    appendToolExecutionLogData(context.toolExecutionId, {
                        files_read: [args.folder ? `.pipi/${args.folder}` : '.pipi/artifacts'],
                    });
                }
                if (entries.length === 0) {
                    return '[TOOL_RESULT] No saved workspace artifacts were found.';
                }
                return `[TOOL_RESULT] Workspace artifacts:\n${entries
                    .map(
                        (entry) =>
                            `- ${entry.relative_path} (${entry.type}${entry.type === 'file' ? `, ${entry.size} bytes` : ''})`
                    )
                    .join('\n')}`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async workspace_save_artifact(
            args: { title: string; content: string; folder?: string },
            context?: ExecutionContext
        ) {
            const access = requireWorkspaceContext(context);
            if (!access.ok) return access.message;

            try {
                const saved = await writeWorkspaceArtifact(access.spaceId, args.title, args.content, args.folder);
                if (context?.toolExecutionId) {
                    appendToolExecutionLogData(context.toolExecutionId, {
                        files_written: [saved.relativePath],
                        artifacts: [saved.relativePath],
                    });
                }
                appendTimelineEvent({
                    spaceId: access.spaceId,
                    type: 'workspace.artifact_saved',
                    refType: 'artifact_file',
                    refId: saved.relativePath,
                    summary: `Saved workspace artifact "${args.title}" to ${saved.relativePath}.`,
                    details: {
                        title: args.title,
                        path: saved.relativePath,
                        folder: args.folder || 'artifacts',
                    },
                });
                return `[TOOL_RESULT] Saved artifact to ${saved.relativePath} (${saved.absolutePath}).`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },
    },
};

export default skill;
