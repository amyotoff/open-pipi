import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    createProject,
    getActiveProjectForSpace,
    getSpace,
    getTask,
    linkProjectTarget,
    listProjects,
    memberHasTrustFlag,
    PROJECT_LINK_TYPES,
    PROJECT_STATES,
    ProjectLinkType,
    ProjectSnapshot,
    ProjectState,
    resolveProjectSelector,
    setSpaceActiveProject,
    unlinkProjectTarget,
    updateProject,
} from '../db';
import { rememberProjectMemory } from '../core/memory-write';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireProjectAuthority(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] Project management requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Project management requires an active chat context.' };
    }

    if (!memberHasTrustFlag(spaceId, context.userId, 'can_change_policies')) {
        return { ok: false, message: '[TOOL_RESULT] You do not have permission to manage projects in this space.' };
    }

    return { ok: true, spaceId };
}

function normalizeProjectStateInput(value: string | undefined): ProjectState | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    return (PROJECT_STATES as readonly string[]).includes(normalized) ? (normalized as ProjectState) : null;
}

function normalizeProjectLinkType(value: string | undefined): ProjectLinkType | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    return (PROJECT_LINK_TYPES as readonly string[]).includes(normalized) ? (normalized as ProjectLinkType) : null;
}

function resolveScopedProject(spaceId: string, selector?: string): ProjectSnapshot | undefined {
    const trimmed = selector?.trim();
    if (trimmed) {
        return resolveProjectSelector(trimmed);
    }

    return getActiveProjectForSpace(spaceId);
}

function formatCompactLinks(values: string[]): string {
    return values.length > 0 ? values.join(', ') : 'none';
}

function formatProjectSummary(project: ProjectSnapshot, activeProjectId?: string | null): string {
    const marker = activeProjectId === project.id ? ' (open here)' : '';
    return `- ${project.title}${marker}
  slug: ${project.slug}; state: ${project.state}
  goal: ${project.goal || 'none'}
  next: ${project.next_step || 'none'}`;
}

function formatProjectStatus(project: ProjectSnapshot, activeProjectId?: string | null): string {
    const focus = activeProjectId === project.id ? 'yes' : 'no';
    return `[TOOL_RESULT] Project ${project.title}
Slug: ${project.slug}
State: ${project.state}
Open in this space: ${focus}
Goal: ${project.goal || 'none'}
Next step: ${project.next_step || 'none'}
Preferred pack: ${project.active_pack_id || 'none'}
Linked spaces: ${formatCompactLinks(project.linked_spaces)}
Linked tasks: ${formatCompactLinks(project.linked_tasks)}
Linked artifacts: ${formatCompactLinks(project.linked_artifacts)}`;
}

function validateProjectLinkTarget(linkType: ProjectLinkType, targetId: string): string | null {
    const trimmed = targetId.trim();
    if (!trimmed) return 'Target cannot be empty.';

    if (linkType === 'space' && !getSpace(trimmed)) {
        return `Space "${trimmed}" was not found.`;
    }

    if (linkType === 'task' && !getTask(trimmed)) {
        return `Task "${trimmed}" was not found.`;
    }

    return null;
}

