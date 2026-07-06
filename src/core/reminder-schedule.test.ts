import { describe, expect, it } from 'vitest';
import { describeReminderSchedule, resolveReminderRecurrence } from './reminder-schedule';

describe('core/reminder-schedule', () => {
    it('builds weekdays cron from friendly fields', () => {
        const result = resolveReminderRecurrence({ frequency: 'weekdays', time_local: '09:00' });
        expect(result).toEqual({
            ok: true,
            cronExpression: '0 9 * * 1-5',
            description: 'weekdays at 09:00',
        });
    });

    it('builds weekly cron from schedule text', () => {
        const result = resolveReminderRecurrence({ schedule_text: 'every monday at 18:30' });
        expect(result).toEqual({
            ok: true,
            cronExpression: '30 18 * * 1',
            description: 'weekly on mon at 18:30',
        });
    });

    it('supports russian schedule text shortcuts', () => {
        const result = resolveReminderRecurrence({ schedule_text: 'по будням в 09:00' });
        expect(result).toEqual({
            ok: true,
            cronExpression: '0 9 * * 1-5',
            description: 'weekdays at 09:00',
        });
    });

    it('supports hourly intervals with guardrails', () => {
        const ok = resolveReminderRecurrence({ frequency: 'hourly', interval_hours: 4 });
        expect(ok).toEqual({
            ok: true,
            cronExpression: '0 */4 * * *',
            description: 'every 4 hours',
        });

        const bad = resolveReminderRecurrence({ frequency: 'hourly', interval_hours: 5 });
        expect(bad.ok).toBe(false);
    });

    it('describes supported cron patterns in friendly language', () => {
        expect(describeReminderSchedule('cron', '0 9 * * 1-5')).toBe('weekdays at 09:00');
        expect(describeReminderSchedule('cron', '30 18 * * 1')).toBe('weekly on mon at 18:30');
        expect(describeReminderSchedule('cron', '0 */2 * * *')).toBe('every 2 hours');
        expect(describeReminderSchedule('cron', '0 10 1 * *')).toBe('monthly on day 1 at 10:00');
    });
});
