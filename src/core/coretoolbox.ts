import { FunctionDeclaration, Type } from '@google/genai';
import { getMemberEffectiveAuthority, getResident, getSpace, getSpaceParticipants } from '../db';
import { LOCATION_LAT, LOCATION_LON } from '../config';
import {
    resolveChannelRefFromExecutionContext,
    resolveSpaceIdFromExecutionContext,
    RuntimeExecutionContext,
} from './runtime-context';

export type CorePrimitiveId = 'web' | 'file_search' | 'user_info' | 'personal_context' | 'automations' | 'api_tool';

export type SystemCapabilityId = 'bio' | 'execution_runtime';

export interface CoreToolboxEntry<TId extends string = string> {
    id: TId;
    description: string;
    backing_capabilities: string[];
    backing_tools: string[];
}

export interface MaterializedCoreToolbox {
    primitives: CoreToolboxEntry<CorePrimitiveId>[];
    system_capabilities: CoreToolboxEntry<SystemCapabilityId>[];
}

type EntryTemplate<TId extends string> = {
    id: TId;
    description: string;
    capability_names: string[];
    tool_names: string[];
};

const PRIMITIVE_TEMPLATES: EntryTemplate<CorePrimitiveId>[] = [
    {
        id: 'web',
        description: 'Internet access for search, page reading, and deeper multi-step research.',
        capability_names: ['browsing', 'webrun'],
        tool_names: ['web_search', 'browse_web', 'webrun_execute'],
    },
    {
        id: 'file_search',
        description: 'Search and read attached workspace files and assistant artifacts.',
        capability_names: ['workspace'],
        tool_names: [
            'workspace_status',
            'workspace_list',
            'workspace_read_text',
            'workspace_find_files',
            'workspace_find_text',
            'workspace_list_artifacts',
        ],
    },
    {
        id: 'user_info',
        description:
            'Current local time, search date, channel reference, and execution context for the active user and space.',
        capability_names: [],
        tool_names: [],
    },
    {
        id: 'personal_context',
        description:
            'Relevant long-term memory, prior chat history, participant context, and space-level recollection.',
        capability_names: ['memory', 'history', 'members', 'spaces'],
        tool_names: ['memory_recall', 'resident_profile', 'activity_log', 'chat_search', 'member_list', 'space_status'],
    },
    {
        id: 'automations',
        description: 'Shopping items, reminders, and recurring scheduled tasks for the current space.',
        capability_names: ['shopping', 'reminders', 'tasks'],
        tool_names: [
            'shopping_add',
            'shopping_list',
            'shopping_complete',
            'shopping_remove',
            'reminder_set',
            'reminder_list',
            'reminder_cancel',
            'task_create',
            'task_list',
            'task_pause',
            'task_run_now',
            'task_resume',
            'task_cancel',
        ],
    },
    {
        id: 'api_tool',
        description: 'External integrations and special action adapters behind a single integration surface.',
        capability_names: [],
        tool_names: [],
    },
];

const SYSTEM_TEMPLATES: EntryTemplate<SystemCapabilityId>[] = [
    {
        id: 'bio',
        description: 'Long-term memory writes and deletes for stable personal context.',
        capability_names: ['memory'],
        tool_names: ['memory_remember', 'memory_forget', 'resident_set_name', 'resident_learn_habit'],
    },
    {
        id: 'execution_runtime',
        description:
            'Internal compute and shell runtime for implementation-side execution, not a direct user-facing tool.',
        capability_names: [],
        tool_names: [],
    },
];

function materializeEntries<TId extends string>(
    templates: EntryTemplate<TId>[],
    enabledCapabilities: string[]
): CoreToolboxEntry<TId>[] {
    return templates.map((template) => ({
        id: template.id,
        description: template.description,
        backing_capabilities: template.capability_names.filter((name) => enabledCapabilities.includes(name)),
        backing_tools: template.tool_names,
    }));
}

