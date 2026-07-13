import { getDb, logEvent } from '../db';
import { sendChannelMessage, sendSpaceMessage } from '../channels/runtime';
import { getNextReminderOccurrence } from '../core/reminder-schedule';
import { resolveReminderSpaceId, resolveSpacePreferences } from '../core/space-preferences';

type ReminderRow = {
    id: number;
    space_id: string | null;
    chat_jid: string;
    content: string;
    remind_at: string;
    schedule_type: string | null;
    schedule_value: string | null;
};

let interruptedClaimsRecovered = false;

function recoverInterruptedReminderClaims(db: ReturnType<typeof getDb>): void {
    if (interruptedClaimsRecovered) return;
    db.prepare("UPDATE reminders SET status = 'pending' WHERE status = 'processing'").run();
    interruptedClaimsRecovered = true;
}

function claimDueReminders(db: ReturnType<typeof getDb>, now: string): ReminderRow[] {
    return db.transaction(() => {
        const due = db
            .prepare(
                `
                SELECT * FROM reminders
                WHERE status = 'pending' AND remind_at <= ?
                ORDER BY remind_at ASC
            `
            )
            .all(now) as ReminderRow[];
        const claimed: ReminderRow[] = [];
        const claim = db.prepare("UPDATE reminders SET status = 'processing' WHERE id = ? AND status = 'pending'");

        for (const reminder of due) {
            if (claim.run(reminder.id).changes === 1) {
                claimed.push(reminder);
            }
        }

        return claimed;
    })();
}

function reminderLabel(language: string, assistantPackId: string | null): string {
    const isRussian = language.startsWith('ru');

    if (assistantPackId === 'office') {
        return isRussian ? 'Командное напоминание' : 'Team reminder';
    }
    if (assistantPackId === 'tutor') {
        return isRussian ? 'Напоминание по учебе' : 'Study reminder';
    }
    return isRussian ? 'Напоминание' : 'Reminder';
}

function truncateReminderSubject(value: string, maxLength: number = 78): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildReminderNotification(
    reminder: Pick<ReminderRow, 'content'>,
    options: { language: string; assistantPackId: string | null; channel: string | null }
): { text: string; subject?: string } {
    const label = reminderLabel(options.language, options.assistantPackId);
    const text = `${label}: ${reminder.content}`;

    if (options.channel === 'gmail') {
        return {
            text,
            subject: truncateReminderSubject(text),
        };
    }

    return { text };
}

/**
 * Checks for pending reminders that are due and notifies the user.
 * One-off reminders are marked done; recurring reminders are rescheduled.
 */
export async function checkReminders(): Promise<void> {
    const db = getDb();
    // A fresh process owns no in-flight deliveries, so claims left by a prior
    // process are safe to retry. This runs once and stays out of overlapping checks.
    recoverInterruptedReminderClaims(db);
    const now = new Date().toISOString();

    const dueReminders = claimDueReminders(db, now);

    if (dueReminders.length === 0) return;

    console.log(`[REMINDERS] Firing ${dueReminders.length} reminders.`);

    for (const r of dueReminders) {
        try {
            const resolvedSpaceId = resolveReminderSpaceId({ spaceId: r.space_id, channelRef: r.chat_jid });
            const preferences = resolveSpacePreferences(resolvedSpaceId);
            const notification = buildReminderNotification(r, preferences);

            if (resolvedSpaceId) {
                await sendSpaceMessage(
                    resolvedSpaceId,
                    notification.text,
                    notification.subject ? { subject: notification.subject } : undefined
                );
            } else {
                await sendChannelMessage(
                    'telegram',
                    r.chat_jid,
                    notification.text,
                    notification.subject ? { subject: notification.subject } : undefined
                );
            }

            if (r.schedule_type === 'cron' && r.schedule_value) {
                const nextRemindAt = getNextReminderOccurrence(r.schedule_value, preferences.timeZone);
                if (nextRemindAt) {
                    db.prepare(
                        `
                        UPDATE reminders
                        SET remind_at = ?, status = 'pending'
                        WHERE id = ?
                    `
                    ).run(nextRemindAt, r.id);
                    logEvent('reminder_rescheduled', {
                        id: r.id,
                        space_id: resolvedSpaceId,
                        channel_ref: r.chat_jid,
                        schedule_value: r.schedule_value,
                        next_remind_at: nextRemindAt,
                    });
                } else {
                    db.prepare("UPDATE reminders SET status = 'done' WHERE id = ?").run(r.id);
                    logEvent('reminder_recurrence_invalid', {
                        id: r.id,
                        space_id: resolvedSpaceId,
                        channel_ref: r.chat_jid,
                        schedule_value: r.schedule_value,
                    });
                }
            } else {
                db.prepare("UPDATE reminders SET status = 'done' WHERE id = ?").run(r.id);
            }
            logEvent('reminder_fired', { id: r.id, space_id: resolvedSpaceId, channel_ref: r.chat_jid });
        } catch (err) {
            console.error(`[REMINDERS] Failed to send reminder #${r.id}:`, err);
            db.prepare("UPDATE reminders SET status = 'pending' WHERE id = ? AND status = 'processing'").run(r.id);
            logEvent('reminder_delivery_failed', { id: r.id, space_id: r.space_id, channel_ref: r.chat_jid });
        }
    }
}
