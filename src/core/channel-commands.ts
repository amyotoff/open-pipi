import {
    buildSpaceId,
    clearMessagesForSpace,
    ensureSpace,
    ensureSpaceMembership,
    getDailyTokenCost,
    getSpace,
    getRecentMessagesForSpace,
    getResident,
    storeMessage,
    updateSpacePolicy,
    upsertResident,
} from '../db';
import { RUNTIME_PLATFORM, isOwner } from '../config';
import { rememberWorkMemory } from './memory-write';
import {
    applyJeevesDefaultsForSpace,
    getJeevesMvpStatusForSpace,
    JeevesMvpAction,
    runJeevesMvpActionForSpace,
} from './jeeves-mvp';
import { createHandoffArtifactForSpace, resumeFromHandoffForSpace } from './handoff';
import { processWithOllama } from './ollama';
import { materializeGroundingForSpace } from './grounding-loader';
import { getSpaceGroundingLevel } from '../db';
import { getHealthState, getSystemMetrics } from './healthcheck';
import { buildChannelPersonId } from '../channels/runtime';
import { getRegisteredHandlers } from '../skills/_registry';
import { runWorkLensForSpace, WorkLens } from './work-lenses';
import { resolveSpaceOperationalSettings } from './space-preferences';

export type SupportedChannelCommand =
    | 'start'
    | 'jeeves'
    | 'brief'
    | 'focus'
    | 'review'
    | 'audit'
    | 'plan'
    | 'research'
    | 'handoff'
    | 'resume'
    | 'today'
    | 'yesterday'
    | 'week'
    | 'status'
    | 'dashboard'
    | 'clear'
    | 'reset'
    | 'finish_onboarding'
    | 'onboarding_status';

type ParsedChannelCommand = {
    name: string;
    argsText: string;
};

export type ChannelCommandExecutionContext = {
    channel: string;
    channelRef: string;
    senderId: string;
    senderUsername?: string | null;
    senderDisplayName?: string | null;
    isDirect: boolean;
    rawText: string;
    reply: (text: string) => Promise<void>;
    sendTyping?: () => Promise<void>;
};

const SUPPORTED_COMMANDS = new Set<SupportedChannelCommand>([
    'start',
    'jeeves',
    'brief',
    'focus',
    'review',
    'audit',
    'plan',
    'research',
    'handoff',
    'resume',
    'today',
    'yesterday',
    'week',
    'status',
    'dashboard',
    'clear',
    'reset',
    'finish_onboarding',
    'onboarding_status',
]);

function buildStartMessage(spaceId: string): string {
    const settings = resolveSpaceOperationalSettings(getSpace(spaceId)?.policy_json);

    if (settings.onboarding_state === 'new') {
        return 'Hi. This space is not configured yet.\nUse /setup or go straight to /setup apply.';
    }

    const grounding = materializeGroundingForSpace(spaceId);
    const level = getSpaceGroundingLevel(spaceId);
    const isRussian = grounding.default_language === 'ru';

    if (level > 0) {
        return isRussian ? 'Привет. Слушаю.' : 'Hi. Ready when you are.';
    }

    const description = grounding.description || grounding.title;
    if (isRussian) {
        return `Привет. Я Скрепыш — ${description}.\nГовори что нужно: задача, напоминание, вопрос, мысль вслух.`;
    }
    return `Hi. I'm Skrepysh — ${description}.\nTell me what you need: a task, reminder, question, or just think out loud.`;
}
const UNKNOWN_COMMAND_MESSAGE =
    'Supported commands: /start, /jeeves, /brief, /focus, /review, /audit, /plan, /research, /handoff, /resume, /today, /yesterday, /week, /status, /dashboard, /clear, /reset, /finish_onboarding, /onboarding_status';

