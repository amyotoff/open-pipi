import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    getDb,
    getDirectContactStatuses,
    getMemoryEntries,
    getSpace,
    getSpaceParticipants,
    getResident,
    memberHasTrustFlag,
    updateSpacePolicy,
} from '../db';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { resolveSpacePolicy } from '../core/policy';
import { sendChannelMessage, sendSpaceMessage } from '../channels/runtime';
import { logInfo } from '../utils/logging';

type ExecutionContext = Partial<RuntimeExecutionContext>;

const ONBOARDING_MAX_AGE_DAYS = 14;
const ONBOARDING_MEMORY_THRESHOLD = 15;
const ONBOARDING_DAY_TWO_NOTE_POLICY_KEY = 'onboarding_day2_note_sent_at';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type RecentWorkMessage = {
    content: string | null;
    timestamp: string | null;
    sender_tg_id?: string | null;
    is_bot?: number | null;
};

function localDayKey(input: Date | string, timeZone: string = process.env.TZ || 'UTC'): string | null {
    const date = typeof input === 'string' ? new Date(input) : input;
    if (Number.isNaN(date.getTime())) return null;

    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        })
            .formatToParts(date)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );

    return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayKeyToUtcMs(dayKey: string): number {
    const [year, month, day] = dayKey.split('-').map((part) => Number(part));
    return Date.UTC(year, month - 1, day);
}

function localCalendarAgeDays(createdAt: string, now: Date = new Date()): number {
    const createdDay = localDayKey(createdAt);
    const currentDay = localDayKey(now);
    if (!createdDay || !currentDay) return -1;
    return Math.floor((dayKeyToUtcMs(currentDay) - dayKeyToUtcMs(createdDay)) / ONE_DAY_MS);
}

function isSecondLocalOnboardingDay(createdAt: string): boolean {
    return localCalendarAgeDays(createdAt) === 1;
}

function hasDayTwoNoteBeenSent(policy: Record<string, unknown>): boolean {
    const sentAt = policy[ONBOARDING_DAY_TWO_NOTE_POLICY_KEY];
    return typeof sentAt === 'string' && sentAt.trim().length > 0;
}

