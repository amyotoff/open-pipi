import cron from 'node-cron';

const WEEKDAY_TO_CRON = {
    mon: '1',
    tue: '2',
    wed: '3',
    thu: '4',
    fri: '5',
    sat: '6',
    sun: '0',
} as const;
const CRON_TO_WEEKDAY = {
    '0': 'sun',
    '1': 'mon',
    '2': 'tue',
    '3': 'wed',
    '4': 'thu',
    '5': 'fri',
    '6': 'sat',
    '7': 'sun',
} as const;
const FRIENDLY_HOURLY_INTERVALS = new Set([1, 2, 3, 4, 6, 8, 12]);
const WEEKDAY_ALIASES: Record<string, ReminderWeekday> = {
    mon: 'mon',
    monday: 'mon',
    понедельник: 'mon',
    понедельникам: 'mon',
    tue: 'tue',
    tuesday: 'tue',
    вторник: 'tue',
    вторникам: 'tue',
    wed: 'wed',
    wednesday: 'wed',
    среда: 'wed',
    среду: 'wed',
    средам: 'wed',
    thu: 'thu',
    thursday: 'thu',
    четверг: 'thu',
    четвергам: 'thu',
    fri: 'fri',
    friday: 'fri',
    пятница: 'fri',
    пятницу: 'fri',
    пятницам: 'fri',
    sat: 'sat',
    saturday: 'sat',
    суббота: 'sat',
    субботу: 'sat',
    субботам: 'sat',
    sun: 'sun',
    sunday: 'sun',
    воскресенье: 'sun',
    воскресеньям: 'sun',
};

export const REMINDER_FREQUENCIES = ['daily', 'weekdays', 'weekly', 'monthly', 'hourly'] as const;
export type ReminderFrequency = (typeof REMINDER_FREQUENCIES)[number];

export const REMINDER_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type ReminderWeekday = (typeof REMINDER_WEEKDAYS)[number];

export type ReminderRecurringArgs = {
    cron_expression?: string;
    schedule_text?: string;
    frequency?: ReminderFrequency;
    time_local?: string;
    weekday?: ReminderWeekday;
    interval_hours?: number;
    day_of_month?: number;
};

type ResolvedReminderRecurrence =
    | { ok: true; cronExpression: string; description: string }
    | { ok: false; message: string };

type ParsedFriendlyReminderSchedule = {
    frequency?: ReminderFrequency;
    time_local?: string;
    weekday?: ReminderWeekday;
    interval_hours?: number;
    day_of_month?: number;
};

type ParsedCron = {
    minute: string;
    hour: string;
    dayOfMonth: string;
    month: string;
    dayOfWeek: string;
};

export function validateReminderCron(expression: string): boolean {
    return cron.validate(expression.trim());
}

export function getNextReminderOccurrence(expression: string, timeZone?: string | null): string | null {
    const normalized = expression.trim();
    if (!validateReminderCron(normalized)) return null;

    const scheduled = cron.schedule(
        normalized,
        () => undefined,
        timeZone ? { timezone: timeZone } : process.env.TZ ? { timezone: process.env.TZ } : {}
    );
    try {
        return scheduled.getNextRun()?.toISOString() ?? null;
    } finally {
        scheduled.destroy();
    }
}

export function describeReminderSchedule(scheduleType?: string | null, scheduleValue?: string | null): string {
    if (scheduleType === 'cron' && scheduleValue) {
        const parsed = parseCron(scheduleValue);
        if (parsed) {
            if (
                parsed.minute === '0' &&
                parsed.hour === '*' &&
                parsed.dayOfMonth === '*' &&
                parsed.month === '*' &&
                parsed.dayOfWeek === '*'
            ) {
                return 'every hour';
            }

            const hourlyMatch = parsed.minute === '0' ? parsed.hour.match(/^\*\/(\d{1,2})$/) : null;
            if (hourlyMatch && parsed.dayOfMonth === '*' && parsed.month === '*' && parsed.dayOfWeek === '*') {
                return `every ${hourlyMatch[1]} hours`;
            }

            const formattedTime = formatCronTime(parsed.minute, parsed.hour);
            if (formattedTime) {
                if (parsed.dayOfMonth === '*' && parsed.month === '*' && parsed.dayOfWeek === '*') {
                    return `daily at ${formattedTime}`;
                }
                if (parsed.dayOfMonth === '*' && parsed.month === '*' && parsed.dayOfWeek === '1-5') {
                    return `weekdays at ${formattedTime}`;
                }
                if (parsed.dayOfMonth === '*' && parsed.month === '*' && parsed.dayOfWeek in CRON_TO_WEEKDAY) {
                    return `weekly on ${CRON_TO_WEEKDAY[parsed.dayOfWeek as keyof typeof CRON_TO_WEEKDAY]} at ${formattedTime}`;
                }
                if (/^\d{1,2}$/.test(parsed.dayOfMonth) && parsed.month === '*' && parsed.dayOfWeek === '*') {
                    return `monthly on day ${Number(parsed.dayOfMonth)} at ${formattedTime}`;
                }
            }
        }

        return `repeats ${scheduleValue}`;
    }

    return 'one-off';
}

