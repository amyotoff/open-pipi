import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, makeDbModuleMock } from '../test-helpers/mock-db';

let db: Database.Database;

async function loadModule() {
    vi.resetModules();
    const sendMessageToChat = vi.fn(async () => undefined);
    const logEvent = vi.fn();

    vi.doMock('../db', () => ({
        ...makeDbModuleMock(db),
        logEvent,
    }));
    vi.doMock('../channels/telegram', () => ({ sendMessageToChat }));

    const mod = await import('./reminders');
    return { ...mod, sendMessageToChat, logEvent };
}

beforeEach(() => {
    db = createTestDb();
});

afterEach(() => {
    db.close();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('agents/reminders', () => {
    it('fires due reminders and marks them as done', async () => {
        db.prepare(
            `
            INSERT INTO reminders (chat_jid, sender_tg_id, content, remind_at, created_at)
            VALUES (?, ?, ?, ?, ?)
        `
        ).run('chat-1', '111', 'Take medicine', new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());

        const mod = await loadModule();
        await mod.checkReminders();

        const row = db.prepare('SELECT status FROM reminders WHERE id = 1').get() as any;
        expect(mod.sendMessageToChat).toHaveBeenCalledWith('chat-1', expect.stringContaining('Take medicine'));
        expect(row.status).toBe('done');
        expect(mod.logEvent).toHaveBeenCalledWith('reminder_fired', expect.any(Object));
    });

    it('localizes reminder text by pack/language and avoids markdown formatting', async () => {
        const now = new Date().toISOString();
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Ops Room',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            'jeeves_personal',
            JSON.stringify({ default_language: 'en' }),
            now,
            now
        );
        db.prepare(
            `
            INSERT INTO reminders (space_id, chat_jid, sender_tg_id, content, remind_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'chat-1',
            '111',
            'Prepare standup notes',
            new Date(Date.now() - 60_000).toISOString(),
            now
        );

        const mod = await loadModule();
        await mod.checkReminders();

        expect(mod.sendMessageToChat).toHaveBeenCalledWith('chat-1', expect.stringContaining('Prepare standup notes'));
    });

    it('reschedules recurring reminders after they fire', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-30T09:05:00.000Z'));

        try {
            db.prepare(
                `
                INSERT INTO reminders (chat_jid, sender_tg_id, content, remind_at, schedule_type, schedule_value, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'chat-1',
                '111',
                'Daily stretch',
                '2026-03-30T09:00:00.000Z',
                'cron',
                '0 9 * * *',
                new Date().toISOString()
            );

            const mod = await loadModule();
            await mod.checkReminders();

            const row = db.prepare('SELECT status, remind_at, schedule_value FROM reminders WHERE id = 1').get() as any;
            expect(mod.sendMessageToChat).toHaveBeenCalledWith('chat-1', expect.stringContaining('Daily stretch'));
            expect(row.status).toBe('pending');
            expect(row.schedule_value).toBe('0 9 * * *');
            expect(new Date(row.remind_at).getTime()).toBeGreaterThan(Date.now());
            expect(mod.logEvent).toHaveBeenCalledWith('reminder_rescheduled', expect.objectContaining({ id: 1 }));
            expect(mod.logEvent).toHaveBeenCalledWith('reminder_fired', expect.any(Object));
        } finally {
            vi.useRealTimers();
        }
    });

    it('reschedules recurring reminders in the space timezone', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-30T13:05:00.000Z'));

        try {
            const now = new Date().toISOString();
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-nyc',
                'group_chat',
                'NYC Team',
                'telegram',
                'chat-nyc',
                'ACTIVE',
                'jeeves',
                'jeeves_personal',
                JSON.stringify({ timezone: 'America/New_York', default_language: 'en' }),
                now,
                now
            );
            db.prepare(
                `
                INSERT INTO reminders (space_id, chat_jid, sender_tg_id, content, remind_at, schedule_type, schedule_value, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-nyc',
                'chat-nyc',
                '111',
                'Daily stretch',
                '2026-03-30T13:00:00.000Z',
                'cron',
                '0 9 * * *',
                now
            );

            const mod = await loadModule();
            await mod.checkReminders();

            const row = db.prepare('SELECT status, remind_at FROM reminders WHERE id = 1').get() as any;
            expect(mod.sendMessageToChat).toHaveBeenCalledWith(
                'chat-nyc',
                expect.stringContaining('Reminder: Daily stretch')
            );
            expect(row.status).toBe('pending');
            expect(row.remind_at).toBe('2026-03-31T13:00:00.000Z');
        } finally {
            vi.useRealTimers();
        }
    });

    it('does nothing when no reminders are due', async () => {
        const mod = await loadModule();
        await mod.checkReminders();

        expect(mod.sendMessageToChat).not.toHaveBeenCalled();
    });

    it('claims reminders before delivery so overlapping checks do not send twice', async () => {
        let releaseSend: (() => void) | undefined;
        const blockedSend = new Promise<undefined>((resolve) => {
            releaseSend = () => resolve(undefined);
        });
        const mod = await loadModule();
        mod.sendMessageToChat.mockImplementationOnce(async () => blockedSend);
        db.prepare(
            `
            INSERT INTO reminders (chat_jid, sender_tg_id, content, remind_at, created_at)
            VALUES (?, ?, ?, ?, ?)
        `
        ).run('chat-1', '111', 'Only once', new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());

        const first = mod.checkReminders();
        await vi.waitFor(() => {
            expect((db.prepare('SELECT status FROM reminders WHERE id = 1').get() as any).status).toBe('processing');
        });
        await mod.checkReminders();
        releaseSend?.();
        await first;

        expect(mod.sendMessageToChat).toHaveBeenCalledTimes(1);
        expect((db.prepare('SELECT status FROM reminders WHERE id = 1').get() as any).status).toBe('done');
    });

    it('releases a failed reminder claim for retry', async () => {
        const mod = await loadModule();
        mod.sendMessageToChat.mockRejectedValueOnce(new Error('network down'));
        db.prepare(
            `
            INSERT INTO reminders (chat_jid, sender_tg_id, content, remind_at, created_at)
            VALUES (?, ?, ?, ?, ?)
        `
        ).run('chat-1', '111', 'Retry me', new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());

        await mod.checkReminders();

        expect((db.prepare('SELECT status FROM reminders WHERE id = 1').get() as any).status).toBe('pending');
        expect(mod.logEvent).toHaveBeenCalledWith('reminder_delivery_failed', expect.objectContaining({ id: 1 }));
    });

    it('suppresses reminder delivery when the space channel mode is off', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-off',
            'group_chat',
            'Quiet Space',
            'telegram',
            'chat-off',
            'ACTIVE',
            'jeeves',
            'jeeves_personal',
            JSON.stringify({ channel_mode: 'off' }),
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO reminders (space_id, chat_jid, sender_tg_id, content, remind_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-off',
            'chat-off',
            '111',
            'Quiet reminder',
            new Date(Date.now() - 60_000).toISOString(),
            new Date().toISOString()
        );

        const mod = await loadModule();
        await mod.checkReminders();

        const row = db.prepare('SELECT status FROM reminders WHERE id = 1').get() as any;
        expect(mod.sendMessageToChat).not.toHaveBeenCalled();
        expect(row.status).toBe('done');
        expect(mod.logEvent).toHaveBeenCalledWith(
            'reminder_fired',
            expect.objectContaining({ space_id: 'telegram:chat-off' })
        );
    });
});