export function materializeCoreToolbox(enabledCapabilities: string[]): MaterializedCoreToolbox {
    return {
        primitives: materializeEntries(PRIMITIVE_TEMPLATES, enabledCapabilities),
        system_capabilities: materializeEntries(SYSTEM_TEMPLATES, enabledCapabilities),
    };
}

export function listCorePrimitiveIds(): CorePrimitiveId[] {
    return PRIMITIVE_TEMPLATES.map((template) => template.id);
}

export function listSystemCapabilityIds(): SystemCapabilityId[] {
    return SYSTEM_TEMPLATES.map((template) => template.id);
}

type ToolHandler = (args: any, context?: RuntimeExecutionContext) => Promise<string>;
type HandlerMap = Record<string, ToolHandler>;

async function getAgentForSpace(spaceId: string): Promise<{ id: string; persona_id: string }> {
    const mod = await import('./agent-kernel');
    return mod.materializeAgentForSpace(spaceId);
}

async function getRuntimePackTools(context?: RuntimeExecutionContext): Promise<Array<{ id: string }>> {
    const mod = await import('./pack-tool-runtime');
    return mod.getPackToolsForContext(context);
}

async function runRuntimePackTool(toolId: string, args: any, context: RuntimeExecutionContext): Promise<string> {
    const mod = await import('./pack-tool-runtime');
    return mod.executePackTool(toolId, args, context);
}

