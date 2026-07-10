import { describe, expect, it } from 'vitest';
import {
    buildTelegramTaskLabel,
    findTelegramTask,
    formatTelegramTaskDetails,
    telegramTaskToken,
    type TelegramTask,
} from './telegram-task-menu';

const activeTask: TelegramTask = {
    id: 'task:telegram:chat-1:weekly-digest:1783710000000',
    title: 'Weekly digest',
    schedule_value: '0 8 * * 1-5',
    status: 'active',
    last_run_at: null,
};

describe('Telegram task menu', () => {
    it('uses a short stable callback token instead of exposing task IDs', () => {
        const token = telegramTaskToken(activeTask.id);

        expect(token).toHaveLength(12);
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(token).not.toContain('chat-1');
        expect(telegramTaskToken(activeTask.id)).toBe(token);
        expect(findTelegramTask([activeTask], token)).toEqual(activeTask);
        expect(findTelegramTask([activeTask], 'missing')).toBeUndefined();
    });

    it('builds concise labels and readable task details', () => {
        expect(buildTelegramTaskLabel(activeTask)).toBe('• Weekly digest');
        expect(
            buildTelegramTaskLabel(
                { ...activeTask, title: 'A very long task title that must fit Telegram buttons' },
                24
            )
        ).toHaveLength(24);
        expect(formatTelegramTaskDetails(activeTask)).toBe(
            ['Weekly digest', '', 'Schedule: weekdays at 08:00', 'Status: Active', 'Last run: Not run yet'].join('\n')
        );
    });

    it('marks paused tasks and formats their last run', () => {
        const paused = { ...activeTask, status: 'paused', last_run_at: '2026-07-10T08:15:00.000Z' };

        expect(buildTelegramTaskLabel(paused)).toBe('⏸ Weekly digest');
        expect(formatTelegramTaskDetails(paused)).toContain('Status: Paused');
        expect(formatTelegramTaskDetails(paused)).toContain('Last run: 2026-07-10 08:15');
    });
});