export function resolveReminderRecurrence(args: ReminderRecurringArgs): ResolvedReminderRecurrence {
    const cronExpression = typeof args.cron_expression === 'string' ? args.cron_expression.trim() : '';
    const scheduleText = typeof args.schedule_text === 'string' ? args.schedule_text.trim() : '';
    const hasStructuredFields = Boolean(
        args.frequency ||
        args.time_local ||
        args.weekday ||
        typeof args.interval_hours === 'number' ||
        typeof args.day_of_month === 'number'
    );

    const sourceCount = [cronExpression ? 1 : 0, scheduleText ? 1 : 0, hasStructuredFields ? 1 : 0].reduce(
        (sum, value) => sum + value,
        0
    );
    if (sourceCount === 0) {
        return {
            ok: false,
            message:
                '[TOOL_RESULT] Recurring reminders require cron_expression, schedule_text, or friendly schedule fields.',
        };
    }
    if (sourceCount > 1) {
        return {
            ok: false,
            message:
                '[TOOL_RESULT] Use only one recurring schedule format: cron_expression, schedule_text, or friendly fields.',
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

    if (scheduleText) {
        const parsed = parseFriendlyScheduleText(scheduleText);
        if (!parsed) {
            return {
                ok: false,
                message:
                    '[TOOL_RESULT] Unsupported schedule_text. Try "weekdays at 09:00", "every monday at 18:30", "every 2 hours", or "every month on day 1 at 10:00".',
            };
        }
        return buildReminderRecurrenceFromFriendlyArgs(parsed);
    }

    return buildReminderRecurrenceFromFriendlyArgs({
        frequency: args.frequency,
        time_local: args.time_local,
        weekday: args.weekday,
        interval_hours: args.interval_hours,
        day_of_month: args.day_of_month,
    });
}

function buildReminderRecurrenceFromFriendlyArgs(args: ParsedFriendlyReminderSchedule): ResolvedReminderRecurrence {
    const frequency = resolveFriendlyFrequency(args);
    if (!frequency) {
        return {
            ok: false,
            message: '[TOOL_RESULT] Friendly recurring schedules require frequency, or enough fields to infer it.',
        };
    }

    if (frequency === 'hourly') {
        if (args.time_local || args.weekday || typeof args.day_of_month === 'number') {
            return { ok: false, message: '[TOOL_RESULT] Hourly reminders only support interval_hours.' };
        }
        const interval = args.interval_hours;
        if (!Number.isInteger(interval) || interval! < 1 || !FRIENDLY_HOURLY_INTERVALS.has(interval!)) {
            return { ok: false, message: '[TOOL_RESULT] interval_hours must be one of 1, 2, 3, 4, 6, 8, or 12.' };
        }
        return {
            ok: true,
            cronExpression: interval === 1 ? '0 * * * *' : `0 */${interval} * * *`,
            description: interval === 1 ? 'every hour' : `every ${interval} hours`,
        };
    }

    const parsedTime = parseTimeLocal(args.time_local || '');
    if (!parsedTime) {
        return { ok: false, message: '[TOOL_RESULT] Friendly recurring schedules require time_local in HH:MM format.' };
    }

    if (frequency === 'daily') {
        if (args.weekday || typeof args.day_of_month === 'number' || typeof args.interval_hours === 'number') {
            return { ok: false, message: '[TOOL_RESULT] Daily reminders only support time_local.' };
        }
        return {
            ok: true,
            cronExpression: `${parsedTime.minute} ${parsedTime.hour} * * *`,
            description: `daily at ${formatTime(parsedTime.hour, parsedTime.minute)}`,
        };
    }

    if (frequency === 'weekdays') {
        if (args.weekday || typeof args.day_of_month === 'number' || typeof args.interval_hours === 'number') {
            return { ok: false, message: '[TOOL_RESULT] Weekday reminders only support time_local.' };
        }
        return {
            ok: true,
            cronExpression: `${parsedTime.minute} ${parsedTime.hour} * * 1-5`,
            description: `weekdays at ${formatTime(parsedTime.hour, parsedTime.minute)}`,
        };
    }

    if (frequency === 'weekly') {
        if (!args.weekday) {
            return { ok: false, message: '[TOOL_RESULT] Weekly reminders require weekday and time_local.' };
        }
        if (typeof args.day_of_month === 'number' || typeof args.interval_hours === 'number') {
            return { ok: false, message: '[TOOL_RESULT] Weekly reminders only support weekday and time_local.' };
        }
        return {
            ok: true,
            cronExpression: `${parsedTime.minute} ${parsedTime.hour} * * ${WEEKDAY_TO_CRON[args.weekday]}`,
            description: `weekly on ${args.weekday} at ${formatTime(parsedTime.hour, parsedTime.minute)}`,
        };
    }

    if (
        typeof args.day_of_month !== 'number' ||
        !Number.isInteger(args.day_of_month) ||
        args.day_of_month < 1 ||
        args.day_of_month > 31
    ) {
        return { ok: false, message: '[TOOL_RESULT] Monthly reminders require day_of_month between 1 and 31.' };
    }
    if (args.weekday || typeof args.interval_hours === 'number') {
        return { ok: false, message: '[TOOL_RESULT] Monthly reminders only support day_of_month and time_local.' };
    }

    return {
        ok: true,
        cronExpression: `${parsedTime.minute} ${parsedTime.hour} ${args.day_of_month} * *`,
        description: `monthly on day ${args.day_of_month} at ${formatTime(parsedTime.hour, parsedTime.minute)}`,
    };
}

function resolveFriendlyFrequency(args: ParsedFriendlyReminderSchedule): ReminderFrequency | null {
    if (args.frequency) return args.frequency;
    if (typeof args.interval_hours === 'number') return 'hourly';
    if (typeof args.day_of_month === 'number') return 'monthly';
    if (args.weekday) return 'weekly';
    if (args.time_local) return 'daily';
    return null;
}

function parseFriendlyScheduleText(scheduleText: string): ParsedFriendlyReminderSchedule | null {
    const normalized = scheduleText.trim().toLowerCase();

    const daily = normalized.match(
        /^(?:every day|daily|each day|каждый день|ежедневно)\s+(?:at|в)\s+(\d{1,2}:\d{2})$/i
    );
    if (daily) {
        return { frequency: 'daily', time_local: daily[1] };
    }

    const weekdays = normalized.match(
        /^(?:weekdays|on weekdays|every weekday|по будням)\s+(?:at|в)\s+(\d{1,2}:\d{2})$/i
    );
    if (weekdays) {
        return { frequency: 'weekdays', time_local: weekdays[1] };
    }

    const monthlyEn = normalized.match(
        /^(?:every month on day|monthly on day)\s+(\d{1,2})\s+(?:at)\s+(\d{1,2}:\d{2})$/i
    );
    if (monthlyEn) {
        return { frequency: 'monthly', day_of_month: Number(monthlyEn[1]), time_local: monthlyEn[2] };
    }

    const monthlyRu = normalized.match(/^(?:каждый месяц|ежемесячно)\s+(\d{1,2})(?:\s*числа)?\s+в\s+(\d{1,2}:\d{2})$/i);
    if (monthlyRu) {
        return { frequency: 'monthly', day_of_month: Number(monthlyRu[1]), time_local: monthlyRu[2] };
    }

    const hourlyEn = normalized.match(/^every\s+(\d{1,2})\s+hours?$/i);
    if (hourlyEn) {
        return { frequency: 'hourly', interval_hours: Number(hourlyEn[1]) };
    }

    const hourlyRu = normalized.match(/^каждые?\s+(\d{1,2})\s+час(?:а|ов)?$/i);
    if (hourlyRu) {
        return { frequency: 'hourly', interval_hours: Number(hourlyRu[1]) };
    }

    if (/^(?:every hour|hourly|каждый час|ежечасно)$/i.test(normalized)) {
        return { frequency: 'hourly', interval_hours: 1 };
    }

    const weekly = normalized.match(/^(?:every\s+|каждый\s+|каждую\s+)?([a-zа-яё]+)\s+(?:at|в)\s+(\d{1,2}:\d{2})$/i);
    if (weekly) {
        const weekday = normalizeWeekdayToken(weekly[1]);
        if (weekday) {
            return { frequency: 'weekly', weekday, time_local: weekly[2] };
        }
    }

    return null;
}

function normalizeWeekdayToken(token: string): ReminderWeekday | null {
    const normalized = token.trim().toLowerCase();
    return WEEKDAY_ALIASES[normalized] || null;
}

function parseTimeLocal(timeLocal: string): { hour: number; minute: number } | null {
    const match = timeLocal.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return null;
    return {
        hour: Number(match[1]),
        minute: Number(match[2]),
    };
}

function parseCron(scheduleValue: string): ParsedCron | null {
    const parts = scheduleValue.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    return {
        minute: parts[0],
        hour: parts[1],
        dayOfMonth: parts[2],
        month: parts[3],
        dayOfWeek: parts[4],
    };
}

function formatCronTime(minute: string, hour: string): string | null {
    if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) {
        return null;
    }
    return formatTime(Number(hour), Number(minute));
}

function formatTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
