import {
    buildSpaceId,
    buildTelegramSpaceId,
    getDb,
    getSpace,
    getSpaceParticipants,
    listTasks,
    storeMessage,
    updateSpaceAssistantPack,
    updateSpaceGroundingPack,
    updateSpacePolicy,
} from '../db';
import { resolveSpacePolicy } from './policy';
import { ensureActiveMemorySprint } from './memory-sprint';
import { rememberWorkMemory } from './memory-write';

async function getContextComposer() {
    return await import('./context-composer');
}

async function getLlmRuntime() {
    return await import('./llm');
}

export type JeevesMvpAction = 'brief' | 'focus' | 'review';

function formatActionPrompt(action: JeevesMvpAction): string {
    if (action === 'brief') {
        return `[SYSTEM PRODUCT REQUEST] Prepare an on-demand Jeeves personal briefing for the current space.
- Be concise, polished, and practical.
- Structure it in 3 short sections: Today, Pending, Watch-outs.
- Check reminders, todos, memory, and recent chat only if they materially improve the answer.
- If there is little to report, say so briefly and reassuringly.`;
    }

    if (action === 'focus') {
        return `[SYSTEM PRODUCT REQUEST] Prepare an on-demand Jeeves focus plan for the current space.
- Identify the 1-3 most useful next actions.
- Be decisive and concrete.
- Use reminders, todos, memory, and recent chat if they help.
- Avoid long explanations or fake urgency.`;
    }

    return `[SYSTEM PRODUCT REQUEST] Prepare an on-demand Jeeves evening review for the current space.
- Be brief, elegant, and calm.
- Summarize what appears done, what remains open, and what tomorrow should not forget.
- Use reminders, todos, memory, and recent chat if they help.
- If the day was quiet, say so plainly.`;
}

function ensureJeevesSpace(spaceId: string): { ok: true } | { ok: false; message: string } {
    const space = getSpace(spaceId);
    if (!space) {
        return { ok: false, message: 'This space is not initialized yet.' };
    }

    if (space.assistant_pack_id !== 'jeeves') {
        return {
            ok: false,
            message: `This space is currently using pack "${space.assistant_pack_id}". Use /jeeves setup to switch it to Jeeves.`,
        };
    }

    return { ok: true };
}

export function getJeevesMvpStatusForSpace(spaceId: string): string {
    const space = getSpace(spaceId);
    if (!space) {
        return 'This space is not initialized yet. Send a message first, or use /jeeves setup.';
    }

    const policy = resolveSpacePolicy(spaceId);
    const sprint = ensureActiveMemorySprint(spaceId);
    const participants = getSpaceParticipants(spaceId);
    const activeTasks = listTasks(spaceId, 'active');
    const systemTasks = activeTasks.filter((task) => task.created_by === 'system');
    const customTasks = activeTasks.filter((task) => task.created_by !== 'system');

    const db = getDb();
    const pendingTodos = (() => {
        try {
            return (
                db
                    .prepare(
                        `
                SELECT COUNT(*) as cnt
                FROM todos
                WHERE space_id = ? AND status = 'pending'
            `
                    )
                    .get(spaceId) as { cnt: number }
            ).cnt;
        } catch {
            return 0;
        }
    })();
    const pendingReminders = (
        db
            .prepare(
                `
        SELECT COUNT(*) as cnt FROM reminders
        WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ? AND status = 'pending'
    `
            )
            .get(spaceId) as { cnt: number }
    ).cnt;

    const packLine =
        space.assistant_pack_id === 'jeeves'
            ? 'Pack: jeeves'
            : `Pack: ${space.assistant_pack_id} (use /jeeves setup to switch)`;

    return [
        'PA Jeeves MVP',
        packLine,
        `Space: ${spaceId}`,
        `Grounding: ${space.grounding_pack_id || 'jeeves_personal'}`,
        `Participants: ${participants.length}`,
        `Pending: ${pendingTodos} todos, ${pendingReminders} reminders`,
        `Scheduled tasks: ${activeTasks.length} active (${systemTasks.length} system, ${customTasks.length} custom)`,
        `Memory sprint: ${sprint.opened_at.substring(0, 10)} -> ${sprint.closes_at.substring(0, 10)} (${sprint.cadence_days} days)`,
        `Workspace: ${policy.workspace_path || 'none'}`,
        'Quick actions: /brief, /focus, /review, /audit, /plan, /research, /handoff, /jeeves setup',
    ].join('\n');
}

export function getJeevesMvpStatus(chatId: string): string {
    return getJeevesMvpStatusForSpace(buildTelegramSpaceId(chatId));
}

export async function applyJeevesDefaultsForSpace(spaceId: string): Promise<string> {
    const space = getSpace(spaceId);
    if (!space) {
        return 'This space is not initialized yet. Send a message first and try again.';
    }

    updateSpaceAssistantPack(spaceId, 'jeeves');
    updateSpaceGroundingPack(spaceId, 'jeeves_personal');
    updateSpacePolicy(spaceId, {
        browser: true,
        tasks: true,
        memory_sprint_days: 7,
    });
    const { ensureDefaultAssistantTasksForSpace, registerScheduledTasks } = await import('./tasks');
    ensureDefaultAssistantTasksForSpace(spaceId);
    const registered = registerScheduledTasks();

    return `Jeeves defaults are active for ${spaceId}.
- pack: jeeves
- grounding: jeeves_personal
- browser: true
- tasks: true
- memory_sprint_days: 7
Scheduled assistant tasks registered: ${registered}.`;
}

export async function applyJeevesDefaults(chatId: string): Promise<string> {
    return applyJeevesDefaultsForSpace(buildTelegramSpaceId(chatId));
}

export async function runJeevesMvpActionForSpace(args: {
    spaceId: string;
    channel: string;
    channelRef: string;
    senderId: string;
    action: JeevesMvpAction;
}): Promise<string> {
    const { spaceId, channel, channelRef, senderId, action } = args;
    const guard = ensureJeevesSpace(spaceId);
    if (!guard.ok) {
        return guard.message;
    }

    const { composeConversationContext } = await getContextComposer();
    const { processWithLLM } = await getLlmRuntime();
    const { llmMessages } = composeConversationContext({
        spaceId,
        senderId,
        channelRef,
    });

    const response = await processWithLLM([...llmMessages, { role: 'user', content: formatActionPrompt(action) }], {
        chatId: channelRef,
        userId: senderId,
        spaceId,
        channel,
        channelRef,
    });

    const text = response.text?.trim();
    if (!text) {
        return 'Jeeves had nothing useful to say just now.';
    }

    storeMessage({
        id: `bot-jeeves-${channel}-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        space_id: spaceId,
        channel_ref: channelRef,
        sender_id: 'jivs',
        content: text,
        timestamp: new Date().toISOString(),
        is_bot: 1,
    });

    rememberWorkMemory(spaceId, `jeeves_${action}`, `Generated ${action} note: ${text.substring(0, 240)}`, {
        salience: 0.45,
        source: 'jeeves_mvp',
    });

    return text;
}

export async function runJeevesMvpAction(args: {
    chatId: string;
    senderId: string;
    action: JeevesMvpAction;
}): Promise<string> {
    const { chatId, senderId, action } = args;
    return runJeevesMvpActionForSpace({
        spaceId: buildSpaceId('telegram', chatId),
        channel: 'telegram',
        channelRef: chatId,
        senderId,
        action,
    });
}