export const CORE_TOOLBOX_TOOL_DECLARATIONS: FunctionDeclaration[] = [
    {
        name: 'web',
        description:
            'Unified web primitive. Search the internet, read a page by URL, or run deeper multi-step web research.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                operation: {
                    type: Type.STRING,
                    enum: ['search', 'read_page', 'deep_research'],
                    description: 'What kind of web action to perform.',
                },
                query: { type: Type.STRING, description: 'Search query for fast web search.' },
                url: { type: Type.STRING, description: 'Absolute URL to read.' },
                task: { type: Type.STRING, description: 'Detailed research brief for deep web research.' },
            },
            required: ['operation'],
        },
    },
    {
        name: 'file_search',
        description: 'Unified file primitive for attached workspace search, reading, listing, and artifact saving.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                operation: {
                    type: Type.STRING,
                    enum: ['status', 'list', 'read_text', 'find_files', 'find_text', 'list_artifacts', 'save_artifact'],
                    description: 'What kind of workspace action to perform.',
                },
                relative_path: { type: Type.STRING, description: 'Relative path inside the workspace.' },
                query: { type: Type.STRING, description: 'Search query for names or text content.' },
                folder: { type: Type.STRING, description: 'Optional .pipi subfolder for artifact listing or saving.' },
                title: { type: Type.STRING, description: 'Artifact title when saving.' },
                content: { type: Type.STRING, description: 'Artifact body when saving.' },
            },
            required: ['operation'],
        },
    },
    {
        name: 'user_info',
        description: 'Current local time and execution context for the active speaker and space.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                detail: {
                    type: Type.STRING,
                    enum: ['summary', 'time', 'speaker', 'space', 'participants', 'policies'],
                    description: 'Which slice of user and space context to return.',
                },
            },
        },
    },
    {
        name: 'personal_context',
        description:
            'Unified personal-context primitive for memory recall, profiles, activity, prior chat search, and space context.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                operation: {
                    type: Type.STRING,
                    enum: ['recall', 'profile', 'activity', 'history', 'recollections', 'space_status', 'members'],
                    description: 'What personal-context action to perform.',
                },
                query: { type: Type.STRING, description: 'Search query for recall or history.' },
                person_id: { type: Type.STRING, description: 'Participant ID for resident profile lookup.' },
                scope: {
                    type: Type.STRING,
                    enum: ['current_space', 'all_spaces'],
                    description: 'History search scope.',
                },
                type: {
                    type: Type.STRING,
                    enum: ['tool_call', 'reboot', 'all'],
                    description: 'Activity log type filter.',
                },
                limit: { type: Type.INTEGER, description: 'Optional result limit.' },
            },
            required: ['operation'],
        },
    },
    {
        name: 'automations',
        description: 'Unified shopping, reminder, and recurring-task primitive for practical assistant follow-through.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                operation: {
                    type: Type.STRING,
                    enum: [
                        'add_shopping_item',
                        'list_shopping_items',
                        'complete_shopping_item',
                        'remove_shopping_item',
                        'set_reminder',
                        'list_reminders',
                        'cancel_reminder',
                        'create_task',
                        'list_tasks',
                        'pause_task',
                        'resume_task',
                        'run_task',
                        'cancel_task',
                    ],
                    description: 'What shopping or scheduling action to perform.',
                },
                item: { type: Type.STRING, description: 'Shopping item to buy.' },
                quantity: { type: Type.STRING, description: 'Optional shopping quantity or pack size.' },
                item_id: { type: Type.INTEGER, description: 'Shopping item ID for complete/remove.' },
                content: { type: Type.STRING, description: 'Reminder content.' },
                remind_at: { type: Type.STRING, description: 'Optional ISO date/time for the reminder.' },
                schedule_text: {
                    type: Type.STRING,
                    description: 'Friendly recurring schedule text such as "weekdays at 09:00".',
                },
                frequency: {
                    type: Type.STRING,
                    enum: ['daily', 'weekdays', 'weekly', 'monthly', 'hourly'],
                    description: 'Friendly recurring schedule frequency.',
                },
                time_local: {
                    type: Type.STRING,
                    description: 'Optional HH:MM local time for a friendly recurring schedule.',
                },
                weekday: {
                    type: Type.STRING,
                    enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
                    description: 'Optional weekday for weekly recurring schedules.',
                },
                interval_hours: {
                    type: Type.INTEGER,
                    description: 'Optional hourly interval for recurring schedules.',
                },
                day_of_month: {
                    type: Type.INTEGER,
                    description: 'Optional day of month for monthly recurring schedules.',
                },
                reminder_id: { type: Type.INTEGER, description: 'Reminder ID to cancel.' },
                include_inactive: {
                    type: Type.BOOLEAN,
                    description: 'Whether to include inactive tasks when listing.',
                },
                title: { type: Type.STRING, description: 'Task title.' },
                prompt: { type: Type.STRING, description: 'Task prompt/instruction.' },
                cron_expression: {
                    type: Type.STRING,
                    description: 'Cron expression for recurring task or reminder creation.',
                },
                deadline_at: {
                    type: Type.STRING,
                    description: 'Optional ISO date/time deadline for scheduled task alerts.',
                },
                task_id: { type: Type.STRING, description: 'Task ID for pause/resume/run/cancel.' },
            },
            required: ['operation'],
        },
    },
    {
        name: 'api_tool',
        description: 'Integration and special-tool adapter for pack-local tools and workflow artifact actions.',
        parameters: {
            type: Type.OBJECT,
            properties: {
                operation: {
                    type: Type.STRING,
                    enum: [
                        'list',
                        'run_pack_tool',
                        'list_workflow_templates',
                        'list_recent_workflow_artifacts',
                        'create_workflow_artifact',
                    ],
                    description: 'What integration or special-tool action to perform.',
                },
                tool_id: { type: Type.STRING, description: 'Pack-local tool ID to run.' },
                payload_json: {
                    type: Type.STRING,
                    description: 'Optional JSON object string with arguments for a pack-local tool.',
                },
                artifact_kind: {
                    type: Type.STRING,
                    enum: ['tutor_lesson_note', 'office_followup', 'reporter_brief', 'reporter_draft'],
                    description: 'Workflow artifact template to create.',
                },
                title: { type: Type.STRING, description: 'Artifact title.' },
                summary: { type: Type.STRING, description: 'Artifact summary.' },
                body: { type: Type.STRING, description: 'Artifact body.' },
                bullets: { type: Type.STRING, description: 'Artifact bullet list, one per line.' },
                extra: { type: Type.STRING, description: 'Artifact extra lines, one per line.' },
            },
            required: ['operation'],
        },
    },
];

function toolUnavailable(message: string): string {
    return `[TOOL_RESULT] ${message}`;
}

