import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';
import {
    REMINDER_FREQUENCIES,
    REMINDER_WEEKDAYS,
    describeReminderSchedule,
    getNextReminderOccurrence,
    ReminderFrequency,
    ReminderWeekday,
    resolveReminderRecurrence,
} from '../core/reminder-schedule';
import {
    formatDateTimeForSpace,
    parseDateTimeInSpace,
    resolveExecutionSpacePreferences,
} from '../core/space-preferences';
import {
    resolveChannelRefFromExecutionContext,
    resolveSpaceIdFromExecutionContext,
    RuntimeExecutionContext,
} from '../core/runtime-context';

type ReminderSetArgs = {
    content: string;
    remind_at?: string;
    cron_expression?: string;
    schedule_text?: string;
    frequency?: ReminderFrequency;
    time_local?: string;
    weekday?: ReminderWeekday;
    interval_hours?: number;
    day_of_month?: number;
};

function normalizeReminderArgs(
    args: ReminderSetArgs,
    timeZone: string
):
    | { ok: true; remindAt: string; cronExpression: string | null; recurrenceDescription: string | null }
    | { ok: false; message: string } {
    const remindAtRaw = typeof args.remind_at === 'string' ? args.remind_at.trim() : '';
    const hasRecurringSchedule = Boolean(
        args.cron_expression ||
        args.schedule_text ||
        args.frequency ||
        args.time_local ||
        args.weekday ||
        typeof args.interval_hours === 'number' ||
        typeof args.day_of_month === 'number'
    );

    if (!remindAtRaw && !hasRecurringSchedule) {
        return { ok: false, message: '[TOOL_RESULT] reminder_set requires remind_at or a recurring schedule.' };
    }

    let resolvedRecurrence: ReturnType<typeof resolveReminderRecurrence> | null = null;
    if (hasRecurringSchedule) {
        resolvedRecurrence = resolveReminderRecurrence({
            cron_expression: args.cron_expression,
            schedule_text: args.schedule_text,
            frequency: args.frequency,
            time_local: args.time_local,
            weekday: args.weekday,
            interval_hours: args.interval_hours,
            day_of_month: args.day_of_month,
        });
        if (!resolvedRecurrence.ok) {
            return resolvedRecurrence;
        }
    }

    if (remindAtRaw) {
        const parsed = parseDateTimeInSpace(remindAtRaw, timeZone);
        if (!parsed) {
            return {
                ok: false,
                message: `[TOOL_RESULT] Invalid remind_at "${remindAtRaw}". Use an ISO date/time string.`,
            };
        }
        return {
            ok: true,
            remindAt: parsed.toISOString(),
            cronExpression: resolvedRecurrence?.cronExpression || null,
            recurrenceDescription: resolvedRecurrence?.description || null,
        };
    }

    const nextOccurrence = getNextReminderOccurrence(resolvedRecurrence!.cronExpression, timeZone);
    if (!nextOccurrence) {
        return {
            ok: false,
            message: `[TOOL_RESULT] Could not calculate the next run for "${resolvedRecurrence!.description}".`,
        };
    }

    return {
        ok: true,
        remindAt: nextOccurrence,
        cronExpression: resolvedRecurrence!.cronExpression,
        recurrenceDescription: resolvedRecurrence!.description,
    };
}