const skill: SkillManifest = {
    name: 'projects',
    description: 'Keep a simple long-running project in focus across a space, its tasks, artifacts, and memory',
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
            name: 'project_status',
            description: 'Show the currently open project in this space, or a specific project by slug or exact title.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    project_selector: { type: Type.STRING, description: 'Optional project slug or exact title.' },
                },
            },
        },
        {
            name: 'project_create',
            description:
                'Create a simple project with optional goal and next step. Active projects open immediately in the current space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Project title.' },
                    goal: { type: Type.STRING, description: 'Optional project goal.' },
                    next_step: { type: Type.STRING, description: 'Optional concrete next step.' },
                    state: {
                        type: Type.STRING,
                        enum: [...PROJECT_STATES],
                        description: 'Optional initial state, default active.',
                    },
                },
                required: ['title'],
            },
        },
        {
            name: 'project_list',
            description: 'List known projects, optionally filtering by state.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    state: {
                        type: Type.STRING,
                        enum: [...PROJECT_STATES],
                        description: 'Optional project state filter.',
                    },
                },
            },
        },
        {
            name: 'project_open',
            description: 'Open a project in the current space by slug or exact title and mark it active.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    project_selector: { type: Type.STRING, description: 'Project slug or exact title.' },
                },
                required: ['project_selector'],
            },
        },
        {
            name: 'project_next',
            description: 'Show or update the next step for the open project in this space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    project_selector: {
                        type: Type.STRING,
                        description: 'Optional project slug or exact title. Defaults to the open project.',
                    },
                    next_step: {
                        type: Type.STRING,
                        description: 'If provided, replace the project next step with this text.',
                    },
                },
            },
        },
        {
            name: 'project_pause',
            description: 'Pause a project by slug or exact title. Defaults to the open project in this space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    project_selector: { type: Type.STRING, description: 'Optional project slug or exact title.' },
                },
            },
        },
        {
            name: 'project_done',
            description: 'Mark a project done by slug or exact title. Defaults to the open project in this space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    project_selector: { type: Type.STRING, description: 'Optional project slug or exact title.' },
                },
            },
        },
        {
            name: 'project_link',
            description:
                'Manually link a space, task, or artifact to a project. Defaults to the open project in this space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    project_selector: { type: Type.STRING, description: 'Optional project slug or exact title.' },
                    link_type: {
                        type: Type.STRING,
                        enum: [...PROJECT_LINK_TYPES],
                        description: 'Type of target to link.',
                    },
                    target_id: {
                        type: Type.STRING,
                        description:
                            'Space ID, task ID, or artifact path. For space links, defaults to the current space when omitted.',
                    },
                },
                required: ['link_type'],
            },
        },
        {
            name: 'project_unlink',
            description: 'Remove a manual link from a project. Defaults to the open project in this space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    project_selector: { type: Type.STRING, description: 'Optional project slug or exact title.' },
                    link_type: {
                        type: Type.STRING,
                        enum: [...PROJECT_LINK_TYPES],
                        description: 'Type of target to unlink.',
                    },
                    target_id: {
                        type: Type.STRING,
                        description:
                            'Space ID, task ID, or artifact path. For space links, defaults to the current space when omitted.',
                    },
                },
                required: ['link_type'],
            },
        },
    ],
    handlers: {
        async project_status(args: { project_selector?: string }, context?: ExecutionContext) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const explicitSelector = args.project_selector?.trim();
            const activeProject = getActiveProjectForSpace(access.spaceId);
            const project = resolveScopedProject(access.spaceId, explicitSelector);
            if (!project) {
                if (explicitSelector) {
                    return `[TOOL_RESULT] Project "${explicitSelector}" was not found.`;
                }
                return activeProject
                    ? formatProjectStatus(activeProject, activeProject.id)
                    : '[TOOL_RESULT] No project is open in this space yet.';
            }

            return formatProjectStatus(project, activeProject?.id);
        },

        async project_create(
            args: { title: string; goal?: string; next_step?: string; state?: string },
            context?: ExecutionContext
        ) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const state = normalizeProjectStateInput(args.state) || 'active';
            const project = createProject({
                title: args.title,
                goal: args.goal,
                next_step: args.next_step,
                state,
                active_pack_id: getSpace(access.spaceId)?.assistant_pack_id || null,
            });
            linkProjectTarget(project.id, 'space', access.spaceId);

            if (project.state === 'active') {
                setSpaceActiveProject(access.spaceId, project.id);
            }

            rememberProjectMemory(
                project.id,
                'project_update',
                `Project created: ${project.title}. Goal: ${project.goal || 'none'}. Next step: ${project.next_step || 'none'}.`,
                { salience: 0.75, source: 'project_create' }
            );

            return `[TOOL_RESULT] Created project "${project.title}" (${project.slug}) with state "${project.state}"${project.state === 'active' ? ` and opened it in ${access.spaceId}` : ''}.`;
        },

        async project_list(args: { state?: string }, context?: ExecutionContext) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const state = normalizeProjectStateInput(args.state);
            if (args.state && !state) {
                return `[TOOL_RESULT] Unknown project state "${args.state}". Allowed: ${PROJECT_STATES.join(', ')}.`;
            }

            const activeProjectId = getActiveProjectForSpace(access.spaceId)?.id || null;
            const projects = listProjects(state || undefined);
            if (projects.length === 0) {
                return state
                    ? `[TOOL_RESULT] No projects were found in state "${state}".`
                    : '[TOOL_RESULT] No projects exist yet.';
            }

            const label = state ? `Projects in state "${state}"` : 'Projects';
            return `[TOOL_RESULT] ${label}:\n${projects.map((project) => formatProjectSummary(project, activeProjectId)).join('\n')}`;
        },

        async project_open(args: { project_selector: string }, context?: ExecutionContext) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const project = resolveProjectSelector(args.project_selector || '');
            if (!project) {
                return `[TOOL_RESULT] Project "${args.project_selector}" was not found.`;
            }

            const updated = updateProject(project.id, { state: 'active' });
            setSpaceActiveProject(access.spaceId, project.id);
            rememberProjectMemory(
                project.id,
                'project_update',
                `Opened in ${access.spaceId}. State is active. Next step: ${updated?.next_step || project.next_step || 'none'}.`,
                { salience: 0.6, source: 'project_open' }
            );

            return `[TOOL_RESULT] Opened project "${project.title}" in ${access.spaceId}.`;
        },

        async project_next(args: { project_selector?: string; next_step?: string }, context?: ExecutionContext) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const explicitSelector = args.project_selector?.trim();
            const project = resolveScopedProject(access.spaceId, explicitSelector);
            if (!project) {
                return explicitSelector
                    ? `[TOOL_RESULT] Project "${explicitSelector}" was not found.`
                    : '[TOOL_RESULT] No project is open in this space yet.';
            }

            const nextStep = args.next_step?.trim();
            if (!nextStep) {
                return `[TOOL_RESULT] Next step for "${project.title}": ${project.next_step || 'none'}.`;
            }

            const updated = updateProject(project.id, { next_step: nextStep });
            rememberProjectMemory(project.id, 'project_update', `Next step updated: ${nextStep}`, {
                salience: 0.7,
                source: 'project_next',
            });

            return `[TOOL_RESULT] Next step for "${updated?.title || project.title}" is now "${updated?.next_step || nextStep}".`;
        },

        async project_pause(args: { project_selector?: string }, context?: ExecutionContext) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const explicitSelector = args.project_selector?.trim();
            const project = resolveScopedProject(access.spaceId, explicitSelector);
            if (!project) {
                return explicitSelector
                    ? `[TOOL_RESULT] Project "${explicitSelector}" was not found.`
                    : '[TOOL_RESULT] No project is open in this space yet.';
            }

            updateProject(project.id, { state: 'paused' });
            if (getActiveProjectForSpace(access.spaceId)?.id === project.id) {
                setSpaceActiveProject(access.spaceId, null);
            }
            rememberProjectMemory(project.id, 'project_update', `Project paused in ${access.spaceId}.`, {
                salience: 0.6,
                source: 'project_pause',
            });

            return `[TOOL_RESULT] Project "${project.title}" is now paused.`;
        },

        async project_done(args: { project_selector?: string }, context?: ExecutionContext) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const explicitSelector = args.project_selector?.trim();
            const project = resolveScopedProject(access.spaceId, explicitSelector);
            if (!project) {
                return explicitSelector
                    ? `[TOOL_RESULT] Project "${explicitSelector}" was not found.`
                    : '[TOOL_RESULT] No project is open in this space yet.';
            }

            updateProject(project.id, { state: 'done' });
            if (getActiveProjectForSpace(access.spaceId)?.id === project.id) {
                setSpaceActiveProject(access.spaceId, null);
            }
            rememberProjectMemory(project.id, 'project_update', `Project marked done in ${access.spaceId}.`, {
                salience: 0.7,
                source: 'project_done',
            });

            return `[TOOL_RESULT] Project "${project.title}" is now done.`;
        },

        async project_link(
            args: { project_selector?: string; link_type: string; target_id?: string },
            context?: ExecutionContext
        ) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const explicitSelector = args.project_selector?.trim();
            const project = resolveScopedProject(access.spaceId, explicitSelector);
            if (!project) {
                return explicitSelector
                    ? `[TOOL_RESULT] Project "${explicitSelector}" was not found.`
                    : '[TOOL_RESULT] No project is open in this space yet.';
            }

            const linkType = normalizeProjectLinkType(args.link_type);
            if (!linkType) {
                return `[TOOL_RESULT] Unknown link type "${args.link_type}". Allowed: ${PROJECT_LINK_TYPES.join(', ')}.`;
            }

            const targetId = args.target_id?.trim() || (linkType === 'space' ? access.spaceId : '');
            if (!targetId) {
                return '[TOOL_RESULT] Target id is required for task and artifact links.';
            }

            const validationError = validateProjectLinkTarget(linkType, targetId);
            if (validationError) {
                return `[TOOL_RESULT] ${validationError}`;
            }

            linkProjectTarget(project.id, linkType, targetId);
            rememberProjectMemory(project.id, 'project_update', `Linked ${linkType}: ${targetId}`, {
                salience: 0.45,
                source: 'project_link',
            });

            return `[TOOL_RESULT] Linked ${linkType} "${targetId}" to "${project.title}".`;
        },

        async project_unlink(
            args: { project_selector?: string; link_type: string; target_id?: string },
            context?: ExecutionContext
        ) {
            const access = requireProjectAuthority(context);
            if (!access.ok) return access.message;

            const explicitSelector = args.project_selector?.trim();
            const project = resolveScopedProject(access.spaceId, explicitSelector);
            if (!project) {
                return explicitSelector
                    ? `[TOOL_RESULT] Project "${explicitSelector}" was not found.`
                    : '[TOOL_RESULT] No project is open in this space yet.';
            }

            const linkType = normalizeProjectLinkType(args.link_type);
            if (!linkType) {
                return `[TOOL_RESULT] Unknown link type "${args.link_type}". Allowed: ${PROJECT_LINK_TYPES.join(', ')}.`;
            }

            const targetId = args.target_id?.trim() || (linkType === 'space' ? access.spaceId : '');
            if (!targetId) {
                return '[TOOL_RESULT] Target id is required for task and artifact links.';
            }

            const removed = unlinkProjectTarget(project.id, linkType, targetId);
            if (removed === 0) {
                return `[TOOL_RESULT] ${linkType} "${targetId}" was not linked to "${project.title}".`;
            }

            if (
                linkType === 'space' &&
                targetId === access.spaceId &&
                getActiveProjectForSpace(access.spaceId)?.id === project.id
            ) {
                setSpaceActiveProject(access.spaceId, null);
            }
            rememberProjectMemory(project.id, 'project_update', `Unlinked ${linkType}: ${targetId}`, {
                salience: 0.4,
                source: 'project_unlink',
            });

            return `[TOOL_RESULT] Unlinked ${linkType} "${targetId}" from "${project.title}".`;
        },
    },
};

export default skill;
