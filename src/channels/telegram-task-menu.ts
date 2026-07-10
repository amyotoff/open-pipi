import { createHash } from 'node:crypto';
import type { Task } from '../db';
import { describeReminderSchedule } from '../core/reminder-schedule';

export type TelegramTask = Pick<Task, 'id' | 'title' | 'schedule_value' | 'status' | 'last_run_at'>;

export function telegramTaskToken(taskId: string): string {
    return createHash('sha256').update(taskId).digest('base64url').slice(0, 12);
}

export function findTelegramTask(tasks: readonly TelegramTask[], token: string): TelegramTask | undefined {
    return tasks.find((task) => telegramTaskToken(task.id) === token);
}

export function buildTelegramTaskLabel(task: TelegramTask, maxLength = 36): string {
    const prefix = task.status === 'active' ? '• ' : '⏸ ';
    const available = Math.max(1, maxLength - prefix.length);
    const title = task.title.length > available ? `${task.title.slice(0, Math.max(1, available - 1))}…` : task.title;
    return `${prefix}${title}`;
}

export function formatTelegramTaskDetails(task: TelegramTask): string {
    const status = task.status === 'active' ? 'Active' : 'Paused';
    const schedule = describeReminderSchedule('cron', task.schedule_value);
    const lastRun = task.last_run_at ? task.last_run_at.substring(0, 16).replace('T', ' ') : 'Not run yet';

    return [task.title, '', `Schedule: ${schedule}`, `Status: ${status}`, `Last run: ${lastRun}`].join('\n');
}