export function parseChannelCommand(rawText: string): ParsedChannelCommand | null {
    const text = rawText.trim();
    if (!text.startsWith('/')) return null;

    const [head, ...rest] = text.split(/\s+/);
    const normalized = head.slice(1).toLowerCase().split('@')[0];
    return {
        name: normalized,
        argsText: rest.join(' ').trim(),
    };
}

function ensureOwnerAccess(context: ChannelCommandExecutionContext): boolean {
    return isOwner(context.senderId, context.channel);
}

function ensureSpaceCommandContext(context: ChannelCommandExecutionContext): {
    spaceId: string;
    personId: string;
} | null {
    if (!ensureOwnerAccess(context)) {
        return null;
    }

    const personId = buildChannelPersonId(context.channel, context.senderId);
    const existingResident = getResident(personId);
    const residentRole = existingResident?.role || 'owner';

    upsertResident({
        tg_id: personId,
        username: context.senderUsername ?? existingResident?.username ?? null,
        display_name: context.senderDisplayName ?? existingResident?.display_name ?? null,
        role: residentRole,
    });

    ensureSpace(context.channel, context.channelRef, {
        kind: context.isDirect ? 'direct_chat' : 'group_chat',
        title: context.channelRef,
    });
    const spaceId = buildSpaceId(context.channel, context.channelRef);
    ensureSpaceMembership(spaceId, personId, 'owner');

    return { spaceId, personId };
}

