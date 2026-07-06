import fs from 'node:fs';
import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getTask, listTasks, memberHasTrustFlag } from '../db';
import { getTaskDeadlineAt } from '../core/tasks';
import {
    REMINDER_FREQUENCIES,
    REMINDER_WEEKDAYS,
    ReminderFrequency,
    ReminderWeekday,
    describeReminderSchedule,
    resolveReminderRecurrence,
    validateReminderCron,
} from '../core/reminder-schedule';
import { resolveSpacePolicy } from '../core/policy';
import {
    resolveChannelRefFromExecutionContext,
    resolveSpaceIdFromExecutionContext,
    RuntimeExecutionContext,
} from '../core/runtime-context';
import { normalizeAuditMode } from '../core/tool-execution';
import { generateTaskBoard, taskBoardFilePath } from '../core/html-artifacts';

type ExecutionContext = Partial<RuntimeExecutionContext>;
type TaskCreateArgs = {
    title: string;
    prompt: string;
    cron_expression?: string;
    schedule_text?: string;
    frequency?: ReminderFrequency;
    time_local?: string;
    weekday?: ReminderWeekday;
    interval_hours?: number;
    day_of_month?: number;
    deadline_at?: string;
    audit_trail?: string;
};

function tryRegenerateTaskBoard(spaceId: string): void {
    try {
        if (fs.existsSync(taskBoardFilePath(spaceId))) {
            generateTaskBoard(spaceId);
        }
    } catch {}
}

function requireTaskAuthority(
    context?: ExecutionContext
): { ok: true; chatId: string; spaceId: string; userId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] Scheduled task management requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    const channelRef = resolveChannelRefFromExecutionContext(context);
    if (!spaceId || !channelRef) {
        return { ok: false, message: '[TOOL_RESULT] Scheduled task management requires an active chat context.' };
    }
    const policy = resolveSpacePolicy(spaceId);
    if (!policy.tasks) {
        return { ok: false, message: '[TOOL_RESULT] Scheduled tasks are disabled in this space.' };
    }

    if (!memberHasTrustFlag(spaceId, context.userId, 'can_assign_tasks')) {
        return {
            ok: false,
            message: '[TOOL_RESULT] You do not have permission to manage scheduled tasks in this space.',
        };
    }

    return { ok: true, chatId: channelRef, spaceId, userId: context.userId };
}

function formatTaskLine(task: {
    config_json: string | null;
    id: string;
    title: string;
    schedule_value: string;
    status: string;
    last_run_at: string | null;
}): string {
    const lastRun = task.last_run_at ? `; last run ${task.last_run_at.substring(0, 16).replace('T', ' ')}` : '';
    const schedule = describeReminderSchedule('cron', task.schedule_value);
    const deadlineAt = getTaskDeadlineAt(task);
    const deadline = deadlineAt
        ? new Date(deadlineAt).getTime() <= Date.now()
            ? `; deadline overdue since ${deadlineAt.substring(0, 16).replace('T', ' ')}`
            : `; deadline ${deadlineAt.substring(0, 16).replace('T', ' ')}`
        : '';
    return `- ${task.id}
  ${task.title}
  schedule: ${schedule}; cron: ${task.schedule_value}; status: ${task.status}${lastRun}${deadline}`;
}

function normalizeTaskSchedule(
    args: TaskCreateArgs
): { ok: true; cronExpression: string; description: string } | { ok: false; message: string } {
    const cronExpression = typeof args.cron_expression === 'string' ? args.cron_expression.trim() : '';
    const hasFriendlySchedule = Boolean(
        args.schedule_text ||
        args.frequency ||
        args.time_local ||
        args.weekday ||
        typeof args.interval_hours === 'number' ||
        typeof args.day_of_month === 'number'
    );

    if (!cronExpression && !hasFriendlySchedule) {
        return { ok: false, message: '[TOOL_RESULT] task_create requires cron_expression or a friendly schedule.' };
    }

    if (cronExpression && hasFriendlySchedule) {
        return {
            ok: false,
            message: '[TOOL_RESULT] Use either cron_expression or a friendly schedule for task_create, not both.',
        };
    }

    if (cronExpression) {
        if (!validateReminderCron(cronExpression)) {
            return { ok: false, message: `[TOOL_RESULT] Invalid cron expression "${cronExpression}".` };
        }
        return {
            ok: true,
            cronExpression,
            description: describeReminderSchedule('cron', cronExpression),
        };
    }

    const resolved = resolveReminderRecurrence({
        schedule_text: args.schedule_text,
        frequency: args.frequency,
        time_local: args.time_local,
        weekday: args.weekday,
        interval_hours: args.interval_hours,
        day_of_month: args.day_of_month,
    });
    if (!resolved.ok) {
        return {
            ok: false,
            message: resolved.message
                .replace(/Recurring reminders/g, 'Recurring tasks')
                .replace(/Friendly recurring schedules/g, 'Friendly task schedules')
                .replace(/Hourly reminders/g, 'Hourly tasks')
                .replace(/Daily reminders/g, 'Daily tasks')
                .replace(/Weekday reminders/g, 'Weekday tasks')
                .replace(/Weekly reminders/g, 'Weekly tasks')
                .replace(/Monthly reminders/g, 'Monthly tasks'),
        };
    }

    return resolved;
}