async function routeTool(
    handlers: HandlerMap,
    toolName: string,
    args: any,
    context: RuntimeExecutionContext | undefined,
    unavailableMessage: string
): Promise<string> {
    const handler = handlers[toolName];
    if (!handler) {
        return toolUnavailable(unavailableMessage);
    }
    return await handler(args, context);
}

function parseOptionalJsonObject(raw?: string): Record<string, unknown> | string {
    if (!raw || raw.trim() === '') return {};

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
            return 'payload_json must decode to a JSON object.';
        }
        return parsed as Record<string, unknown>;
    } catch {
        return 'payload_json must be valid JSON.';
    }
}

async function formatUserInfo(context?: RuntimeExecutionContext, detail: string = 'summary'): Promise<string> {
    if (!context) {
        return '[TOOL_RESULT] user_info requires an active chat context.';
    }

    const { resolveAllowedCapabilities, resolveSpacePolicy } = await import('./policy');
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    const channelRef = resolveChannelRefFromExecutionContext(context) || context.chatId;
    const timeZone = process.env.TZ || 'UTC';
    const now = new Date();
    const dateLabel = now.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone,
    });
    const timeLabel = now.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone,
    });
    const locationLabel =
        LOCATION_LAT !== '0.0000' || LOCATION_LON !== '0.0000' ? `${LOCATION_LAT}, ${LOCATION_LON}` : 'not configured';

    const resident = context.userId ? getResident(context.userId) : undefined;
    const residentName = resident?.nickname || resident?.display_name || resident?.username || context.userId;
    const space = spaceId ? getSpace(spaceId) : undefined;
    const participants = spaceId ? getSpaceParticipants(spaceId) : [];
    const authority = spaceId ? getMemberEffectiveAuthority(spaceId, context.userId) : null;
    const pack = spaceId ? await getAgentForSpace(spaceId) : null;
    const policy = spaceId ? resolveSpacePolicy(spaceId) : null;

    if (detail === 'time') {
        return `[TOOL_RESULT] Local time: ${dateLabel}, ${timeLabel}
Timezone: ${timeZone}
Approximate location: ${locationLabel}`;
    }

    if (detail === 'speaker') {
        return `[TOOL_RESULT] Current speaker: ${residentName}
person_id: ${context.userId}
role: ${resident?.role || 'unknown'}${authority !== null ? `\nauthority: ${authority}` : ''}`;
    }

    if (detail === 'space') {
        return `[TOOL_RESULT] Current space: ${spaceId || 'unknown'}
Channel ref: ${channelRef}
Pack: ${pack?.id || space?.assistant_pack_id || 'unknown'}
Persona: ${pack?.persona_id || 'unknown'}
Title: ${space?.title || 'n/a'}`;
    }

    if (detail === 'participants') {
        if (!spaceId) {
            return '[TOOL_RESULT] No active space context is available.';
        }

        if (participants.length === 0) {
            return `[TOOL_RESULT] No participants are recorded yet for ${spaceId}.`;
        }

        return `[TOOL_RESULT] Participants in ${spaceId}:\n${participants
            .map(
                (participant) =>
                    `- ${participant.nickname || participant.display_name || participant.username || participant.person_id || participant.tg_id} (${participant.membership_role})`
            )
            .join('\n')}`;
    }

    if (detail === 'policies') {
        if (!policy || !spaceId) {
            return '[TOOL_RESULT] No active space policy is available.';
        }
        const allowedCapabilities = resolveAllowedCapabilities(policy);

        return `[TOOL_RESULT] Policies for ${spaceId}
- browser: ${policy.browser}
- tasks: ${policy.tasks}
- memory_sprint_days: ${policy.memory_sprint_days}
- sandbox_enabled: ${policy.sandbox_enabled}
- audit_trail: ${policy.audit_trail}
- allowed_capabilities: ${allowedCapabilities.join(', ')}
- workspace_path: ${policy.workspace_path || 'none'}`;
    }

    return `[TOOL_RESULT] Current user context
Time: ${dateLabel}, ${timeLabel}
Timezone: ${timeZone}
Approximate location: ${locationLabel}
Speaker: ${residentName} (${context.userId})
Role: ${resident?.role || 'unknown'}${authority !== null ? `; authority ${authority}` : ''}
Space: ${spaceId || 'unknown'}
Channel ref: ${channelRef}
Pack: ${pack?.id || space?.assistant_pack_id || 'unknown'}
Participants: ${participants.length}`;
}