function compactForMessage(value: string, maxLength: number): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.substring(0, maxLength - 3).trimEnd()}...`;
}

function getRecentHumanWorkMessages(spaceId: string): RecentWorkMessage[] {
    const cutoff = new Date(Date.now() - ONE_DAY_MS).toISOString();
    return getDb()
        .prepare(
            `
        SELECT m.content, m.timestamp, m.sender_tg_id, m.is_bot
        FROM messages m
        WHERE COALESCE(m.space_id, 'telegram:' || m.chat_jid) = ?
          AND m.timestamp >= ?
          AND COALESCE(m.is_bot, 0) = 0
          AND COALESCE(m.sender_tg_id, '') != 'system_cron'
          AND COALESCE(m.content, '') != '[ACCESS_DENIED_DIRECT_CONTACT]'
          AND COALESCE(m.content, '') NOT LIKE '[SYSTEM TASK]%'
        ORDER BY m.timestamp ASC
        LIMIT 30
    `
        )
        .all(spaceId, cutoff) as RecentWorkMessage[];
}

function buildRecentWorkJoke(messages: RecentWorkMessage[]): string {
    const meaningful = messages.map((m) => compactForMessage(m.content || '', 100)).filter(Boolean);

    if (meaningful.length === 0) {
        return [
            'Приходит бот на второй день в командный чат и говорит:',
            '- Кажется, я уже понял, как тут работать.',
            'Команда спрашивает:',
            '- И как?',
            'Бот отвечает:',
            '- Если мне прислали пример, цитату и задачу подряд, я сначала уточняю, где тут пример, где цитата, а где уже моя ответственность.',
        ].join('\n');
    }

    const latest = meaningful[meaningful.length - 1];
    if (meaningful.length === 1) {
        return [
            'Приходит бот на второй день в командный чат и говорит:',
            `- Я перечитал вчерашнее «${latest}» и почти всё понял.`,
            'Команда спрашивает:',
            '- А что значит "почти"?',
            'Бот отвечает:',
            '- Это значит, что я уже знаю, где нужна помощь, но всё ещё рад, когда мне подписывают примеры и цитаты.',
        ].join('\n');
    }

    return [
        'Приходит бот на второй день в командный чат и говорит:',
        `- За последние сутки я увидел ${meaningful.length} рабочих реплик и особенно запомнил: «${latest}».`,
        'Команда спрашивает:',
        '- И какой вывод?',
        'Бот отвечает:',
        '- Если вы пишете три сообщения подряд, я считаю это не хаосом, а распределённой постановкой задачи. Но всё равно лучше одной понятной фразой.',
    ].join('\n');
}

function buildDayTwoOnboardingMessage(spaceId: string): string {
    const joke = buildRecentWorkJoke(getRecentHumanWorkMessages(spaceId));

    return [
        'Второй день я с вами в команде! Мы тут потихоньку с вами учимся работать вместе, и это не всегда просто.',
        '',
        'Пара советов из README, чтобы мне было легче быть полезным:',
        'Пишите важное в правильный space: так я не смешиваю контекст разных чатов, проектов и каналов.',
        'Если нужен другой стиль работы, можно менять pack: он отвечает за голос, навыки, политики и регулярные задачи.',
        'Устойчивые правила и факты лучше проговаривать явно: grounding хранит стабильное, memory - то, что меняется по ходу работы.',
        'Формулируйте вопросы ко мне четко и давайте немного подумать - если вы пошлете три сообщения подряд, я могу запутаться. Если в сообщении пример или цитата, то скажите об этом, иначе я могу решить, что это вы пишете коллегами мне.',
        '',
        'Не стесняйтесь задавать мне вопросы и прямо просить корректировать поведение: тон, краткость, инициативность, формат сводок.',
        joke,
    ].join('\n');
}

function computeOnboardingState(spaceId: string): {
    active: boolean;
    ageDays: number;
    memoryDensity: number;
    knownParticipants: number;
    unknownParticipants: string[];
} {
    const space = getSpace(spaceId);
    const policy = resolveSpacePolicy(spaceId);

    if (policy.onboarding_complete === true || !space?.created_at) {
        return { active: false, ageDays: -1, memoryDensity: 0, knownParticipants: 0, unknownParticipants: [] };
    }

    const ageMs = Date.now() - new Date(space.created_at).getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    const spaceMemory = getMemoryEntries('space', spaceId, undefined, 50);
    const workMemory = getMemoryEntries('work', spaceId, undefined, 50);
    const density = spaceMemory.length + workMemory.length;

    const participants = getSpaceParticipants(spaceId);
    const participantIds = participants.map((p) => p.person_id || p.tg_id).filter(Boolean);
    const directContactIds = new Set(
        space?.channel ? getDirectContactStatuses(space.channel, participantIds).map((status) => status.person_id) : []
    );
    const unknownParticipants: string[] = [];
    let knownCount = 0;

    for (const p of participants) {
        const personId = p.person_id || p.tg_id;
        const personMemory = getMemoryEntries('person', personId, undefined, 5);
        const resident = getResident(personId);
        const hasHabits = Boolean(resident?.habits?.trim());
        const hasSpokenHere = Boolean(
            getDb()
                .prepare(
                    `
                SELECT 1 FROM messages
                WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ?
                  AND sender_tg_id = ?
                  AND is_bot = 0
                  AND content != '[ACCESS_DENIED_DIRECT_CONTACT]'
                LIMIT 1
            `
                )
                .get(spaceId, personId)
        );
        const hasDirectContact = directContactIds.has(personId);

        if (personMemory.length > 0 || hasHabits || hasSpokenHere || hasDirectContact) {
            knownCount++;
        } else {
            const name = resident?.nickname || resident?.display_name || resident?.username || personId;
            unknownParticipants.push(name);
        }
    }

    const totalDensity = density + knownCount;
    const active = ageDays <= ONBOARDING_MAX_AGE_DAYS && totalDensity < ONBOARDING_MEMORY_THRESHOLD;

    return {
        active,
        ageDays,
        memoryDensity: totalDensity,
        knownParticipants: knownCount,
        unknownParticipants,
    };
}

const skill: SkillManifest = {
    name: 'onboarding',
    description: 'Onboarding mode: track the assistant adaptation progress and manage the curiosity phase',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },

    tools: [
        {
            name: 'onboarding_status',
            description:
                'Show the current onboarding progress: how many days since the bot joined, how many facts it has learned, and which participants it still needs to get to know.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'onboarding_finish',
            description:
                'Manually finish the onboarding period. Only owners or admins can do this. The bot will stop asking curiosity questions and behave as a fully settled assistant.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
    ],

    handlers: {
        async onboarding_status(_: Record<string, never>, context?: ExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!spaceId) {
                return '[TOOL_RESULT] Onboarding status requires an active chat context.';
            }

            const state = computeOnboardingState(spaceId);

            if (!state.active) {
                return `[TOOL_RESULT] Onboarding is complete for this space. The assistant is fully settled.`;
            }

            const unknownList =
                state.unknownParticipants.length > 0
                    ? `\nParticipants I still need to learn about: ${state.unknownParticipants.join(', ')}`
                    : '\nAll participants have at least some recorded context.';

            return `[TOOL_RESULT] Onboarding status for ${spaceId}:
