import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    getDb,
    getMemoryEntries,
    getRecentMessagesForSpace,
    memberHasTrustFlag,
    getSpaceParticipants,
    getResident,
} from '../db';
import { resolveSpacePolicy } from '../core/policy';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { logInfo, logWarn } from '../utils/logging';
import {
    configureRitualForSpace,
    describeRitualSchedule,
    listRitualsForSpace,
    RITUAL_KEYS,
    RITUAL_WEEKDAYS,
    RitualKey,
    RitualSummary,
    runRitualForSpace,
} from '../core/rituals';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requireRitualAuthority(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] Ritual management requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] Ritual management requires an active chat context.' };
    }

    const policy = resolveSpacePolicy(spaceId);
    if (!policy.tasks) {
        return {
            ok: false,
            message: '[TOOL_RESULT] Rituals are disabled because scheduled tasks are off in this space.',
        };
    }

    if (!memberHasTrustFlag(spaceId, context.userId, 'can_assign_tasks')) {
        return { ok: false, message: '[TOOL_RESULT] You do not have permission to manage rituals in this space.' };
    }

    return { ok: true, spaceId };
}

function formatRitualLine(ritual: RitualSummary): string {
    const lastRun = ritual.last_run_at ? `; last run ${ritual.last_run_at.substring(0, 16).replace('T', ' ')}` : '';

    return `- ${ritual.key}
  ${ritual.title}
  ${describeRitualSchedule(ritual.schedule_value, ritual.frequency)}; status: ${ritual.status}${lastRun}`;
}