async function handleWebTool(
    args: any,
    context: RuntimeExecutionContext | undefined,
    handlers: HandlerMap
): Promise<string> {
    const operation = String(args?.operation || '').trim();

    if (operation === 'search') {
        if (!args?.query?.trim()) return '[TOOL_RESULT] web search requires a non-empty query.';
        return routeTool(
            handlers,
            'web_search',
            { query: args.query.trim() },
            context,
            'Web search is not available in this space.'
        );
    }

    if (operation === 'read_page') {
        if (!args?.url?.trim()) return '[TOOL_RESULT] web read_page requires a URL.';
        return routeTool(
            handlers,
            'browse_web',
            { url: args.url.trim() },
            context,
            'Direct page reading is not available in this space.'
        );
    }

    if (operation === 'deep_research') {
        const task = String(args?.task || args?.query || '').trim();
        if (!task) return '[TOOL_RESULT] deep web research requires a research task.';
        return routeTool(
            handlers,
            'webrun_execute',
            { task },
            context,
            'Deep web research is not available in this space.'
        );
    }

    return '[TOOL_RESULT] Unknown web operation. Use search, read_page, or deep_research.';
}

async function handleFileSearchTool(
    args: any,
    context: RuntimeExecutionContext | undefined,
    handlers: HandlerMap
): Promise<string> {
    const operation = String(args?.operation || '').trim();
    const workspaceUnavailable = 'Workspace file access is not available in this space.';

    if (operation === 'status') {
        return routeTool(handlers, 'workspace_status', {}, context, workspaceUnavailable);
    }
    if (operation === 'list') {
        return routeTool(
            handlers,
            'workspace_list',
            { relative_path: args?.relative_path },
            context,
            workspaceUnavailable
        );
    }
    if (operation === 'read_text') {
        if (!args?.relative_path?.trim()) return '[TOOL_RESULT] file_search read_text requires relative_path.';
        return routeTool(
            handlers,
            'workspace_read_text',
            { relative_path: args.relative_path.trim() },
            context,
            workspaceUnavailable
        );
    }
    if (operation === 'find_files') {
        if (!args?.query?.trim()) return '[TOOL_RESULT] file_search find_files requires query.';
        return routeTool(handlers, 'workspace_find_files', { query: args.query.trim() }, context, workspaceUnavailable);
    }
    if (operation === 'find_text') {
        if (!args?.query?.trim()) return '[TOOL_RESULT] file_search find_text requires query.';
        return routeTool(handlers, 'workspace_find_text', { query: args.query.trim() }, context, workspaceUnavailable);
    }
    if (operation === 'list_artifacts') {
        return routeTool(handlers, 'workspace_list_artifacts', { folder: args?.folder }, context, workspaceUnavailable);
    }
    if (operation === 'save_artifact') {
        if (!args?.title?.trim() || !args?.content?.trim()) {
            return '[TOOL_RESULT] file_search save_artifact requires title and content.';
        }
        return routeTool(
            handlers,
            'workspace_save_artifact',
            { title: args.title.trim(), content: args.content, folder: args?.folder },
            context,
            workspaceUnavailable
        );
    }

    return '[TOOL_RESULT] Unknown file_search operation.';
}