Day ${state.ageDays + 1} of ${ONBOARDING_MAX_AGE_DAYS}
Knowledge density: ${state.memoryDensity}/${ONBOARDING_MEMORY_THRESHOLD} facts
Known participants: ${state.knownParticipants}${unknownList}
Tip: Use memory_remember and resident_learn_habit to record new facts and speed up onboarding.`;
        },

        async onboarding_finish(_: Record<string, never>, context?: ExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!spaceId) {
                return '[TOOL_RESULT] Requires an active chat context.';
            }

            // Only users with can_change_policies can finish onboarding
            if (!context?.userId || !memberHasTrustFlag(spaceId, context.userId, 'can_change_policies')) {
                return '[TOOL_RESULT] Only owners or admins with policy-change rights can finish onboarding.';
            }

            const db = getDb();
            const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get(spaceId) as
                | { policy_json?: string }
                | undefined;
            const current = row?.policy_json ? JSON.parse(row.policy_json) : {};
            current.onboarding_complete = true;
            db.prepare('UPDATE spaces SET policy_json = ?, updated_at = ? WHERE id = ?').run(
                JSON.stringify(current),
                new Date().toISOString(),
                spaceId
            );

            logInfo('ONBOARDING', 'manually_finished', { space_id: spaceId, by: context?.userId });

            return '[TOOL_RESULT] Onboarding mode has been turned off for this space. The assistant will now behave as a fully settled member.';
        },
    },

    crons: [
        {
            expression: '0 10 * * *', // 10:00 daily
            description: 'Day-two onboarding coaching note',
            handler: async () => {
                const db = getDb();
                const cutoff = new Date(Date.now() - ONBOARDING_MAX_AGE_DAYS * ONE_DAY_MS).toISOString();

                const spaces = db
                    .prepare(`SELECT * FROM spaces WHERE status = 'ACTIVE' AND created_at >= ?`)
                    .all(cutoff) as any[];

                for (const space of spaces) {
                    if (!space.created_at || !space.external_ref) continue;

                    const policy = resolveSpacePolicy(space.id);
                    if (
                        policy.onboarding_complete === true ||
                        policy.tasks === false ||
                        hasDayTwoNoteBeenSent(policy) ||
                        !isSecondLocalOnboardingDay(space.created_at)
                    ) {
                        continue;
                    }

                    const state = computeOnboardingState(space.id);
                    if (!state.active) continue;

                    const message = buildDayTwoOnboardingMessage(space.id);

                    try {
                        const sendResult = await sendSpaceMessage(space.id, message);
                        if (!sendResult.success) {
                            logInfo('ONBOARDING', 'day_two_note_send_failed', {
                                space_id: space.id,
                                error: sendResult.error,
                            });
                            continue;
                        }

                        updateSpacePolicy(space.id, {
                            [ONBOARDING_DAY_TWO_NOTE_POLICY_KEY]: new Date().toISOString(),
                        });
                        logInfo('ONBOARDING', 'day_two_note_sent', { space_id: space.id });
                    } catch (err: any) {
                        logInfo('ONBOARDING', 'day_two_note_send_failed', {
                            space_id: space.id,
                            error: err.message,
                        });
                    }
                }
            },
        },
        {
            expression: '30 10 * * 1-5', // 10:30 weekdays
            description: 'Daily welcome check: introduce yourself to unknown participants',
            handler: async () => {
                const db = getDb();

                // Find all active spaces that are still in onboarding
                const spaces = db
                    .prepare(
                        `SELECT * FROM spaces WHERE status = 'ACTIVE' AND created_at >= datetime('now', '-${ONBOARDING_MAX_AGE_DAYS} days')`
                    )
                    .all() as any[];

                for (const space of spaces) {
                    if (space.kind !== 'group_chat') continue;
                    const policy = resolveSpacePolicy(space.id);
                    if (policy.onboarding_complete === true || policy.tasks === false) continue;

                    const state = computeOnboardingState(space.id);
                    if (!state.active || state.unknownParticipants.length === 0) continue;

                    // Pick one unknown participant per day to avoid spam
                    const targetName = state.unknownParticipants[0];

                    const channel = space.channel || 'telegram';
                    const channelRef = space.external_ref;
                    if (!channelRef) continue;

                    const message =
                        `Кстати, я ещё не успел познакомиться с ${targetName}. ` +
                        `${targetName}, напиши мне /start в личку, если хочешь, чтобы мы быстро синхронизировались без спама здесь. ` +
                        `Или просто расскажи тут в двух словах, за что ты отвечаешь!`;

                    try {
                        await sendChannelMessage(channel, channelRef, message);
                        logInfo('ONBOARDING', 'welcome_sent', {
                            space_id: space.id,
                            target: targetName,
                            remaining: state.unknownParticipants.length - 1,
                        });
                    } catch (err: any) {
                        logInfo('ONBOARDING', 'welcome_send_failed', {
                            space_id: space.id,
                            error: err.message,
                        });
                    }

                    // Notice: no break here so it processes all spaces, one ping per space.
                }
            },
        },
    ],
};

export default skill;
