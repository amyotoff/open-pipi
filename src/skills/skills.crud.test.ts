import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeChannelRuntimeMock } from '../test-helpers/channel-runtime-mock';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDb, makeDbModuleMock, seedResident } from '../test-helpers/mock-db';

let db: Database.Database;
const ORIGINAL_ENV = { ...process.env };

async function loadSkill<T>(modulePath: string, extraMocks?: () => void): Promise<T> {
    vi.resetModules();
    vi.doMock('../db', () => makeDbModuleMock(db));
    extraMocks?.();
    return (await import(modulePath)) as T;
}

beforeEach(() => {
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-skills-crud-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    db = createTestDb();
    seedResident(db, { tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
    seedResident(db, { tg_id: '222', username: 'bob', display_name: 'Bob', role: 'owner', habits: 'likes pasta' });
});

afterEach(() => {
    db.close();
    vi.doUnmock('../core/tasks');
    vi.doUnmock('../config');
    vi.doUnmock('../agents/butler');
    vi.doUnmock('../channels/telegram');
    vi.doUnmock('../core/ollama');
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    vi.clearAllMocks();
});

describe('CRUD skills', () => {
    it('shopping skill supports add/list/complete/remove with space context', async () => {
        const { default: skill } = await loadSkill<any>('./shopping.skill');
        const homeContext = { chatId: 'chat-1', userId: '111' };
        const officeContext = { chatId: 'chat-2', userId: '111' };

        expect(await skill.handlers.shopping_add({ item: 'Milk', quantity: '2 bottles' }, homeContext)).toContain(
            'Milk'
        );
        expect(await skill.handlers.shopping_add({ item: 'Paper towels' }, officeContext)).toContain('Paper towels');

        const list = await skill.handlers.shopping_list({}, homeContext);
        expect(list).toContain('Milk (2 bottles)');
        expect(list).not.toContain('Paper towels');

        const row = db
            .prepare('SELECT space_id, item, quantity, purchased FROM shopping_list WHERE id = 1')
            .get() as any;
        expect(row.space_id).toBe('telegram:chat-1');
        expect(row.item).toBe('Milk');
        expect(row.quantity).toBe('2 bottles');
        expect(row.purchased).toBe(0);

        expect(await skill.handlers.shopping_complete({ item_id: 2 }, homeContext)).toContain('not found in this chat');
        expect(await skill.handlers.shopping_complete({ item_id: 1 }, homeContext)).toContain(
            'Marked shopping item #1 as bought'
        );
        expect(await skill.handlers.shopping_remove({ item_id: 1 }, homeContext)).toContain('Removed shopping item #1');
    });

    it('todos skill supports add/list/complete/remove', async () => {
        const { default: skill } = await loadSkill<any>('./todos.skill');
        const teamContext = { chatId: 'chat-1', userId: '111' };
        const sideContext = { chatId: 'chat-2', userId: '111' };

        expect(await skill.handlers.todos_add({ task: 'Call the clinic' }, teamContext)).toContain('Call the clinic');
        expect(await skill.handlers.todos_add({ task: 'Buy stamps' }, sideContext)).toContain('Buy stamps');

        const list = await skill.handlers.todos_list({}, teamContext);
        expect(list).toContain('Call the clinic');
        expect(list).not.toContain('Buy stamps');

        expect(await skill.handlers.todos_complete({ task_id: 2 }, teamContext)).toContain('not found in this chat');
        expect(await skill.handlers.todos_complete({ task_id: 1 }, teamContext)).toContain('Completed task #1');
        expect(await skill.handlers.todos_remove({ task_id: 1 }, teamContext)).toContain('Removed task #1');
    });

    it('reminders skill supports set/list/cancel with chat context', async () => {
        const { default: skill } = await loadSkill<any>('./reminders.skill');
        const context = { chatId: 'chat-1', userId: '111' };
        const remindAt = new Date(Date.now() + 3600_000).toISOString();

        expect(await skill.handlers.reminder_set({ content: 'Pay rent', remind_at: remindAt }, context)).toContain(
            'Reminder set'
        );
        expect(
            await skill.handlers.reminder_set(
                { content: 'Water plants', frequency: 'weekdays', time_local: '09:00' },
                context
            )
        ).toContain('Repeats: weekdays at 09:00');
        expect(
            await skill.handlers.reminder_set(
                { content: 'Review budget', schedule_text: 'every month on day 1 at 10:00' },
                context
            )
        ).toContain('monthly on day 1 at 10:00');
        const list = await skill.handlers.reminder_list({}, context);
        expect(list).toContain('Pay rent');
        expect(list).toContain('Water plants');
        expect(list).toContain('weekdays at 09:00');
        expect(list).toContain('Review budget');
        expect(list).toContain('monthly on day 1 at 10:00');

        const recurring = db
            .prepare('SELECT schedule_type, schedule_value, remind_at FROM reminders WHERE id = 2')
            .get() as any;
        expect(recurring.schedule_type).toBe('cron');
        expect(recurring.schedule_value).toBe('0 9 * * 1-5');
        expect(Number.isNaN(new Date(recurring.remind_at).getTime())).toBe(false);

        const monthly = db.prepare('SELECT schedule_value FROM reminders WHERE id = 3').get() as any;
        expect(monthly.schedule_value).toBe('0 10 1 * *');

        expect(await skill.handlers.reminder_cancel({ id: 1 }, context)).toContain('cancelled');
    });

    it('uses space timezone for local reminder inputs and outputs', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-30T12:05:00.000Z'));

        try {
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-tz',
                'group_chat',
                'NYC Team',
                'telegram',
                'chat-tz',
                'ACTIVE',
                'office',
                'jeeves_personal',
                JSON.stringify({ timezone: 'America/New_York', default_language: 'en' }),
                new Date().toISOString(),
                new Date().toISOString()
            );

            const { default: skill } = await loadSkill<any>('./reminders.skill');
            const context = { chatId: 'chat-tz', userId: '111' };

            const oneOff = await skill.handlers.reminder_set(
                { content: 'Call Alice', remind_at: '2026-03-30T09:15' },
                context
            );
            expect(oneOff).toContain('America/New_York');

            const oneOffRow = db.prepare('SELECT remind_at FROM reminders WHERE id = 1').get() as any;
            expect(oneOffRow.remind_at).toBe('2026-03-30T13:15:00.000Z');

            const recurring = await skill.handlers.reminder_set(
                { content: 'Standup', frequency: 'daily', time_local: '09:00' },
                context
            );
            expect(recurring).toContain('America/New_York');

            const recurringRow = db
                .prepare('SELECT remind_at, schedule_value FROM reminders WHERE id = 2')
                .get() as any;
            expect(recurringRow.schedule_value).toBe('0 9 * * *');
            expect(recurringRow.remind_at).toBe('2026-03-30T13:00:00.000Z');

            const list = await skill.handlers.reminder_list({}, context);
            expect(list).toContain('America/New_York');
            expect(list).toContain('Call Alice');
            expect(list).toContain('Standup');
        } finally {
            vi.useRealTimers();
        }
    });

    it('memory skill supports remember/recall/profile/diary/insights', async () => {
        const { default: skill, getMemoryContext } = await loadSkill<any>('./memory.skill');
        const context = { chatId: 'chat-1', userId: '111' };

        expect(
            await skill.handlers.memory_remember(
                {
                    resident_name: 'Alice',
                    fact: 'prefers tea in the morning',
                    category: 'preference',
                },
                context
            )
        ).toContain('Remembered');

        expect(await skill.handlers.memory_recall({ query: 'Alice' })).toContain('prefers tea');
        expect(await skill.handlers.resident_set_name({ tg_id: '111', nickname: 'Al' })).toContain('Al');
        expect(await skill.handlers.resident_learn_habit({ tg_id: '222', habit: 'avoids late dinners' })).toContain(
            'Stored this preference'
        );

        const profile = await skill.handlers.resident_profile({ tg_id: '222' });
        expect(profile).toContain('avoids late dinners');

        expect(await skill.handlers.diary_write({ entry: 'A productive day.' }, context)).toContain(
            'Saved a diary entry'
        );
        expect(await skill.handlers.diary_read({ days_back: 1 }, context)).toContain('A productive day.');

        expect(
            await skill.handlers.insight_add({ insight: 'Alice sounded tired today', resident_tg_id: '111' }, context)
        ).toContain('Recorded');
        expect(await skill.handlers.insight_add({ insight: 'The team is blocked on the draft' }, context)).toContain(
            'Recorded'
        );
        expect(await skill.handlers.insight_today({ resident_tg_id: '111' }, context)).toContain(
            'Alice sounded tired today'
        );
        db.prepare('INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)').run(
            'tool_call',
            JSON.stringify({ tool: 'memory_remember', ok: true }),
            new Date().toISOString()
        );
        expect(await skill.handlers.activity_log({ type: 'all', limit: 10 })).toContain('Activity log');

        const genericEntries = db
            .prepare('SELECT scope_type, kind, content FROM memory_entries ORDER BY id')
            .all() as any[];
        expect(
            genericEntries.some((entry) => entry.scope_type === 'person' && entry.content.includes('prefers tea'))
        ).toBe(true);
        expect(genericEntries.some((entry) => entry.scope_type === 'space' && entry.kind === 'diary')).toBe(true);
        expect(
            genericEntries.some(
                (entry) => entry.scope_type === 'work' && entry.content.includes('blocked on the draft')
            )
        ).toBe(true);

        expect(getMemoryContext({ residentId: '111', chatId: 'chat-1' })).toContain('[WORK MEMORY]');
        expect(getMemoryContext('111')).toContain('prefers tea');
        expect(await skill.handlers.memory_forget({ fact_fragment: 'tea' })).toContain('Deleted');
    });

    it('memory context uses structured person memory first and still respects cache boundaries', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-25T12:00:00Z'));
        try {
            const { default: skill, getMemoryContext } = await loadSkill<any>('./memory.skill');

            await skill.handlers.memory_remember({
                resident_name: 'Alice',
                fact: 'prefers tea',
                category: 'preference',
            });
            await skill.handlers.memory_remember({
                resident_name: 'Bob',
                fact: 'likes pasta',
                category: 'preference',
            });

            const firstContext = getMemoryContext({ residentId: '111', chatId: 'chat-1' });
            expect(firstContext).toContain('[PERSON MEMORY]');
            expect(firstContext).toContain('prefers tea');
            expect(firstContext).not.toContain('likes pasta');

            db.prepare(
                `
                INSERT INTO memory_entries (scope_type, scope_id, kind, content, salience, source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'person',
                '111',
                'preference',
                'now prefers coffee',
                0.8,
                'test',
                new Date().toISOString(),
                new Date().toISOString()
            );

            const cachedContext = getMemoryContext({ residentId: '111', chatId: 'chat-1' });
            expect(cachedContext).toBe(firstContext);
            expect(cachedContext).not.toContain('now prefers coffee');

            vi.advanceTimersByTime(5 * 60 * 1000 + 1);
            const refreshedContext = getMemoryContext({ residentId: '111', chatId: 'chat-1' });
            expect(refreshedContext).toContain('now prefers coffee');
        } finally {
            vi.useRealTimers();
        }
    });

    it('memory context can include project-scoped memory when a project is in focus', async () => {
        const { getMemoryContext } = await loadSkill<any>('./memory.skill');

        db.prepare(
            `
            INSERT INTO memory_entries (scope_type, scope_id, kind, content, salience, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'project',
            'project:firebreak',
            'project_update',
            'The shortlist draft is waiting on Bob.',
            0.9,
            'test',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const context = getMemoryContext({ residentId: '111', chatId: 'chat-1', projectId: 'project:firebreak' });

        expect(context).toContain('[PROJECT MEMORY]');
        expect(context).toContain('waiting on Bob');
    });

    it('memory_recall hides chat-only memories outside their source chat', async () => {
        const { default: skill } = await loadSkill<any>('./memory.skill');
        const dmContext = { chatId: 'chat-1', userId: '111' };
        const otherChatContext = { chatId: 'chat-2', userId: '111' };

        await skill.handlers.memory_remember(
            {
                resident_name: 'Alice',
                fact: 'shared a confidential travel plan',
                category: 'general',
                chat_only: true,
            },
            dmContext
        );
        await skill.handlers.memory_remember(
            {
                resident_name: 'Alice',
                fact: 'prefers green tea',
                category: 'preference',
            },
            dmContext
        );

        const dmRecall = await skill.handlers.memory_recall({ query: 'Alice' }, dmContext);
        const otherRecall = await skill.handlers.memory_recall({ query: 'Alice' }, otherChatContext);

        expect(dmRecall).toContain('shared a confidential travel plan');
        expect(otherRecall).not.toContain('shared a confidential travel plan');
        expect(otherRecall).toContain('prefers green tea');
    });

    it('legacy memory fallbacks respect chat scope', async () => {
        const { default: skill } = await loadSkill<any>('./memory.skill');
        const dmContext = { chatId: 'chat-1', userId: '111' };
        const otherChatContext = { chatId: 'chat-2', userId: '111' };
        const now = new Date().toISOString();
        const today = now.split('T')[0];

        db.prepare(
            `
            INSERT INTO resident_notes (resident_tg_id, resident_name, fact, category, chat_jid, scope, created_at, updated_at)
            VALUES
            ('111', 'Alice', 'global legacy preference', 'preference', NULL, 'global', ?, ?),
            ('111', 'Alice', 'private chat-1 legacy note', 'general', 'chat-1', 'private', ?, ?),
            ('111', 'Alice', 'private chat-2 legacy note', 'general', 'chat-2', 'private', ?, ?)
        `
        ).run(now, now, now, now, now, now);

        db.prepare(
            `
            INSERT INTO daily_insights (date, resident_tg_id, insight, chat_jid, scope, created_at)
            VALUES
            (?, '111', 'chat-1 daily insight', 'chat-1', 'private', ?),
            (?, '111', 'chat-2 daily insight', 'chat-2', 'private', ?)
        `
        ).run(today, now, today, now);

        const dmRecall = await skill.handlers.memory_recall({ query: 'legacy' }, dmContext);
        const otherRecall = await skill.handlers.memory_recall({ query: 'legacy' }, otherChatContext);
        expect(dmRecall).toContain('global legacy preference');
        expect(dmRecall).toContain('private chat-1 legacy note');
        expect(dmRecall).not.toContain('private chat-2 legacy note');
        expect(otherRecall).toContain('global legacy preference');
        expect(otherRecall).toContain('private chat-2 legacy note');
        expect(otherRecall).not.toContain('private chat-1 legacy note');

        const dmInsights = await skill.handlers.insight_today({ person_id: '111' }, dmContext);
        const otherInsights = await skill.handlers.insight_today({ person_id: '111' }, otherChatContext);
        expect(dmInsights).toContain('chat-1 daily insight');
        expect(dmInsights).not.toContain('chat-2 daily insight');
        expect(otherInsights).toContain('chat-2 daily insight');
        expect(otherInsights).not.toContain('chat-1 daily insight');
    });

    it('person insights stay in the chat where they were observed', async () => {
        const { default: skill } = await loadSkill<any>('./memory.skill');
        const dmContext = { chatId: 'chat-1', userId: '111' };
        const otherChatContext = { chatId: 'chat-2', userId: '111' };

        await skill.handlers.insight_add(
            { person_id: '111', insight: 'Alice is waiting on the DM document' },
            dmContext
        );

        const dmInsights = await skill.handlers.insight_today({ person_id: '111' }, dmContext);
        const otherInsights = await skill.handlers.insight_today({ person_id: '111' }, otherChatContext);

        expect(dmInsights).toContain('DM document');
        expect(otherInsights).not.toContain('DM document');
    });

    it('memory context keeps current-chat memories even when other chat-only entries outrank them', async () => {
        const { getMemoryContext } = await loadSkill<any>('./memory.skill');
        const now = new Date().toISOString();

        for (let i = 0; i < 30; i += 1) {
            db.prepare(
                `
                INSERT INTO memory_entries (
                    scope_type, scope_id, kind, content, salience, source, space_bound_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run('person', '111', 'general', `other chat note ${i}`, 1, 'test', 'telegram:chat-2', now, now);
        }

        db.prepare(
            `
            INSERT INTO memory_entries (
                scope_type, scope_id, kind, content, salience, source, space_bound_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run('person', '111', 'preference', 'global favorite: jasmine tea', 0.7, 'test', null, now, now);

        db.prepare(
            `
            INSERT INTO memory_entries (
                scope_type, scope_id, kind, content, salience, source, space_bound_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'person',
            '111',
            'general',
            'chat-1 promise: send the draft tonight',
            0.6,
            'test',
            'telegram:chat-1',
            now,
            now
        );

        const context = getMemoryContext({ residentId: '111', chatId: 'chat-1' });

        expect(context).toContain('global favorite: jasmine tea');
        expect(context).toContain('chat-1 promise: send the draft tonight');
        expect(context).not.toContain('other chat note 0');
    });

    it('memory skill cron handlers write quiet diaries and compact old data', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-25T09:00:00Z'));
        const processWithOllamaMock = vi.fn(async () => ({ text: 'Weekly summary text', fromOllama: true }));
        try {
            process.env.HOUSEHOLD_CHAT_ID = 'chat-1';
            const { default: skill } = await loadSkill<any>('./memory.skill');
            const ollama = await import('../core/ollama');
            vi.spyOn(ollama, 'processWithOllama').mockImplementation(processWithOllamaMock);

            await skill.crons[0].handler();
            let diary = db
                .prepare(
                    `
                SELECT * FROM memory_entries
                WHERE scope_type = 'space' AND scope_id = 'telegram:chat-1' AND kind = 'diary'
            `
                )
                .all() as any[];
            expect(diary).toHaveLength(1);
            expect(diary[0].content).toContain('quiet day');
            expect(db.prepare("SELECT * FROM house_diary WHERE type = 'daily'").all()).toHaveLength(0);

            db.prepare(
                "DELETE FROM memory_entries WHERE scope_type = 'space' AND scope_id = 'telegram:chat-1' AND kind = 'diary'"
            ).run();
            db.prepare('INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)').run(
                'tool_call',
                JSON.stringify({ tool: 'task_create', ok: true }),
                new Date().toISOString()
            );
            await skill.crons[0].handler();
            diary = db
                .prepare(
                    `
                SELECT * FROM memory_entries
                WHERE scope_type = 'space' AND scope_id = 'telegram:chat-1' AND kind = 'diary'
            `
                )
                .all() as any[];
            expect(processWithOllamaMock).toHaveBeenCalled();
            expect(diary).toHaveLength(1);

            db.prepare(
                "DELETE FROM memory_entries WHERE scope_type = 'space' AND scope_id = 'telegram:chat-1' AND kind = 'diary'"
            ).run();
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-2',
                'direct_chat',
                'chat-2',
                'telegram',
                'chat-2',
                'ACTIVE',
                'jeeves',
                'jeeves_personal',
                '{}',
                '2026-03-01T00:00:00.000Z',
                '2026-03-01T00:00:00.000Z'
            );
            db.prepare(
                `
                INSERT INTO memory_sprints (id, space_id, opened_at, closes_at, status, cadence_days, summary, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'sprint:telegram:chat-2:old',
                'telegram:chat-2',
                '2026-03-01T00:00:00.000Z',
                '2026-03-08T00:00:00.000Z',
                'active',
                7,
                '',
                '2026-03-01T00:00:00.000Z',
                '2026-03-01T00:00:00.000Z'
            );
            db.prepare(
                `
                INSERT INTO memory_entries (scope_type, scope_id, memory_sprint_id, kind, content, salience, source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'work',
                'telegram:chat-2',
                'sprint:telegram:chat-2:old',
                'insight',
                'Private DM sprint should compact too.',
                0.8,
                'test',
                '2026-03-02T10:00:00.000Z',
                '2026-03-02T10:00:00.000Z'
            );
            db.prepare(
                `
                INSERT INTO house_diary (date, entry, type, token_count, created_at)
                VALUES
                ('2026-03-02', 'Entry 2', 'daily', 10, '2026-03-02T10:00:00'),
                ('2026-03-03', 'Entry 3', 'daily', 10, '2026-03-03T10:00:00'),
                ('2026-03-04', 'Entry 4', 'daily', 10, '2026-03-04T10:00:00')
            `
            ).run();
            const oldDiary = db.prepare('SELECT date, type FROM house_diary ORDER BY date').all() as any[];
            expect(oldDiary).toHaveLength(3);
            await skill.crons[1].handler();
            expect(processWithOllamaMock).toHaveBeenCalledTimes(2);

            const legacyRecollections = db
                .prepare(
                    `
                SELECT * FROM memory_entries
                WHERE scope_type = 'space' AND scope_id = 'telegram:chat-1' AND kind = 'recollection'
            `
                )
                .all() as any[];
            expect(legacyRecollections.length).toBeGreaterThan(0);
            expect(legacyRecollections[0].content).toContain('Legacy diary recollection');
            expect(db.prepare("SELECT * FROM house_diary WHERE type = 'daily'").all()).toHaveLength(0);
            const dmRecollection = db
                .prepare(
                    `
                SELECT * FROM memory_entries
                WHERE scope_type = 'work' AND scope_id = 'telegram:chat-2' AND kind = 'recollection'
            `
                )
                .get() as any;
            expect(dmRecollection.content).toContain('Private DM sprint should compact too');

            db.prepare(
                `
                INSERT INTO daily_insights (date, resident_tg_id, insight, created_at)
                VALUES ('2026-03-01', '111', 'old insight', '2026-03-01T10:00:00')
            `
            ).run();
            await skill.crons[2].handler();
            const insights = db.prepare('SELECT * FROM daily_insights').all();
            expect(insights).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('spaces skill can inspect and reconfigure the current space for authorized members', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'jeeves',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            CREATE TABLE IF NOT EXISTS memberships (
                space_id TEXT NOT NULL,
                person_id TEXT NOT NULL,
                role TEXT NOT NULL,
                base_authority INTEGER NOT NULL DEFAULT 100,
                reputation_delta INTEGER NOT NULL DEFAULT 0,
                trust_flags_json TEXT NOT NULL DEFAULT '{}',
                authority_note TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (space_id, person_id)
            )
        `
        ).run();
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memory_sprints (id, space_id, opened_at, closes_at, status, cadence_days, summary, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'sprint:telegram:chat-1:2026-03-01',
            'telegram:chat-1',
            '2026-03-01T00:00:00.000Z',
            '2026-03-08T00:00:00.000Z',
            'compacted',
            7,
            'Weekly office summary with a few open threads.',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./spaces.skill');
        const context = { chatId: 'chat-1', userId: '111' };

        expect(await skill.handlers.space_status({}, context)).toContain('Pack: jeeves');
        expect(await skill.handlers.space_status({}, context)).toContain('Grounding: jeeves_personal');
        expect(await skill.handlers.space_list_packs({}, context)).toContain('office');
        expect(await skill.handlers.space_list_sprints({}, context)).toContain('Weekly office summary');
        expect(await skill.handlers.space_set_pack({ pack_id: 'office' }, context)).toContain('reseeded');
        expect(await skill.handlers.space_set_policy({ browser: false, tasks: true }, context)).toContain(
            'browser: false'
        );
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-space-status-'));
        const resolvedWorkspaceRoot = fs.realpathSync(workspaceRoot);
        try {
            expect(await skill.handlers.space_set_workspace({ workspace_path: workspaceRoot }, context)).toContain(
                resolvedWorkspaceRoot
            );

            const space = db
                .prepare('SELECT assistant_pack_id, policy_json FROM spaces WHERE id = ?')
                .get('telegram:chat-1') as any;
            expect(space.assistant_pack_id).toBe('office');
            const tasks = db
                .prepare('SELECT id FROM tasks WHERE space_id = ? ORDER BY id')
                .all('telegram:chat-1') as Array<{ id: string }>;
            expect(tasks.map((task) => task.id)).toContain('task:telegram:chat-1:followup_digest');
            expect(tasks.map((task) => task.id)).toContain('task:telegram:chat-1:atelier_review');
            expect(JSON.parse(space.policy_json)).toEqual(
                expect.objectContaining({
                    browser: false,
                    tasks: true,
                    workspace_path: resolvedWorkspaceRoot,
                })
            );
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('spaces skill accepts normal workspace directories and rejects unsafe ones', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-space-workspace-'));
        const resolvedWorkspaceRoot = fs.realpathSync(workspaceRoot);
        try {
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-10',
                'group_chat',
                'Workspace Policy Team',
                'telegram',
                'chat-10',
                'ACTIVE',
                'jeeves',
                'jeeves_personal',
                '{}',
                new Date().toISOString(),
                new Date().toISOString()
            );
            db.prepare(
                `
                INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-10',
                '111',
                'owner',
                1000,
                0,
                JSON.stringify({
                    can_assign_tasks: true,
                    can_change_policies: true,
                    can_override_instructions: true,
                    can_issue_high_impact_commands: true,
                }),
                'owner',
                new Date().toISOString(),
                new Date().toISOString()
            );

            const { default: skill } = await loadSkill<any>('./spaces.skill');
            const context = { chatId: 'chat-10', userId: '111' };

            expect(await skill.handlers.space_set_workspace({ workspace_path: workspaceRoot }, context)).toContain(
                resolvedWorkspaceRoot
            );
            expect(await skill.handlers.space_set_workspace({ workspace_path: '/proc' }, context)).toContain(
                'protected system location'
            );
            expect(
                await skill.handlers.space_set_workspace(
                    { workspace_path: path.join(workspaceRoot, 'missing') },
                    context
                )
            ).toContain('does not exist');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('projects skill keeps a focused project small, linkable, and aware of auto-linked tasks and artifacts', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-projects-'));
        try {
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                'group_chat',
                'Project Team',
                'telegram',
                'chat-1',
                'ACTIVE',
                'office',
                JSON.stringify({ tasks: true, workspace_path: workspaceRoot }),
                new Date().toISOString(),
                new Date().toISOString()
            );
            db.prepare(
                `
                INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                '111',
                'owner',
                1000,
                0,
                JSON.stringify({
                    can_assign_tasks: true,
                    can_change_policies: true,
                    can_override_instructions: true,
                    can_issue_high_impact_commands: true,
                }),
                'owner',
                new Date().toISOString(),
                new Date().toISOString()
            );

            const { default: projectSkill } = await loadSkill<any>('./projects.skill');
            const { default: taskSkill } = await loadSkill<any>('./tasks.skill', () => {
                vi.doMock('../agents/butler', () => ({ handleButlerMessage: vi.fn(async () => undefined) }));
                vi.doMock('../channels/telegram', () => ({ sendMessageToChat: vi.fn(async () => undefined) }));
                vi.doMock('../channels/runtime', () =>
                    makeChannelRuntimeMock({
                        sendMessageToChat: vi.fn(async () => undefined),
                        getSpace: (spaceId: string) =>
                            db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as any,
                    })
                );
                vi.doMock('../channels/runtime', () =>
                    makeChannelRuntimeMock({
                        sendMessageToChat: vi.fn(async () => undefined),
                        getSpace: (spaceId: string) =>
                            db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as any,
                    })
                );
            });
            const { default: workspaceSkill } = await loadSkill<any>('./workspace.skill');
            const context = { chatId: 'chat-1', userId: '111' };

            expect(
                await projectSkill.handlers.project_create(
                    {
                        title: 'Firebreak',
                        goal: 'Stabilize the memo and shortlist.',
                        next_step: 'Write the shortlist note.',
                    },
                    context
                )
            ).toContain('Created project');
            expect(await projectSkill.handlers.project_status({}, context)).toContain('Project Firebreak');
            expect(await projectSkill.handlers.project_list({}, context)).toContain('Firebreak');
            expect(
                await projectSkill.handlers.project_next({ next_step: 'Review the shortlist with Bob.' }, context)
            ).toContain('Review the shortlist with Bob.');

            expect(
                await taskSkill.handlers.task_create(
                    {
                        title: 'Weekly digest',
                        prompt: 'Write a short weekly digest.',
                        cron_expression: '0 8 * * 1',
                    },
                    context
                )
            ).toContain('Scheduled task created');
            const createdTask = db.prepare('SELECT * FROM tasks WHERE title = ?').get('Weekly digest') as any;
            expect(createdTask).toBeDefined();

            expect(
                await workspaceSkill.handlers.workspace_save_artifact(
                    {
                        title: 'Shortlist note',
                        content: 'Alice drafts the shortlist.',
                    },
                    context
                )
            ).toContain('.pipi/artifacts/');

            expect(
                await projectSkill.handlers.project_link(
                    {
                        link_type: 'artifact',
                        target_id: 'manual/brief.md',
                    },
                    context
                )
            ).toContain('Linked artifact');
            expect(
                await projectSkill.handlers.project_unlink(
                    {
                        link_type: 'artifact',
                        target_id: 'manual/brief.md',
                    },
                    context
                )
            ).toContain('Unlinked artifact');
            expect(await projectSkill.handlers.project_done({}, context)).toContain('now done');

            const project = db.prepare('SELECT * FROM projects WHERE slug = ?').get('firebreak') as any;
            const taskLinks = db
                .prepare(
                    `
                SELECT target_id FROM project_links
                WHERE project_id = ? AND link_type = 'task'
            `
                )
                .all(project.id) as Array<{ target_id: string }>;
            const artifactLinks = db
                .prepare(
                    `
                SELECT target_id FROM project_links
                WHERE project_id = ? AND link_type = 'artifact'
                ORDER BY target_id ASC
            `
                )
                .all(project.id) as Array<{ target_id: string }>;
            const projectMemory = db
                .prepare(
                    `
                SELECT * FROM memory_entries
                WHERE scope_type = 'project' AND scope_id = ?
                ORDER BY id ASC
            `
                )
                .all(project.id) as any[];
            const policy = JSON.parse(
                (db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:chat-1') as any).policy_json ||
                    '{}'
            );

            expect(taskLinks.map((row) => row.target_id)).toContain(createdTask.id);
            expect(artifactLinks.some((row) => row.target_id.startsWith('.pipi/artifacts/'))).toBe(true);
            expect(artifactLinks.some((row) => row.target_id === 'manual/brief.md')).toBe(false);
            expect(projectMemory.some((entry) => entry.content.includes('Project created: Firebreak'))).toBe(true);
            expect(projectMemory.some((entry) => entry.content.includes('Next step updated'))).toBe(true);
            expect(projectMemory.some((entry) => entry.content.includes('Project marked done'))).toBe(true);
            expect(policy.active_project_id).toBeNull();
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('grounding skill manages the current world-model with installable packs and active overrides', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-9',
            'group_chat',
            'Personal',
            'telegram',
            'chat-9',
            'ACTIVE',
            'jeeves',
            'jeeves_personal',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-9',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./grounding.skill');
        const context = { chatId: 'chat-9', userId: '111' };

        expect(await skill.handlers.grounding_status({}, context)).toContain('Office Coordination');
        expect(await skill.handlers.grounding_list_packs({}, context)).toContain('jeeves_personal');
        expect(
            await skill.handlers.grounding_add_override(
                {
                    kind: 'person',
                    subject: 'Alice',
                    content: 'Alice moved abroad and is no longer part of this household.',
                },
                context
            )
        ).toContain('Alice');
        expect(
            await skill.handlers.grounding_add_override(
                {
                    kind: 'place',
                    subject: 'Family home',
                    content: 'The family now lives in Tbilisi.',
                },
                context
            )
        ).toContain('Tbilisi');

        const listed = await skill.handlers.grounding_list_overrides({}, context);
        expect(listed).toContain('Alice moved abroad');
        expect(listed).toContain('Family home');

        const activeOverrides = db
            .prepare(
                `
            SELECT * FROM grounding_overrides WHERE space_id = ? AND status = 'active' ORDER BY id ASC
        `
            )
            .all('telegram:chat-9') as any[];
        expect(activeOverrides).toHaveLength(2);

        expect(
            await skill.handlers.grounding_disable_override({ override_id: activeOverrides[0].id }, context)
        ).toContain('Disabled');
        const disabled = db.prepare('SELECT * FROM grounding_overrides WHERE id = ?').get(activeOverrides[0].id) as any;
        expect(disabled.status).toBe('inactive');
    });

    it('tasks skill manages scheduled assistant tasks for the current space', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            JSON.stringify({ tasks: true }),
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./tasks.skill', () => {
            vi.doMock('../agents/butler', () => ({ handleButlerMessage: vi.fn(async () => undefined) }));
            vi.doMock('../channels/telegram', () => ({ sendMessageToChat: vi.fn(async () => undefined) }));
            vi.doMock('../channels/runtime', () =>
                makeChannelRuntimeMock({
                    sendMessageToChat: vi.fn(async () => undefined),
                    getSpace: (spaceId: string) => db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as any,
                })
            );
        });
        const context = { chatId: 'chat-1', userId: '111' };

        const createResult = await skill.handlers.task_create(
            {
                title: 'Weekly digest',
                prompt: 'Write a short weekly digest for the team.',
                frequency: 'weekdays',
                time_local: '08:00',
                deadline_at: '2026-04-01T10:00:00.000Z',
            },
            context
        );
        expect(createResult).toContain('Scheduled task created');
        expect(createResult).toContain('Schedule: weekdays at 08:00');
        expect(createResult).toContain('Deadline: 2026-04-01T10:00:00.000Z');

        const createdTask = db.prepare('SELECT * FROM tasks WHERE title = ?').get('Weekly digest') as any;
        expect(createdTask).toBeDefined();
        expect(createdTask.schedule_value).toBe('0 8 * * 1-5');
        expect(JSON.parse(createdTask.config_json).deadline.at).toBe('2026-04-01T10:00:00.000Z');

        const list = await skill.handlers.task_list({}, context);
        expect(list).toContain('Weekly digest');
        expect(list).toContain('schedule: weekdays at 08:00; cron: 0 8 * * 1-5');
        expect(list).toContain('deadline');
        expect(list).toContain('2026-04-01 10:00');
        const compactList = await skill.handlers.task_list({ compact: true }, context);
        expect(compactList).toContain('Active scheduled tasks:');
        expect(compactList).toContain('• Weekly digest — weekdays at 08:00');
        expect(compactList).not.toContain(createdTask.id);
        expect(compactList).not.toContain('cron:');
        expect(await skill.handlers.task_run_now({ task_id: createdTask.id }, context)).toContain('ran successfully');
        expect(
            (db.prepare('SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?').get(createdTask.id) as any).cnt
        ).toBe(1);
        expect(await skill.handlers.task_pause({ task_id: createdTask.id }, context)).toContain('paused');
        expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(createdTask.id) as any).status).toBe('paused');
        expect(await skill.handlers.task_resume({ task_id: createdTask.id }, context)).toContain('active again');
        expect(await skill.handlers.task_cancel({ task_id: createdTask.id }, context)).toContain('deleted');
        expect(db.prepare('SELECT * FROM tasks WHERE id = ?').get(createdTask.id)).toBeUndefined();
    });

    it('rituals skill manages seeded day and week rituals for the current space', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Personal',
            'telegram',
            'chat-1',
            'ACTIVE',
            'jeeves',
            JSON.stringify({ tasks: true }),
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./rituals.skill', () => {
            vi.doMock('../agents/butler', () => ({ handleButlerMessage: vi.fn(async () => undefined) }));
            vi.doMock('../channels/telegram', () => ({ sendMessageToChat: vi.fn(async () => undefined) }));
            vi.doMock('../channels/runtime', () =>
                makeChannelRuntimeMock({
                    sendMessageToChat: vi.fn(async () => undefined),
                    getSpace: (spaceId: string) => db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as any,
                })
            );
        });
        const { ensureDefaultAssistantTasksForSpace } = await import('../core/tasks');
        const context = { chatId: 'chat-1', userId: '111' };

        expect(await skill.handlers.ritual_list({}, context)).toContain('morning');
        expect(
            await skill.handlers.ritual_configure(
                {
                    ritual_key: 'morning',
                    time_local: '08:30',
                },
                context
            )
        ).toContain('08:30');
        expect(
            await skill.handlers.ritual_configure(
                {
                    ritual_key: 'weekly',
                    weekday: 'fri',
                    time_local: '10:15',
                },
                context
            )
        ).toContain('fri');
        expect(
            await skill.handlers.ritual_configure(
                {
                    ritual_key: 'evening',
                    enabled: false,
                },
                context
            )
        ).toContain('paused');

        ensureDefaultAssistantTasksForSpace('telegram:chat-1');

        const morningTask = db
            .prepare('SELECT * FROM tasks WHERE id = ?')
            .get('task:telegram:chat-1:briefing_morning') as any;
        const weeklyTask = db
            .prepare('SELECT * FROM tasks WHERE id = ?')
            .get('task:telegram:chat-1:weekly_reset') as any;
        const eveningTask = db
            .prepare('SELECT * FROM tasks WHERE id = ?')
            .get('task:telegram:chat-1:wrapup_evening') as any;

        expect(morningTask.schedule_value).toBe('30 8 * * *');
        expect(weeklyTask.schedule_value).toBe('15 10 * * 5');
        expect(eveningTask.status).toBe('paused');

        expect(await skill.handlers.ritual_run_now({ ritual_key: 'morning' }, context)).toContain('ran successfully');
        expect(
            (db.prepare('SELECT COUNT(*) as cnt FROM task_runs WHERE task_id = ?').get(morningTask.id) as any).cnt
        ).toBe(1);
    });

    it('onboarding skill restricts manual finish to policy editors', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:onboarding-chat',
            'group_chat',
            'Onboarding',
            'telegram',
            'onboarding-chat',
            'ACTIVE',
            'jeeves',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:onboarding-chat',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:onboarding-chat',
            '222',
            'member',
            100,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: false,
                can_override_instructions: false,
                can_issue_high_impact_commands: false,
            }),
            'member',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./onboarding.skill');
        const ownerContext = { chatId: 'onboarding-chat', userId: '111' };
        const memberContext = { chatId: 'onboarding-chat', userId: '222' };

        expect(await skill.handlers.onboarding_finish({}, memberContext)).toContain('Only owners or admins');
        expect(await skill.handlers.onboarding_finish({}, ownerContext)).toContain(
            'Onboarding mode has been turned off'
        );
        expect(
            JSON.parse(
                (db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:onboarding-chat') as any)
                    .policy_json || '{}'
            ).onboarding_complete
        ).toBe(true);
    });

    it('onboarding status treats participants who spoke in the space as already introduced', async () => {
        const now = new Date().toISOString();
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:onboarding-chat',
            'group_chat',
            'Onboarding',
            'telegram',
            'onboarding-chat',
            'ACTIVE',
            'jeeves',
            '{}',
            now,
            now
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:onboarding-chat',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            now,
            now
        );
        db.prepare(
            `
            INSERT INTO messages (id, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        ).run('msg-111', 'telegram:onboarding-chat', 'onboarding-chat', '111', 'I handle product decisions.', now, 0);

        const { default: skill } = await loadSkill<any>('./onboarding.skill');
        const status = await skill.handlers.onboarding_status({}, { chatId: 'onboarding-chat', userId: '111' });

        expect(status).toContain('All participants have at least some recorded context.');
        expect(status).not.toContain('Alice');
    });

    it('onboarding skill sends the day-two coaching note once', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-26T10:00:00.000Z'));
        process.env.TZ = 'UTC';

        const sendMessageToChat = vi.fn<(chatId: string, text: string) => Promise<void>>(async () => undefined);

        try {
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:onboarding-chat',
                'group_chat',
                'Onboarding',
                'telegram',
                'onboarding-chat',
                'ACTIVE',
                'jeeves',
                '{}',
                '2026-03-25T13:00:00.000Z',
                '2026-03-25T13:00:00.000Z'
            );
            db.prepare(
                `
                INSERT INTO messages (id, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'msg-recent',
                'telegram:onboarding-chat',
                'onboarding-chat',
                '111',
                'Approved staging rollout',
                '2026-03-26T09:40:00.000Z',
                0
            );
            db.prepare(
                `
                INSERT INTO messages (id, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'msg-old',
                'telegram:onboarding-chat',
                'onboarding-chat',
                '111',
                'Old irrelevant update',
                '2026-03-24T09:40:00.000Z',
                0
            );

            const { default: skill } = await loadSkill<any>('./onboarding.skill', () => {
                vi.doMock('../channels/telegram', () => ({ sendMessageToChat }));
                vi.doMock('../channels/runtime', () =>
                    makeChannelRuntimeMock({
                        sendMessageToChat,
                        getSpace: (spaceId: string) =>
                            db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as any,
                    })
                );
            });
            const job = skill.crons.find((cron: any) => cron.description === 'Day-two onboarding coaching note');

            expect(job).toBeTruthy();
            await job.handler();

            expect(sendMessageToChat).toHaveBeenCalledTimes(1);
            const [chatId, text] = sendMessageToChat.mock.calls[0];
            expect(chatId).toBe('onboarding-chat');
            expect(text).toContain('Второй день я с вами в команде');
            expect(text).toContain('Мы тут потихоньку с вами учимся работать вместе');
            expect(text).toContain('это не всегда просто');
            expect(text).toContain('README');
            expect(text).toContain('space');
            expect(text).toContain('pack');
            expect(text).toContain('grounding');
            expect(text).toContain('Формулируйте вопросы ко мне четко');
            expect(text).toContain('пример или цитата');
            expect(text).toContain('Не стесняйтесь');
            expect(text).toContain('Approved staging rollout');
            expect(text).toContain('Приходит бот на второй день');
            expect(text).not.toContain('Шутка');
            expect(text).not.toContain('Old irrelevant update');

            const policy = JSON.parse(
                (db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get('telegram:onboarding-chat') as any)
                    .policy_json || '{}'
            );
            expect(policy.onboarding_day2_note_sent_at).toBeTruthy();

            await job.handler();
            expect(sendMessageToChat).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('members skill manages roles, reputation, and trust flags in the current space', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '222',
            'member',
            100,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: false,
                can_override_instructions: false,
                can_issue_high_impact_commands: false,
            }),
            'member',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./members.skill');
        const context = { chatId: 'chat-1', userId: '111' };

        expect(await skill.handlers.member_list({}, context)).toContain('@bob');
        expect(await skill.handlers.member_show({ person_id: '@bob' }, context)).toContain('@bob');
        expect(await skill.handlers.member_set_role({ person_id: '@bob', role: 'manager' }, context)).toContain(
            'role "manager"'
        );
        expect(
            await skill.handlers.member_set_reputation({ person_id: 'Bob', reputation_delta: 80 }, context)
        ).toContain('reputation_delta 80');
        expect(
            await skill.handlers.member_set_trust_flag(
                { person_id: 'Bob', flag: 'can_change_policies', enabled: true },
                context
            )
        ).toContain('enabled');

        const updated = db
            .prepare('SELECT * FROM memberships WHERE space_id = ? AND person_id = ?')
            .get('telegram:chat-1', '222') as any;
        expect(updated.role).toBe('manager');
        expect(updated.base_authority).toBe(500);
        expect(updated.reputation_delta).toBe(80);
        expect(JSON.parse(updated.trust_flags_json).can_change_policies).toBe(true);
    });

    it('atelier skill logs capability gaps on current space and current pack', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Editorial',
            'telegram',
            'chat-1',
            'ACTIVE',
            'reporter',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            '111',
            'owner',
            1000,
            0,
            JSON.stringify({
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            }),
            'owner',
            new Date().toISOString(),
            new Date().toISOString()
        );

        const { default: skill } = await loadSkill<any>('./atelier.skill');
        const context = { chatId: 'chat-1', userId: '111' };

        expect(
            await skill.handlers.atelier_request_capability(
                {
                    capability_gap: 'topic_cluster_discovery',
                    description: 'Need clustering across multiple news leads before drafting.',
                    user_request: 'Find emerging clusters before writing the article.',
                },
                context
            )
        ).toContain('pack "reporter"');

        expect(
            await skill.handlers.atelier_request_capability(
                {
                    capability_gap: 'topic_cluster_discovery',
                    description: 'Need clustering across multiple news leads before drafting.',
                    user_request: 'Also group leads by angle and urgency.',
                },
                context
            )
        ).toContain('Votes: 1');

        const requestRow = db.prepare('SELECT id FROM skill_requests LIMIT 1').get() as { id: number };
        const bySpace = await skill.handlers.atelier_list_requests({ scope: 'space' }, context);
        const byPack = await skill.handlers.atelier_list_requests({ scope: 'pack' }, context);
        const ticket = await skill.handlers.atelier_create_ticket(
            {
                request_id: requestRow.id,
                implementation_notes: 'Prefer building on existing reporter primitives.',
            },
            context
        );
        const tickets = await skill.handlers.atelier_list_tickets({ scope: 'pack' }, context);

        expect(bySpace).toContain('topic_cluster_discovery');
        expect(byPack).toContain('pack reporter');
        expect(ticket).toContain(`[IMPLEMENTATION_TICKET ATL-${requestRow.id}]`);
        expect(ticket).toContain('Prefer building on existing reporter primitives.');
        expect(tickets).toContain(`ATL-${requestRow.id}`);
        expect(db.prepare('SELECT COUNT(*) as cnt FROM skill_requests').get() as any).toEqual(
            expect.objectContaining({ cnt: 1 })
        );
    });

    it('history skill searches prior messages in current or all tracked spaces', async () => {
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-1',
            'group_chat',
            'Office Team',
            'telegram',
            'chat-1',
            'ACTIVE',
            'office',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'telegram:chat-2',
            'private_chat',
            'Direct Notes',
            'telegram',
            'chat-2',
            'ACTIVE',
            'jeeves',
            '{}',
            new Date().toISOString(),
            new Date().toISOString()
        );
        db.prepare(
            `
            INSERT INTO messages (id, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'msg-1',
            'telegram:chat-1',
            'chat-1',
            '111',
            'Please update the board deck before lunch.',
            '2026-03-25T09:00:00.000Z',
            0
        );
        db.prepare(
            `
            INSERT INTO messages (id, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'msg-2',
            'telegram:chat-2',
            'chat-2',
            '111',
            'Remember to revisit the board deck narrative.',
            '2026-03-25T10:00:00.000Z',
            0
        );
        db.prepare(
            `
            INSERT INTO memory_entries (scope_type, scope_id, memory_sprint_id, kind, content, salience, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'work',
            'telegram:chat-1',
            null,
            'recollection',
            'Work recollection (2026-03-01 -> 2026-03-08): the board deck summary kept drifting and needed a tighter narrative.',
            0.9,
            'sprint_compaction',
            '2026-03-08T00:00:00.000Z',
            '2026-03-08T00:00:00.000Z'
        );
        db.prepare(
            `
            INSERT INTO memory_entries (scope_type, scope_id, memory_sprint_id, kind, content, salience, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            'space',
            'telegram:chat-2',
            null,
            'recollection',
            'Space recollection (2026-03-10 -> 2026-03-17): direct notes kept circling back to the board deck narrative.',
            0.7,
            'sprint_compaction',
            '2026-03-17T00:00:00.000Z',
            '2026-03-17T00:00:00.000Z'
        );

        const { default: skill } = await loadSkill<any>('./history.skill');
        const context = { chatId: 'chat-1', userId: '111' };

        const currentSpace = await skill.handlers.chat_search({ query: 'board deck', scope: 'current_space' }, context);
        const allSpaces = await skill.handlers.chat_search({ query: 'board deck', scope: 'all_spaces' }, context);
        const currentRecollections = await skill.handlers.chat_search(
            { query: 'board deck', scope: 'current_space', mode: 'recollections' },
            context
        );
        const allRecollections = await skill.handlers.chat_search(
            { query: 'board deck', scope: 'all_spaces', mode: 'recollections' },
            context
        );

        expect(currentSpace).toContain('Office Team');
        expect(currentSpace).not.toContain('Direct Notes');
        expect(allSpaces).toContain('Office Team');
        expect(allSpaces).toContain('Direct Notes');
        expect(currentRecollections).toContain('work recollection');
        expect(currentRecollections).toContain('Office Team');
        expect(currentRecollections).not.toContain('Direct Notes');
        expect(allRecollections).toContain('Office Team');
        expect(allRecollections).toContain('Direct Notes');
    });

    it('workspace skill inspects the attached workspace and writes safe artifacts', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-workspace-'));
        try {
            fs.mkdirSync(path.join(workspaceRoot, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(workspaceRoot, 'docs', 'brief.txt'), 'Workspace brief content', 'utf-8');

            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                'group_chat',
                'Workspace Team',
                'telegram',
                'chat-1',
                'ACTIVE',
                'office',
                JSON.stringify({ workspace_path: workspaceRoot }),
                new Date().toISOString(),
                new Date().toISOString()
            );
            db.prepare(
                `
                INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                '111',
                'owner',
                1000,
                0,
                JSON.stringify({
                    can_assign_tasks: true,
                    can_change_policies: true,
                    can_override_instructions: true,
                    can_issue_high_impact_commands: true,
                }),
                'owner',
                new Date().toISOString(),
                new Date().toISOString()
            );

            const { default: skill } = await loadSkill<any>('./workspace.skill');
            const context = { chatId: 'chat-1', userId: '111' };

            expect(await skill.handlers.workspace_status({}, context)).toContain(workspaceRoot);
            expect(await skill.handlers.workspace_list({ relative_path: 'docs' }, context)).toContain('docs/brief.txt');
            expect(await skill.handlers.workspace_find_files({ query: 'brief' }, context)).toContain('docs/brief.txt');
            expect(await skill.handlers.workspace_find_text({ query: 'brief content' }, context)).toContain(
                'Workspace brief content'
            );
            expect(await skill.handlers.workspace_read_text({ relative_path: 'docs/brief.txt' }, context)).toContain(
                'Workspace brief content'
            );
            expect(
                await skill.handlers.workspace_save_artifact(
                    { title: 'Weekly Notes', content: 'Action items go here.' },
                    context
                )
            ).toContain('.pipi/artifacts/');
            expect(await skill.handlers.workspace_list_artifacts({}, context)).toContain('.pipi/artifacts/');

            const artifactDir = path.join(workspaceRoot, '.pipi', 'artifacts');
            expect(fs.readdirSync(artifactDir).length).toBeGreaterThan(0);
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('workflows skill saves pack-aware office and reporter artifacts', async () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-workflows-'));
        try {
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                'group_chat',
                'Office Team',
                'telegram',
                'chat-1',
                'ACTIVE',
                'office',
                JSON.stringify({ workspace_path: workspaceRoot }),
                new Date().toISOString(),
                new Date().toISOString()
            );
            db.prepare(
                `
                INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                'telegram:chat-1',
                '111',
                'owner',
                1000,
                0,
                JSON.stringify({
                    can_assign_tasks: true,
                    can_change_policies: true,
                    can_override_instructions: true,
                    can_issue_high_impact_commands: true,
                }),
                'owner',
                new Date().toISOString(),
                new Date().toISOString()
            );

            const { default: skill } = await loadSkill<any>('./workflows.skill');
            const context = { chatId: 'chat-1', userId: '111' };

            expect(await skill.handlers.workflow_list_templates({}, context)).toContain('office_followup');
            expect(
                await skill.handlers.office_create_followup(
                    {
                        title: 'Hiring sync',
                        summary: 'Reviewed pipeline and blockers.',
                        body: 'Move two candidates to final round.',
                        bullets: 'Alice: draft scorecards\nBob: schedule finals',
                        extra: 'Need salary approval',
                    },
                    context
                )
            ).toContain('.pipi/office/');
            expect(await skill.handlers.workflow_list_recent_artifacts({}, context)).toContain('.pipi/office/');
            expect(
                (
                    db
                        .prepare(
                            `
                SELECT content FROM memory_entries
                WHERE scope_type = 'work' AND scope_id = 'telegram:chat-1' AND kind = 'workflow_artifact'
                ORDER BY id DESC LIMIT 1
            `
                        )
                        .get() as any
                ).content
            ).toContain('Hiring sync');

            db.prepare('UPDATE spaces SET assistant_pack_id = ? WHERE id = ?').run('reporter', 'telegram:chat-1');
            expect(await skill.handlers.workflow_list_templates({}, context)).toContain('reporter_brief');
            expect(
                await skill.handlers.reporter_create_brief(
                    {
                        title: 'City transport brief',
                        summary: 'Angle on funding delays.',
                        body: 'Focus on why the rollout slowed down.',
                        bullets: 'City hall\nOperator union',
                        extra: 'Need filing by Friday',
                    },
                    context
                )
            ).toContain('.pipi/reporter/');
            expect(
                await skill.handlers.reporter_create_draft(
                    {
                        title: 'City transport draft',
                        body: 'Draft body here.',
                        summary: 'Why the project stalled.',
                    },
                    context
                )
            ).toContain('.pipi/reporter/');
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
});