async function handlePersonalContextTool(
    args: any,
    context: RuntimeExecutionContext | undefined,
    handlers: HandlerMap
): Promise<string> {
    const operation = String(args?.operation || '').trim();

    if (operation === 'recall') {
        if (!args?.query?.trim()) return '[TOOL_RESULT] personal_context recall requires query.';
        return routeTool(
            handlers,
            'memory_recall',
            { query: args.query.trim() },
            context,
            'Memory recall is not available in this space.'
        );
    }
    if (operation === 'profile') {
        return routeTool(
            handlers,
            'resident_profile',
            args?.person_id?.trim() ? { person_id: args.person_id.trim() } : {},
            context,
            'Resident profile lookup is not available in this space.'
        );
    }
    if (operation === 'activity') {
        return routeTool(
            handlers,
            'activity_log',
            { type: args?.type || 'all', limit: args?.limit },
            context,
            'Activity log access is not available in this space.'
        );
    }
    if (operation === 'history') {
        if (!args?.query?.trim()) return '[TOOL_RESULT] personal_context history requires query.';
        return routeTool(
            handlers,
            'chat_search',
            { query: args.query.trim(), scope: args?.scope || 'current_space', mode: 'messages', limit: args?.limit },
            context,
            'Chat history search is not available in this space.'
        );
    }
    if (operation === 'recollections') {
        if (!args?.query?.trim()) return '[TOOL_RESULT] personal_context recollections requires query.';
        return routeTool(
            handlers,
            'chat_search',
            {
                query: args.query.trim(),
                scope: args?.scope || 'current_space',
                mode: 'recollections',
                limit: args?.limit,
            },
            context,
            'Recollection search is not available in this space.'
        );
    }
    if (operation === 'space_status') {
        return routeTool(handlers, 'space_status', {}, context, 'Space status is not available in this space.');
    }
    if (operation === 'members') {
        return routeTool(handlers, 'member_list', {}, context, 'Member listing is not available in this space.');
    }

    return '[TOOL_RESULT] Unknown personal_context operation.';
}