function recordDeniedDirectContact(context: ChannelCommandExecutionContext): void {
    if (!context.isDirect) return;

    const personId = buildChannelPersonId(context.channel, context.senderId);
    const existingResident = getResident(personId);
    upsertResident({
        tg_id: personId,
        username: context.senderUsername ?? existingResident?.username ?? null,
        display_name: context.senderDisplayName ?? existingResident?.display_name ?? null,
        role: existingResident?.role || 'member',
    });

    ensureSpace(context.channel, context.channelRef, {
        kind: 'direct_chat',
        title: context.channelRef,
    });
    const spaceId = buildSpaceId(context.channel, context.channelRef);
    ensureSpaceMembership(spaceId, personId, existingResident?.role || 'member');
    storeMessage({
        id: `${spaceId}:denied-command:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        space_id: spaceId,
        channel_ref: context.channelRef,
        sender_id: personId,
        content: '[ACCESS_DENIED_DIRECT_CONTACT]',
        timestamp: new Date().toISOString(),
        is_bot: 0,
    });
}

async function runStatusCommand(context: ChannelCommandExecutionContext): Promise<void> {
    const state = getHealthState();
    const m = getSystemMetrics();
    const daily = getDailyTokenCost();

    const svc = [
        `${state.gemini ? 'OK' : 'DOWN'} Gemini`,
        `${state.ollama ? 'OK' : 'DOWN'} Ollama`,
        `${state.internet ? 'OK' : 'DOWN'} Internet`,
    ];
    if (state.killswitch) svc.push('KILLSWITCH');
    if (!state.throttle_ok) svc.push('UNDERVOLT');
    if (!state.sdcard_ok) svc.push('SD ERR');

    const swap = m.swapTotalMB > 0 ? `\nSwap ${m.swapUsedMB}/${m.swapTotalMB} MB` : '';
    const hw = `CPU ${m.tempC.toFixed(1)}C\nRAM ${m.ramUsedMB}/${m.ramTotalMB} MB (${m.ramPercent}%)${swap}\nDisk ${m.diskPercent}%\nUptime ${m.uptime}`;
    const tokens = `$${daily.cost_usd.toFixed(2)} / ${daily.calls} calls\nIn ${daily.input_tokens.toLocaleString()} Out ${daily.output_tokens.toLocaleString()}`;

    await context.reply(
        [
            'Jeeves Status',
            '____________________',
            svc.join(' | '),
            '',
            `Platform: ${RUNTIME_PLATFORM}`,
            hw,
            '',
            'Tokens today',
            tokens,
        ].join('\n')
    );
}

async function runClearCommand(context: ChannelCommandExecutionContext): Promise<void> {
    const ensured = ensureSpaceCommandContext(context);
    if (!ensured) return;

    await context.reply('Saving a short summary of the conversation...');

    try {
        const messages = getRecentMessagesForSpace(ensured.spaceId, 30) as any[];
        if (messages.length >= 5) {
            const transcript = messages
                .map((message: any) => {
                    const role = message.is_bot ? 'Jeeves' : 'User';
                    const text = message.content?.substring(0, 200) || '';
                    return `${role}: ${text}`;
                })
                .join('\n');

            const result = await processWithOllama(
                `Write a short summary of this conversation in 3-4 sentences. Capture the main topics, requests, and decisions.\n\n${transcript}`,
                'You are Jeeves. Write briefly, clearly, and without markdown.'
            );

            const summary = result.text?.trim();
            if (summary && summary.length > 20) {
                rememberWorkMemory(ensured.spaceId, 'recollection', `[Conversation archive before clear] ${summary}`, {
                    salience: 0.55,
                    source: 'chat_clear',
                });
            }
        }
    } catch (error: any) {
        console.warn(`[RESET] Summary generation failed: ${error.message}`);
    }

    clearMessagesForSpace(ensured.spaceId);
    await context.reply('Context cleared. We begin again with a clean slate.');
}

async function runJeevesSetupOrStatus(context: ChannelCommandExecutionContext, argsText: string): Promise<void> {
    const ensured = ensureSpaceCommandContext(context);
    if (!ensured) return;

    const firstArg = argsText.split(/\s+/).filter(Boolean)[0]?.toLowerCase();
    const result =
        firstArg === 'setup'
            ? await applyJeevesDefaultsForSpace(ensured.spaceId)
            : getJeevesMvpStatusForSpace(ensured.spaceId);

    if (firstArg === 'setup') {
        updateSpacePolicy(ensured.spaceId, {
            onboarding_state: 'active',
            setup_version: 1,
        });
    }

    await context.reply(result);
}

async function runJeevesActionCommand(context: ChannelCommandExecutionContext, action: JeevesMvpAction): Promise<void> {
    const ensured = ensureSpaceCommandContext(context);
    if (!ensured) return;

    if (context.sendTyping) {
        await context.sendTyping();
    }

    const result = await runJeevesMvpActionForSpace({
        spaceId: ensured.spaceId,
        channel: context.channel,
        channelRef: context.channelRef,
        senderId: ensured.personId,
        action,
    });
    await context.reply(result);
}

async function runWorkLensCommand(
    context: ChannelCommandExecutionContext,
    lens: WorkLens,
    requestText: string
): Promise<void> {
    const ensured = ensureSpaceCommandContext(context);
    if (!ensured) return;

    if (context.sendTyping) {
        await context.sendTyping();
    }

    const result = await runWorkLensForSpace({
        spaceId: ensured.spaceId,
        channel: context.channel,
        channelRef: context.channelRef,
        senderId: ensured.personId,
        lens,
        requestText,
    });
    await context.reply(result);
}

async function runHandoffCommand(context: ChannelCommandExecutionContext, mode: 'handoff' | 'resume'): Promise<void> {
    const ensured = ensureSpaceCommandContext(context);
    if (!ensured) return;

    const artifact =
        mode === 'handoff'
            ? createHandoffArtifactForSpace(ensured.spaceId)
            : resumeFromHandoffForSpace(ensured.spaceId);
    await context.reply(artifact.ref);
}

async function runJournalCommand(
    context: ChannelCommandExecutionContext,
    range: 'today' | 'yesterday' | 'week'
): Promise<void> {
    const ensured = ensureSpaceCommandContext(context);
    if (!ensured) return;

    const handlers = getRegisteredHandlers();
    const result = handlers.journal_view
        ? await handlers.journal_view(
              {
                  range,
              },
              {
                  spaceId: ensured.spaceId,
                  userId: ensured.personId,
                  channel: context.channel,
                  channelRef: context.channelRef,
                  chatId: context.channel === 'telegram' ? context.channelRef : undefined,
              }
          )
        : '[TOOL_RESULT] Journal view is not available.';

    await context.reply(result.replace('[TOOL_RESULT] ', ''));
}

export async function executeChannelCommand(context: ChannelCommandExecutionContext): Promise<boolean> {
    const parsed = parseChannelCommand(context.rawText);
    if (!parsed) return false;

    const commandName = parsed.name as SupportedChannelCommand;
    if (!SUPPORTED_COMMANDS.has(commandName)) {
        if (ensureOwnerAccess(context)) {
            await context.reply(UNKNOWN_COMMAND_MESSAGE);
        } else if (context.isDirect) {
            recordDeniedDirectContact(context);
            await context.reply('Sorry. I only work with approved users.');
        }
        return true;
    }

    if (!ensureOwnerAccess(context)) {
        if (context.isDirect) {
            recordDeniedDirectContact(context);
            await context.reply('Sorry. I only work with approved users.');
        }
        return true;
    }

    if (commandName === 'start') {
        if (context.isDirect) {
            const ensured = ensureSpaceCommandContext(context);
            if (!ensured) return true;
            await context.reply(buildStartMessage(ensured.spaceId));
        }
        return true;
    }

    if (commandName === 'jeeves') {
        await runJeevesSetupOrStatus(context, parsed.argsText);
        return true;
    }

    if (commandName === 'brief' || commandName === 'focus' || commandName === 'review') {
        await runJeevesActionCommand(context, commandName);
        return true;
    }

    if (commandName === 'audit' || commandName === 'plan' || commandName === 'research') {
        // /audit is the user-facing command; it maps to the 'review' lens internally
        // (the lens was named 'review' first; 'audit' avoids collision with /review = Jeeves evening review)
        await runWorkLensCommand(context, commandName === 'audit' ? 'review' : commandName, parsed.argsText);
        return true;
    }

    if (commandName === 'handoff' || commandName === 'resume') {
        await runHandoffCommand(context, commandName);
        return true;
    }

    if (commandName === 'today' || commandName === 'yesterday' || commandName === 'week') {
        await runJournalCommand(context, commandName);
        return true;
    }

    if (commandName === 'status' || commandName === 'dashboard') {
        await runStatusCommand(context);
        return true;
    }

    if (commandName === 'clear' || commandName === 'reset') {
        await runClearCommand(context);
        return true;
    }

    if (commandName === 'finish_onboarding') {
        const ensured = ensureSpaceCommandContext(context);
        if (!ensured) return true;
        const handlers = getRegisteredHandlers();
        if (handlers.onboarding_finish) {
            const result = await handlers.onboarding_finish(
                {},
                {
                    spaceId: ensured.spaceId,
                    userId: ensured.personId,
                    channel: context.channel,
                    channelRef: context.channelRef,
                    chatId: context.channel === 'telegram' ? context.channelRef : undefined,
                }
            );
            await context.reply(result.replace('[TOOL_RESULT] ', ''));
        } else {
            await context.reply('Onboarding skill is not loaded.');
        }
        return true;
    }

    if (commandName === 'onboarding_status') {
        const ensured = ensureSpaceCommandContext(context);
        if (!ensured) return true;
        const handlers = getRegisteredHandlers();
        if (handlers.onboarding_status) {
            const result = await handlers.onboarding_status(
                {},
                {
                    spaceId: ensured.spaceId,
                    userId: ensured.personId,
                    channel: context.channel,
                    channelRef: context.channelRef,
                    chatId: context.channel === 'telegram' ? context.channelRef : undefined,
                }
            );
            await context.reply(result.replace('[TOOL_RESULT] ', ''));
        } else {
            await context.reply('Onboarding skill is not loaded.');
        }
        return true;
    }

    return false;
}