const skill: SkillManifest = {
    name: 'tasks',
    description: 'Manage scheduled assistant tasks for the current space',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'policy',
        policy_gate: 'tasks',
        required_trust_flag: 'can_assign_tasks',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'task_create',
            description:
                'Create a scheduled assistant task for the current space using cron or a friendly recurring schedule.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    title: { type: Type.STRING, description: 'Short human-readable task title.' },
                    prompt: {
                        type: Type.STRING,
                        description: 'Instruction that should be sent to the assistant when the task runs.',
                    },
                    cron_expression: {
                        type: Type.STRING,
                        description: 'Optional cron expression such as "0 9 * * *".',
                    },
                    schedule_text: {
                        type: Type.STRING,
                        description:
                            'Optional friendly recurring schedule like "weekdays at 09:00" or "every monday at 18:30".',
                    },
                    frequency: {
                        type: Type.STRING,
                        enum: [...REMINDER_FREQUENCIES],
                        description: 'Optional friendly recurrence preset.',
                    },
                    time_local: {
                        type: Type.STRING,
                        description: 'Optional HH:MM local time for daily, weekday, weekly, or monthly tasks.',
                    },
                    weekday: {
                        type: Type.STRING,
                        enum: [...REMINDER_WEEKDAYS],
                        description: 'Optional weekday for weekly tasks.',
                    },
                    interval_hours: {
                        type: Type.NUMBER,
                        description:
                            'Optional hourly interval for recurring tasks. Supported values: 1, 2, 3, 4, 6, 8, 12.',
                    },
                    day_of_month: {
                        type: Type.NUMBER,
                        description: 'Optional day of month for monthly recurring tasks.',
                    },
                    deadline_at: {
                        type: Type.STRING,
                        description: 'Optional ISO date/time deadline for checking and alerts.',
                    },
                    audit_trail: {
                        type: Type.STRING,
                        enum: ['off', 'errors', 'all'],
                        description: 'Optional audit mode override for runs of this task.',
                    },
                },
                required: ['title', 'prompt'],
            },
        },
        {
            name: 'task_list',
            description: 'List scheduled assistant tasks for the current space.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    include_inactive: { type: Type.BOOLEAN, description: 'Whether to include paused tasks.' },
                },
            },
        },
        {
            name: 'task_pause',
            description: 'Pause a scheduled assistant task by task ID.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.STRING, description: 'Task ID to pause.' },
                },
                required: ['task_id'],
            },
        },
        {
            name: 'task_run_now',
            description: 'Run an active scheduled assistant task immediately by task ID.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.STRING, description: 'Task ID to run immediately.' },
                },
                required: ['task_id'],
            },
        },
        {
            name: 'task_resume',
            description: 'Resume a paused scheduled assistant task by task ID.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.STRING, description: 'Task ID to resume.' },
                },
                required: ['task_id'],
            },
        },
        {
            name: 'task_cancel',
            description: 'Delete a scheduled assistant task by task ID.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.STRING, description: 'Task ID to delete.' },
                },
                required: ['task_id'],
            },
        },
    ],
    handlers: {
        async task_create(args: TaskCreateArgs, context?: ExecutionContext) {
            const access = requireTaskAuthority(context);
            if (!access.ok) return access.message;

            const schedule = normalizeTaskSchedule(args);
            if (!schedule.ok) return schedule.message;

            const deadlineAt = typeof args.deadline_at === 'string' ? args.deadline_at.trim() : '';
            let normalizedDeadlineAt: string | undefined;
            if (deadlineAt) {
                const parsed = new Date(deadlineAt);
                if (Number.isNaN(parsed.getTime())) {
                    return `[TOOL_RESULT] Invalid deadline_at "${deadlineAt}". Use an ISO date/time string.`;
                }
                normalizedDeadlineAt = parsed.toISOString();
            }

            const { createAssistantTask } = await import('../core/tasks');
            const task = createAssistantTask(
                access.chatId,
                args.title.trim(),
                args.prompt.trim(),
                schedule.cronExpression,
                access.userId,
                {
                    ...(args.audit_trail ? { audit_trail: normalizeAuditMode(args.audit_trail) } : {}),
                    ...(normalizedDeadlineAt ? { deadline_at: normalizedDeadlineAt } : {}),
                }
            );

            tryRegenerateTaskBoard(access.spaceId);

            return [
                '[TOOL_RESULT] Scheduled task created.',
                `ID: ${task.id}`,
                `Title: ${task.title}`,
                `Schedule: ${schedule.description}`,
                `Cron: ${task.schedule_value}`,
                ...(normalizedDeadlineAt ? [`Deadline: ${normalizedDeadlineAt}`] : []),
                `Audit trail: ${args.audit_trail ? normalizeAuditMode(args.audit_trail) : 'space default'}`,
            ].join('\n');
        },

        async task_list(args: { include_inactive?: boolean }, context?: ExecutionContext) {
            const access = requireTaskAuthority(context);
            if (!access.ok) return access.message;

            const tasks = args.include_inactive ? listTasks(access.spaceId) : listTasks(access.spaceId, 'active');

            if (tasks.length === 0) {
                return '[TOOL_RESULT] No scheduled assistant tasks found for this space.';
            }

            return `[TOOL_RESULT] Scheduled tasks for ${access.spaceId}:\n${tasks.map(formatTaskLine).join('\n')}`;
        },

        async task_pause(args: { task_id: string }, context?: ExecutionContext) {
            const access = requireTaskAuthority(context);
            if (!access.ok) return access.message;

            const task = getTask(args.task_id);
            if (!task || task.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Task "${args.task_id}" was not found in this space.`;
            }

            const { pauseAssistantTask } = await import('../core/tasks');
            const updated = pauseAssistantTask(args.task_id);
            tryRegenerateTaskBoard(access.spaceId);
            return updated
                ? `[TOOL_RESULT] Task "${updated.title}" is now paused.`
                : `[TOOL_RESULT] Task "${args.task_id}" could not be paused.`;
        },

        async task_run_now(args: { task_id: string }, context?: ExecutionContext) {
            const access = requireTaskAuthority(context);
            if (!access.ok) return access.message;

            const task = getTask(args.task_id);
            if (!task || task.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Task "${args.task_id}" was not found in this space.`;
            }

            if (task.status !== 'active') {
                return `[TOOL_RESULT] Task "${task.title}" is not active. Resume it before running it now.`;
            }

            const { runAssistantTask } = await import('../core/tasks');
            await runAssistantTask(args.task_id);
            return `[TOOL_RESULT] Task "${task.title}" ran successfully.`;
        },

        async task_resume(args: { task_id: string }, context?: ExecutionContext) {
            const access = requireTaskAuthority(context);
            if (!access.ok) return access.message;

            const task = getTask(args.task_id);
            if (!task || task.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Task "${args.task_id}" was not found in this space.`;
            }

            const { resumeAssistantTask } = await import('../core/tasks');
            const updated = resumeAssistantTask(args.task_id);
            tryRegenerateTaskBoard(access.spaceId);
            return updated
                ? `[TOOL_RESULT] Task "${updated.title}" is now active again.`
                : `[TOOL_RESULT] Task "${args.task_id}" could not be resumed.`;
        },

        async task_cancel(args: { task_id: string }, context?: ExecutionContext) {
            const access = requireTaskAuthority(context);
            if (!access.ok) return access.message;

            const task = getTask(args.task_id);
            if (!task || task.space_id !== access.spaceId) {
                return `[TOOL_RESULT] Task "${args.task_id}" was not found in this space.`;
            }

            const { cancelAssistantTask } = await import('../core/tasks');
            const cancelled = cancelAssistantTask(args.task_id);
            tryRegenerateTaskBoard(access.spaceId);
            return cancelled
                ? `[TOOL_RESULT] Task "${task.title}" was deleted.`
                : `[TOOL_RESULT] Task "${args.task_id}" could not be deleted.`;
        },
    },
    init: async () => {
        const { registerScheduledTasks } = await import('../core/tasks');
        registerScheduledTasks();
    },
};

export default skill;