async function handleAutomationsTool(
    args: any,
    context: RuntimeExecutionContext | undefined,
    handlers: HandlerMap
): Promise<string> {
    const operation = String(args?.operation || '').trim();

    if (operation === 'add_shopping_item') {
        if (!args?.item?.trim()) {
            return '[TOOL_RESULT] add_shopping_item requires item.';
        }
        return routeTool(
            handlers,
            'shopping_add',
            {
                item: args.item.trim(),
                ...(args?.quantity?.trim() ? { quantity: args.quantity.trim() } : {}),
            },
            context,
            'Shopping list is not available in this space.'
        );
    }
    if (operation === 'list_shopping_items') {
        return routeTool(handlers, 'shopping_list', {}, context, 'Shopping list is not available in this space.');
    }
    if (operation === 'complete_shopping_item') {
        if (typeof args?.item_id !== 'number') {
            return '[TOOL_RESULT] complete_shopping_item requires numeric item_id.';
        }
        return routeTool(
            handlers,
            'shopping_complete',
            { item_id: args.item_id },
            context,
            'Shopping list is not available in this space.'
        );
    }
    if (operation === 'remove_shopping_item') {
        if (typeof args?.item_id !== 'number') {
            return '[TOOL_RESULT] remove_shopping_item requires numeric item_id.';
        }
        return routeTool(
            handlers,
            'shopping_remove',
            { item_id: args.item_id },
            context,
            'Shopping list is not available in this space.'
        );
    }
    if (operation === 'set_reminder') {
        if (!args?.content?.trim()) {
            return '[TOOL_RESULT] set_reminder requires content.';
        }
        if (
            !args?.remind_at?.trim() &&
            !args?.cron_expression?.trim() &&
            !args?.schedule_text?.trim() &&
            !args?.frequency &&
            !args?.time_local?.trim() &&
            typeof args?.interval_hours !== 'number' &&
            typeof args?.day_of_month !== 'number' &&
            !args?.weekday
        ) {
            return '[TOOL_RESULT] set_reminder requires remind_at or a recurring schedule.';
        }
        return routeTool(
            handlers,
            'reminder_set',
            {
                content: args.content.trim(),
                ...(args?.remind_at?.trim() ? { remind_at: args.remind_at.trim() } : {}),
                ...(args?.cron_expression?.trim() ? { cron_expression: args.cron_expression.trim() } : {}),
                ...(args?.schedule_text?.trim() ? { schedule_text: args.schedule_text.trim() } : {}),
                ...(args?.frequency ? { frequency: args.frequency } : {}),
                ...(args?.time_local?.trim() ? { time_local: args.time_local.trim() } : {}),
                ...(args?.weekday ? { weekday: args.weekday } : {}),
                ...(typeof args?.interval_hours === 'number' ? { interval_hours: args.interval_hours } : {}),
                ...(typeof args?.day_of_month === 'number' ? { day_of_month: args.day_of_month } : {}),
            },
            context,
            'Reminders are not available in this space.'
        );
    }
    if (operation === 'list_reminders') {
        return routeTool(
            handlers,
            'reminder_list',
            { all: false },
            context,
            'Reminders are not available in this space.'
        );
    }
    if (operation === 'cancel_reminder') {
        if (typeof args?.reminder_id !== 'number') {
            return '[TOOL_RESULT] cancel_reminder requires numeric reminder_id.';
        }
        return routeTool(
            handlers,
            'reminder_cancel',
            { id: args.reminder_id },
            context,
            'Reminders are not available in this space.'
        );
    }
    if (operation === 'create_task') {
        if (!args?.title?.trim() || !args?.prompt?.trim()) {
            return '[TOOL_RESULT] create_task requires title and prompt.';
        }
        if (
            !args?.cron_expression?.trim() &&
            !args?.schedule_text?.trim() &&
            !args?.frequency &&
            !args?.time_local?.trim() &&
            typeof args?.interval_hours !== 'number' &&
            typeof args?.day_of_month !== 'number' &&
            !args?.weekday
        ) {
            return '[TOOL_RESULT] create_task requires cron_expression or a friendly schedule.';
        }
        return routeTool(
            handlers,
            'task_create',
            {
                title: args.title.trim(),
                prompt: args.prompt.trim(),
                ...(args?.cron_expression?.trim() ? { cron_expression: args.cron_expression.trim() } : {}),
                ...(args?.schedule_text?.trim() ? { schedule_text: args.schedule_text.trim() } : {}),
                ...(args?.frequency ? { frequency: args.frequency } : {}),
                ...(args?.time_local?.trim() ? { time_local: args.time_local.trim() } : {}),
                ...(args?.weekday ? { weekday: args.weekday } : {}),
                ...(typeof args?.interval_hours === 'number' ? { interval_hours: args.interval_hours } : {}),
                ...(typeof args?.day_of_month === 'number' ? { day_of_month: args.day_of_month } : {}),
                ...(args?.deadline_at?.trim() ? { deadline_at: args.deadline_at.trim() } : {}),
            },
            context,
            'Scheduled tasks are not available in this space.'
        );
    }
    if (operation === 'list_tasks') {
        return routeTool(
            handlers,
            'task_list',
            { include_inactive: Boolean(args?.include_inactive) },
            context,
            'Scheduled tasks are not available in this space.'
        );
    }
    if (operation === 'pause_task') {
        if (!args?.task_id?.trim()) return '[TOOL_RESULT] pause_task requires task_id.';
        return routeTool(
            handlers,
            'task_pause',
            { task_id: args.task_id.trim() },
            context,
            'Scheduled tasks are not available in this space.'
        );
    }
    if (operation === 'resume_task') {
        if (!args?.task_id?.trim()) return '[TOOL_RESULT] resume_task requires task_id.';
        return routeTool(
            handlers,
            'task_resume',
            { task_id: args.task_id.trim() },
            context,
            'Scheduled tasks are not available in this space.'
        );
    }
    if (operation === 'run_task') {
        if (!args?.task_id?.trim()) return '[TOOL_RESULT] run_task requires task_id.';
        return routeTool(
            handlers,
            'task_run_now',
            { task_id: args.task_id.trim() },
            context,
            'Scheduled tasks are not available in this space.'
        );
    }
    if (operation === 'cancel_task') {
        if (!args?.task_id?.trim()) return '[TOOL_RESULT] cancel_task requires task_id.';
        return routeTool(
            handlers,
            'task_cancel',
            { task_id: args.task_id.trim() },
            context,
            'Scheduled tasks are not available in this space.'
        );
    }

    return '[TOOL_RESULT] Unknown automations operation.';
}