const skill: SkillManifest = {
    name: 'reminders',
    description: 'Manage personal and household reminders',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office'],
    },
    tools: [
        {
            name: 'reminder_set',
            description:
                'Set a reminder at a specific time, or create a recurring reminder using cron or friendly schedule fields',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    content: { type: Type.STRING, description: 'What to remind about' },
                    remind_at: {
                        type: Type.STRING,
                        description:
                            'Optional ISO date/time string for the first reminder. If omitted, the next cron occurrence is used.',
                    },
                    cron_expression: {
                        type: Type.STRING,
                        description: 'Optional raw cron expression for recurring reminders after the first fire.',
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
                        description:
                            'Optional HH:MM local time for daily, weekday, weekly, or monthly recurring reminders.',
                    },
                    weekday: {
                        type: Type.STRING,
                        enum: [...REMINDER_WEEKDAYS],
                        description: 'Optional weekday for weekly recurring reminders.',
                    },
                    interval_hours: {
                        type: Type.NUMBER,
                        description:
                            'Optional hourly interval for recurring reminders. Supported values: 1, 2, 3, 4, 6, 8, 12.',
                    },
                    day_of_month: {
                        type: Type.NUMBER,
                        description: 'Optional day of month for monthly recurring reminders.',
                    },
                },
                required: ['content'],
            },
        },
        {
            name: 'reminder_list',
            description: 'List all pending reminders for the current space',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    all: {
                        type: Type.BOOLEAN,
                        description: 'Whether to show all reminders or just upcoming (default: false)',
                    },
                },
            },
        },
        {
            name: 'reminder_cancel',
            description: 'Cancel (delete) a reminder by ID in the current space',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.NUMBER, description: 'Reminder ID to cancel' },
                },
                required: ['id'],
            },
        },
    ],
    handlers: {
        async reminder_set(args: ReminderSetArgs, context?: RuntimeExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            const channelRef = resolveChannelRefFromExecutionContext(context);
            if (!spaceId || !channelRef || !context?.userId) return '[TOOL_ERROR] Chat context missing.';
            const preferences = resolveExecutionSpacePreferences(context);

            const normalized = normalizeReminderArgs(args, preferences.timeZone);
            if (!normalized.ok) return normalized.message;

            const db = getDb();
            const res = db
                .prepare(
                    `
                INSERT INTO reminders (
                    space_id, chat_jid, sender_tg_id, content, remind_at, schedule_type, schedule_value, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `
                )
                .run(
                    spaceId,
                    channelRef,
                    context.userId,
                    args.content.trim(),
                    normalized.remindAt,
                    normalized.cronExpression ? 'cron' : null,
                    normalized.cronExpression,
                    new Date().toISOString()
                );

            const recurrenceNote = normalized.recurrenceDescription
                ? ` Repeats: ${normalized.recurrenceDescription}.`
                : '';
            const formattedRemindAt = formatDateTimeForSpace(normalized.remindAt, {
                timeZone: preferences.timeZone,
                locale: preferences.locale,
                includeTimeZone: true,
            });
            return `[TOOL_RESULT] Reminder set (ID: ${res.lastInsertRowid}) for ${formattedRemindAt}.${recurrenceNote}`;
        },

        async reminder_list(args: { all?: boolean }, context?: RuntimeExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!spaceId) return '[TOOL_ERROR] Chat context missing.';
            const preferences = resolveExecutionSpacePreferences(context);
            const db = getDb();
            const now = new Date().toISOString();
            const query = args.all
                ? "SELECT * FROM reminders WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ? ORDER BY remind_at ASC"
                : "SELECT * FROM reminders WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ? AND status = 'pending' AND remind_at > ? ORDER BY remind_at ASC";

            const params = args.all ? [spaceId] : [spaceId, now];
            const rows = db.prepare(query).all(...params) as any[];

            if (rows.length === 0) return '[TOOL_RESULT] No reminders found.';

            const lines = rows.map(
                (r: any) =>
                    `[#${r.id}] ${formatDateTimeForSpace(r.remind_at, {
                        timeZone: preferences.timeZone,
                        locale: preferences.locale,
                        includeTimeZone: true,
                    })} - ${r.content} ` +
                    `(${r.status}; ${describeReminderSchedule(r.schedule_type, r.schedule_value)})`
            );
            return `[TOOL_RESULT] Reminders:\n${lines.join('\n')}`;
        },

        async reminder_cancel(args: { id: number }, context?: RuntimeExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!spaceId) return '[TOOL_ERROR] Chat context missing.';
            const db = getDb();
            const res = db
                .prepare("DELETE FROM reminders WHERE id = ? AND COALESCE(space_id, 'telegram:' || chat_jid) = ?")
                .run(args.id, spaceId);

            if (res.changes === 0) return `[TOOL_RESULT] Reminder #${args.id} not found or not in this chat.`;
            return `[TOOL_RESULT] Reminder #${args.id} cancelled.`;
        },
    },
};

export default skill;