const skill: SkillManifest = {
    name: 'rituals',
    description: 'Manage simple day and week rituals like morning briefings, evening reviews, and weekly resets',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'policy',
        policy_gate: 'tasks',
        required_trust_flag: 'can_assign_tasks',
        pack_tags: ['jeeves', 'office'],
    },
    tools: [
        {
            name: 'ritual_list',
            description: 'List the available day/week rituals for the current space and their schedules.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'ritual_configure',
            description: 'Configure a ritual by key using a simple local time and optional weekday for weekly rituals.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    ritual_key: {
                        type: Type.STRING,
                        enum: [...RITUAL_KEYS],
                        description: 'Which ritual to configure.',
                    },
                    enabled: {
                        type: Type.BOOLEAN,
                        description: 'Whether the ritual should stay active.',
                    },
                    time_local: {
                        type: Type.STRING,
                        description: 'Optional HH:MM local time in 24-hour format.',
                    },
                    weekday: {
                        type: Type.STRING,
                        enum: [...RITUAL_WEEKDAYS],
                        description: 'Optional weekday override for weekly rituals.',
                    },
                },
                required: ['ritual_key'],
            },
        },
        {
            name: 'ritual_run_now',
            description: 'Run one of the configured rituals immediately.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    ritual_key: {
                        type: Type.STRING,
                        enum: [...RITUAL_KEYS],
                        description: 'Which ritual to run now.',
                    },
                },
                required: ['ritual_key'],
            },
        },
    ],
    handlers: {
        async ritual_list(_: Record<string, never>, context?: ExecutionContext) {
            const access = requireRitualAuthority(context);
            if (!access.ok) return access.message;

            const rituals = listRitualsForSpace(access.spaceId);
            if (rituals.length === 0) {
                return '[TOOL_RESULT] No day/week rituals are defined for this space yet.';
            }

            return `[TOOL_RESULT] Rituals for ${access.spaceId}:\n${rituals.map(formatRitualLine).join('\n')}`;
        },

        async ritual_configure(
            args: {
                ritual_key: RitualKey;
                enabled?: boolean;
                time_local?: string;
                weekday?: (typeof RITUAL_WEEKDAYS)[number];
            },
            context?: ExecutionContext
        ) {
            const access = requireRitualAuthority(context);
            if (!access.ok) return access.message;

            try {
                const ritual = configureRitualForSpace(access.spaceId, args.ritual_key, {
                    enabled: args.enabled,
                    time_local: args.time_local,
                    weekday: args.weekday,
                });
                return `[TOOL_RESULT] Ritual "${ritual.title}" updated.
Schedule: ${describeRitualSchedule(ritual.schedule_value, ritual.frequency)}
Status: ${ritual.status}`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },

        async ritual_run_now(args: { ritual_key: RitualKey }, context?: ExecutionContext) {
            const access = requireRitualAuthority(context);
            if (!access.ok) return access.message;

            try {
                const ritual = await runRitualForSpace(access.spaceId, args.ritual_key);
                return `[TOOL_RESULT] Ritual "${ritual.title}" ran successfully.`;
            } catch (error: any) {
                return `[TOOL_RESULT] ${error.message}`;
            }
        },
    },

    crons: [
        {
            expression: '0 16 * * 1-5', // 16:00 weekdays
            description: 'Knowledge Gap Audit for onboarding spaces',
            handler: async () => {
                const db = getDb();
                const ONBOARDING_MAX_AGE_DAYS = 14;
                const ONBOARDING_MEMORY_THRESHOLD = 15;

                const spaces = db
                    .prepare(
                        `SELECT * FROM spaces WHERE status = 'ACTIVE' AND created_at >= datetime('now', '-${ONBOARDING_MAX_AGE_DAYS} days')`
                    )
                    .all() as any[];

                for (const space of spaces) {
                    const policy = resolveSpacePolicy(space.id);
                    if (policy.onboarding_complete === true || policy.tasks === false) continue;

                    const spaceMemory = getMemoryEntries('space', space.id, undefined, 50);
                    const workMemory = getMemoryEntries('work', space.id, undefined, 50);
                    let personDensity = 0;
                    const participants = getSpaceParticipants(space.id);
                    for (const p of participants) {
                        const id = p.person_id || p.tg_id;
                        const mems = getMemoryEntries('person', id, undefined, 5);
                        const res = getResident(id);
                        if (mems.length > 0 || Boolean(res?.habits?.trim())) personDensity++;
                    }

                    const density = spaceMemory.length + workMemory.length + personDensity;
                    if (density >= ONBOARDING_MEMORY_THRESHOLD) continue;

                    const recentMessages = getRecentMessagesForSpace(space.id, 20);
                    if (recentMessages.length === 0) continue;

                    const messagesText = recentMessages
                        .map((m: any) => `${m.is_bot ? '[Bot]' : '[User]'}: ${m.content}`)
                        .join('\n');

                    const memoryText =
                        [...spaceMemory, ...workMemory].map((e: any) => `[${e.kind}] ${e.content}`).join('\n') ||
                        'No memory entries yet.';

                    const today = new Date().toLocaleDateString('en-GB', {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                    });

                    const ageMs = Date.now() - new Date(space.created_at).getTime();
                    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

                    const prompt = `TODAY IS ${today}.
You are analyzing a workspace where the assistant is in onboarding mode (day ${ageDays + 1}).
Pack type: ${space.assistant_pack_id || 'jeeves'}

Current knowledge base:
${memoryText}

Recent conversation:
${messagesText}

Task: Identify the single most important organizational blind spot
that would cause the assistant to make a mistake or miss context.
Output exactly:
- gap: one-sentence description of the blind spot
- action: either "search:{query}" if the assistant should look it up online,
  or "ask:{question}" if only a human can answer`;

                    try {
                        const { processWithLLM } = await import('../core/llm');
                        const result = await processWithLLM(
                            [
                                {
                                    role: 'system',
                                    content:
                                        'You are an onboarding analyst. Identify organizational blind spots concisely. Reply ONLY with the gap and action lines, nothing else.',
                                },
                                { role: 'user', content: prompt },
                            ],
                            {
                                chatId: space.external_ref,
                                userId: 'system_cron',
                                spaceId: space.id,
                                channel: space.channel || 'telegram',
                                channelRef: space.external_ref,
                            }
                        );

                        const responseText = result.text || '';
                        const askMatch = responseText.match(/action:\s*ask:\s*(.+)/i);

                        if (askMatch) {
                            const question = askMatch[1].trim();
                            const channel = space.channel || 'telegram';
                            const channelRef = space.external_ref;
                            if (channelRef) {
                                const { sendChannelMessage } = await import('../channels/runtime');
                                await sendChannelMessage(
                                    channel,
                                    channelRef,
                                    `Пока выстраиваю карту рабочего процесса: ${question}`
                                );
                                logInfo('ONBOARDING', 'knowledge_gap_asked', {
                                    space_id: space.id,
                                    question,
                                });
                            }
                        } else {
                            logInfo('ONBOARDING', 'knowledge_gap_search_suggested', {
                                space_id: space.id,
                                response: responseText.substring(0, 200),
                            });
                        }
                    } catch (err: any) {
                        logWarn('ONBOARDING', 'knowledge_gap_audit_failed', {
                            space_id: space.id,
                            error: err.message,
                        });
                    }
                }
            },
        },
    ],
};

export default skill;