async function handleApiTool(
    args: any,
    context: RuntimeExecutionContext | undefined,
    handlers: HandlerMap
): Promise<string> {
    const operation = String(args?.operation || '').trim();

    if (!context) {
        return '[TOOL_RESULT] api_tool requires an active chat context.';
    }

    if (operation === 'list') {
        const spaceId = resolveSpaceIdFromExecutionContext(context);
        const pack = spaceId ? await getAgentForSpace(spaceId) : null;
        const packTools = await getRuntimePackTools(context);
        const workflowCreateTools = [
            'tutor_create_lesson_note',
            'office_create_followup',
            'reporter_create_brief',
            'reporter_create_draft',
        ].filter((toolName) => Boolean(handlers[toolName]));

        return `[TOOL_RESULT] Special tools available${pack ? ` for pack "${pack.id}"` : ''}:
Pack tools: ${packTools.length > 0 ? packTools.map((tool) => tool.id).join(', ') : 'none'}
Workflow actions: ${workflowCreateTools.length > 0 ? workflowCreateTools.join(', ') : 'none'}`;
    }

    if (operation === 'run_pack_tool') {
        if (!args?.tool_id?.trim()) return '[TOOL_RESULT] run_pack_tool requires tool_id.';

        const parsedPayload = parseOptionalJsonObject(args?.payload_json);
        if (typeof parsedPayload === 'string') {
            return `[TOOL_RESULT] ${parsedPayload}`;
        }

        return runRuntimePackTool(args.tool_id.trim(), parsedPayload, context);
    }

    if (operation === 'list_workflow_templates') {
        return routeTool(
            handlers,
            'workflow_list_templates',
            {},
            context,
            'Workflow templates are not available in this space.'
        );
    }

    if (operation === 'list_recent_workflow_artifacts') {
        return routeTool(
            handlers,
            'workflow_list_recent_artifacts',
            {},
            context,
            'Workflow artifacts are not available in this space.'
        );
    }

    if (operation === 'create_workflow_artifact') {
        if (!args?.artifact_kind?.trim() || !args?.title?.trim()) {
            return '[TOOL_RESULT] create_workflow_artifact requires artifact_kind and title.';
        }

        const handlerNameByKind: Record<string, string> = {
            tutor_lesson_note: 'tutor_create_lesson_note',
            office_followup: 'office_create_followup',
            reporter_brief: 'reporter_create_brief',
            reporter_draft: 'reporter_create_draft',
        };

        const handlerName = handlerNameByKind[args.artifact_kind.trim()];
        if (!handlerName) {
            return '[TOOL_RESULT] Unknown artifact_kind.';
        }

        return routeTool(
            handlers,
            handlerName,
            {
                title: args.title.trim(),
                summary: args?.summary,
                body: args?.body,
                bullets: args?.bullets,
                extra: args?.extra,
            },
            context,
            `Workflow artifact "${args.artifact_kind}" is not available in this space.`
        );
    }

    return '[TOOL_RESULT] Unknown api_tool operation.';
}

export async function handleCoreToolboxTool(
    callName: string,
    args: any,
    context: RuntimeExecutionContext | undefined,
    handlers: HandlerMap
): Promise<string | null> {
    if (callName === 'web') {
        return handleWebTool(args, context, handlers);
    }
    if (callName === 'file_search') {
        return handleFileSearchTool(args, context, handlers);
    }
    if (callName === 'user_info') {
        return formatUserInfo(context, args?.detail || 'summary');
    }
    if (callName === 'personal_context') {
        return handlePersonalContextTool(args, context, handlers);
    }
    if (callName === 'automations') {
        return handleAutomationsTool(args, context, handlers);
    }
    if (callName === 'api_tool') {
        return handleApiTool(args, context, handlers);
    }

    return null;
}
