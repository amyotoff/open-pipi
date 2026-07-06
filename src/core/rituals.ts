import { getSpace, getTask, Task, upsertTask } from '../db';
import { getSeededTasksForPack, SeededTaskTemplate } from './assistant-pack';
import { resolveSpacePolicy } from './policy';
import {
    buildSeededTaskId,
    ensureDefaultAssistantTasksForSpace,
    parseStoredTaskConfig,
    registerScheduledTasks,
    runAssistantTask,
    StoredTaskConfig,
} from './tasks';
import { appendTimelineEvent } from './timeline';

export const RITUAL_KEYS = ['morning', 'evening', 'weekly'] as const;
export type RitualKey = (typeof RITUAL_KEYS)[number];

export const RITUAL_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type RitualWeekday = (typeof RITUAL_WEEKDAYS)[number];

export type RitualSummary = {
    key: RitualKey;
    title: string;
    description: string;
    frequency: 'daily' | 'weekly';
    template_id: string;
    task_id: string;
    status: string;
    schedule_value: string;
    last_run_at: string | null;
};

type ResolvedRitual = {
    template: SeededTaskTemplate & {
        ritual_key: RitualKey;
        ritual_frequency: 'daily' | 'weekly';
    };
    task: Task;
};

type ParsedSchedule = {
    minute: number;
    hour: number;
    day_of_week: string;
};

const WEEKDAY_TO_CRON: Record<RitualWeekday, string> = {
    mon: '1',
    tue: '2',
    wed: '3',
    thu: '4',
    fri: '5',
    sat: '6',
    sun: '0',
};

const CRON_TO_WEEKDAY: Record<string, RitualWeekday> = {
    '0': 'sun',
    '1': 'mon',
    '2': 'tue',
    '3': 'wed',
    '4': 'thu',
    '5': 'fri',
    '6': 'sat',
    '7': 'sun',
};

function stringifyTaskConfig(config: StoredTaskConfig): string {
    const normalized: Partial<StoredTaskConfig> = { ...config };

    if (!normalized.audit_trail) {
        delete normalized.audit_trail;
    }

    const ritual = normalized.ritual;
    if (!(ritual?.custom_schedule === true || ritual?.custom_status === true)) {
        delete normalized.ritual;
    }

    return JSON.stringify(normalized);
}

function parseSimpleCron(scheduleValue: string): ParsedSchedule | null {
    const parts = scheduleValue.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    if (!Number.isInteger(minute) || !Number.isInteger(hour)) {
        return null;
    }

    return {
        minute,
        hour,
        day_of_week: parts[4],
    };
}

function parseTimeLocal(timeLocal: string): { hour: number; minute: number } | null {
    const match = timeLocal.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return null;
    return {
        hour: Number(match[1]),
        minute: Number(match[2]),
    };
}

function ritualTemplatesForSpace(spaceId: string): Array<
    SeededTaskTemplate & {
        ritual_key: RitualKey;
        ritual_frequency: 'daily' | 'weekly';
    }
> {
    const packId = getSpace(spaceId)?.assistant_pack_id || 'jeeves';

    return getSeededTasksForPack(packId).filter(
        (
            template
        ): template is SeededTaskTemplate & {
            ritual_key: RitualKey;
            ritual_frequency: 'daily' | 'weekly';
        } => Boolean(template.ritual_key && template.ritual_frequency)
    );
}

function resolveRitual(spaceId: string, ritualKey: RitualKey): ResolvedRitual | null {
    ensureDefaultAssistantTasksForSpace(spaceId);

    const template = ritualTemplatesForSpace(spaceId).find((item) => item.ritual_key === ritualKey);
    if (!template) return null;

    const task = getTask(buildSeededTaskId(spaceId, template.template_id));
    if (!task) return null;

    return { template, task };
}

export function listRitualsForSpace(spaceId: string): RitualSummary[] {
    if (!resolveSpacePolicy(spaceId).tasks) {
        return [];
    }

    ensureDefaultAssistantTasksForSpace(spaceId);

    return ritualTemplatesForSpace(spaceId)
        .map((template) => {
            const task = getTask(buildSeededTaskId(spaceId, template.template_id));
            if (!task) return null;

            return {
                key: template.ritual_key,
                title: template.title,
                description: template.ritual_description || '',
                frequency: template.ritual_frequency,
                template_id: template.template_id,
                task_id: task.id,
                status: task.status,
                schedule_value: task.schedule_value,
                last_run_at: task.last_run_at,
            } satisfies RitualSummary;
        })
        .filter((item): item is RitualSummary => Boolean(item));
}

export function describeRitualSchedule(scheduleValue: string, frequency: 'daily' | 'weekly'): string {
    const parsed = parseSimpleCron(scheduleValue);
    if (!parsed) return scheduleValue;

    const time = `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
    if (frequency === 'daily') {
        if (parsed.day_of_week === '1-5') {
            return `weekdays at ${time}`;
        }
        if (parsed.day_of_week === '*') {
            return `daily at ${time}`;
        }
        const weekday = CRON_TO_WEEKDAY[parsed.day_of_week];
        if (weekday) {
            return `recurring on ${weekday} at ${time}`;
        }
        return `daily at ${time}`;
    }

    const weekday = CRON_TO_WEEKDAY[parsed.day_of_week];
    return weekday ? `weekly on ${weekday} at ${time}` : `weekly (${scheduleValue})`;
}

export function configureRitualForSpace(
    spaceId: string,
    ritualKey: RitualKey,
    args: { enabled?: boolean; time_local?: string; weekday?: RitualWeekday }
): RitualSummary {
    const resolved = resolveRitual(spaceId, ritualKey);
    if (!resolved) {
        throw new Error(`Ritual "${ritualKey}" is not available in this space.`);
    }

    if (typeof args.enabled !== 'boolean' && !args.time_local && !args.weekday) {
        throw new Error('No ritual changes were provided.');
    }

    const { template, task } = resolved;
    const config = parseStoredTaskConfig(task.config_json);
    const schedule = parseSimpleCron(task.schedule_value) || parseSimpleCron(template.schedule_value);
    if (!schedule) {
        throw new Error(`Ritual "${template.title}" uses an unsupported schedule format.`);
    }

    let nextSchedule = task.schedule_value;
    let nextStatus = task.status;

    if (args.time_local) {
        const parsedTime = parseTimeLocal(args.time_local);
        if (!parsedTime) {
            throw new Error(`Invalid time "${args.time_local}". Use HH:MM in 24-hour format.`);
        }

        if (template.ritual_frequency === 'daily') {
            nextSchedule = `${parsedTime.minute} ${parsedTime.hour} * * ${schedule.day_of_week}`;
        } else {
            const weekday = args.weekday ? WEEKDAY_TO_CRON[args.weekday] : schedule.day_of_week;
            nextSchedule = `${parsedTime.minute} ${parsedTime.hour} * * ${weekday}`;
        }

        config.ritual = {
            ...(config.ritual || {}),
            custom_schedule: true,
        };
    } else if (args.weekday) {
        if (template.ritual_frequency !== 'weekly') {
            throw new Error(`Ritual "${template.title}" does not accept a weekday override.`);
        }

        nextSchedule = `${schedule.minute} ${schedule.hour} * * ${WEEKDAY_TO_CRON[args.weekday]}`;
        config.ritual = {
            ...(config.ritual || {}),
            custom_schedule: true,
        };
    }

    if (typeof args.enabled === 'boolean') {
        nextStatus = args.enabled ? 'active' : 'paused';
        config.ritual = {
            ...(config.ritual || {}),
            custom_status: true,
        };
    }

    upsertTask({
        ...task,
        schedule_value: nextSchedule,
        status: nextStatus,
        config_json: stringifyTaskConfig(config),
        created_at: task.created_at,
    });
    registerScheduledTasks();

    appendTimelineEvent({
        spaceId,
        type: 'ritual.updated',
        refType: 'task',
        refId: task.id,
        summary: `Updated ritual "${template.title}".`,
        details: {
            ritual_key: ritualKey,
            status: nextStatus,
            schedule: nextSchedule,
        },
    });

    const updated = getTask(task.id);
    if (!updated) {
        throw new Error(`Ritual "${template.title}" could not be updated.`);
    }

    return {
        key: template.ritual_key,
        title: template.title,
        description: template.ritual_description || '',
        frequency: template.ritual_frequency,
        template_id: template.template_id,
        task_id: updated.id,
        status: updated.status,
        schedule_value: updated.schedule_value,
        last_run_at: updated.last_run_at,
    };
}

export async function runRitualForSpace(spaceId: string, ritualKey: RitualKey): Promise<RitualSummary> {
    const resolved = resolveRitual(spaceId, ritualKey);
    if (!resolved) {
        throw new Error(`Ritual "${ritualKey}" is not available in this space.`);
    }

    if (resolved.task.status !== 'active') {
        throw new Error(`Ritual "${resolved.template.title}" is paused. Resume it before running it now.`);
    }

    await runAssistantTask(resolved.task.id);

    const updated = getTask(resolved.task.id) || resolved.task;
    return {
        key: resolved.template.ritual_key,
        title: resolved.template.title,
        description: resolved.template.ritual_description || '',
        frequency: resolved.template.ritual_frequency,
        template_id: resolved.template.template_id,
        task_id: updated.id,
        status: updated.status,
        schedule_value: updated.schedule_value,
        last_run_at: updated.last_run_at,
    };
}
