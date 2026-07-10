/**
 * Telegram command handlers — every bot.command()/bot.action() registration.
 *
 * Registers on the shared bot instance at import time. The ./telegram facade
 * imports this module BEFORE registering the catch-all message handlers, so
 * command middleware keeps precedence.
 */

import { Markup } from 'telegraf';
import { HOUSEHOLD_CHAT_ID, isOwner } from '../config';
import {
    buildTelegramSpaceId,
    ensureSpaceMembership,
    ensureTelegramSpace,
    getResident,
    upsertResident,
    logEvent,
} from '../db';
import {
    generateGoogleAuthUrl,
    getGoogleAuthStatus,
    isGoogleOAuthConfigured,
    revokeGoogleOAuthTokens,
} from '../core/google-oauth';
import { executeChannelCommand } from '../core/channel-commands';
import { MEMBERS_USAGE, parseMembersCommandRequest } from './members-command';
import {
    runApprovalTelegramCommand,
    runBackupTelegramCommand,
    runChannelTelegramCommand,
    runPackTelegramCommandAsync,
    runSetupTelegramCommand,
    stripToolResultPrefix,
} from './operator-commands';
import { bot } from './telegram-bot';
import { buildTelegramHelpMessage, TELEGRAM_SETUP_ACTIONS } from './telegram-menu';
import { sendMessageToChat, sendTypingAction } from './telegram-send';

type ReplyTarget = {
    personId: string;
    username: string | null;
    displayName: string | null;
};

function buildSetupKeyboard() {
    return Markup.inlineKeyboard(
        TELEGRAM_SETUP_ACTIONS.map((action) => Markup.button.callback(action.label, action.callbackData))
    );
}

function getReplyTarget(message: any): ReplyTarget | null {
    const from = message?.reply_to_message?.from;
    if (!from?.id) return null;

    return {
        personId: String(from.id),
        username: from.username || null,
        displayName: from.first_name || from.username || null,
    };
}

function ensureReplyTargetMembership(chatId: string, chatType: string | undefined, replyTarget: ReplyTarget): void {
    const existingResident = getResident(replyTarget.personId);
    const residentRole = existingResident?.role || (isOwner(replyTarget.personId) ? 'owner' : 'member');
    const membershipRole = isOwner(replyTarget.personId) ? 'owner' : 'member';

    upsertResident({
        tg_id: replyTarget.personId,
        username: replyTarget.username ?? existingResident?.username ?? null,
        display_name: replyTarget.displayName ?? existingResident?.display_name ?? null,
        role: residentRole,
    });
    ensureTelegramSpace(chatId, chatType || 'private', chatId);
    ensureSpaceMembership(buildTelegramSpaceId(chatId), replyTarget.personId, membershipRole);
}

async function runSharedTelegramCommand(ctx: any): Promise<void> {
    const chatId = ctx.chat?.id?.toString();
    const senderId = ctx.from?.id?.toString();
    if (!chatId || !senderId) return;

    await executeChannelCommand({
        channel: 'telegram',
        channelRef: chatId,
        senderId,
        senderUsername: ctx.from?.username ?? null,
        senderDisplayName: ctx.from?.first_name ?? null,
        isDirect: ctx.chat?.type === 'private',
        rawText: ((ctx.message as any)?.text || '').trim(),
        reply: async (text) => {
            await ctx.reply(text);
        },
        sendTyping: async () => {
            await sendTypingAction(chatId);
        },
    });
}

// ==========================================
// Command handlers (the hamburger menu exposes only a curated subset)
// ==========================================

// /start — greet residents
bot.command('start', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('help', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const advanced = /^\/help(?:@\w+)?\s+advanced\b/i.test(text);
    await ctx.reply(buildTelegramHelpMessage(advanced));
});

// /jeeves — personal assistant status and lightweight setup (owners only)
bot.command('jeeves', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('brief', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('focus', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('review', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('audit', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('plan', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('research', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('handoff', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('resume', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('today', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('yesterday', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('week', async (ctx) => {
    await runSharedTelegramCommand(ctx);
});

bot.command('status', runSharedTelegramCommand);
bot.command('dashboard', runSharedTelegramCommand);
bot.command('capture', runSharedTelegramCommand);
bot.command('inbox', runSharedTelegramCommand);
bot.command('drop', runSharedTelegramCommand);
bot.command('link', runSharedTelegramCommand);

bot.command('setup', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const result = await runSetupTelegramCommand({
        chatId,
        chatType: ctx.chat?.type,
        userId: senderId,
        text,
    });
    const isSetupHome = /^\/setup(?:@\w+)?\s*$/i.test(text);
    await ctx.reply(stripToolResultPrefix(result), isSetupHome ? buildSetupKeyboard() : undefined);
});

bot.action(/^setup:(apply|status)$/, async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) {
        await ctx.answerCbQuery('This action is available only to the owner.');
        return;
    }

    const action = ctx.match[1];
    const result = await runSetupTelegramCommand({
        chatId,
        chatType: ctx.chat?.type,
        userId: senderId,
        text: `/setup ${action}`,
    });
    await ctx.answerCbQuery(action === 'apply' ? 'Settings applied' : 'Status updated');
    await ctx.editMessageText(stripToolResultPrefix(result), action === 'status' ? buildSetupKeyboard() : undefined);
});

bot.command('channel', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const result = await runChannelTelegramCommand({
        chatId,
        chatType: ctx.chat?.type,
        userId: senderId,
        text: ((ctx.message as any)?.text || '').trim(),
    });
    await ctx.reply(stripToolResultPrefix(result));
});

bot.command('pack', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const result = await runPackTelegramCommandAsync({
        chatId,
        chatType: ctx.chat?.type,
        userId: senderId,
        text: ((ctx.message as any)?.text || '').trim(),
    });
    await ctx.reply(stripToolResultPrefix(result));
});

bot.command('backup', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const result = await runBackupTelegramCommand({
        chatId,
        chatType: ctx.chat?.type,
        userId: senderId,
        text: ((ctx.message as any)?.text || '').trim(),
    });
    await ctx.reply(stripToolResultPrefix(result));
});

bot.command('approve', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const result = runApprovalTelegramCommand('approve', {
        chatId,
        chatType: ctx.chat?.type,
        userId: senderId,
        text: ((ctx.message as any)?.text || '').trim(),
    });
    await ctx.reply(stripToolResultPrefix(result));
});

bot.command('deny', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const result = runApprovalTelegramCommand('deny', {
        chatId,
        chatType: ctx.chat?.type,
        userId: senderId,
        text: ((ctx.message as any)?.text || '').trim(),
    });
    await ctx.reply(stripToolResultPrefix(result));
});

// /killswitch — toggle kill switch
bot.command('killswitch', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { isKillSwitchActive, setKillSwitch } = require('../core/healthcheck');
    const text = (ctx.message as any)?.text || '';
    const arg = text.split(/\s+/)[1]?.toLowerCase();

    if (arg === 'off' || arg === 'выкл') {
        setKillSwitch(false);
        await ctx.reply('Kill switch снят. Бот работает в штатном режиме.');
    } else if (arg === 'on' || arg === 'вкл') {
        setKillSwitch(true, 'ручное включение через /killswitch');
        await ctx.reply('Kill switch АКТИВИРОВАН. LLM-вызовы заблокированы.');
    } else {
        const active = isKillSwitchActive();
        if (active) {
            setKillSwitch(false);
            await ctx.reply('Kill switch снят. Бот работает в штатном режиме.');
        } else {
            setKillSwitch(true, 'ручное включение через /killswitch');
            await ctx.reply('Kill switch АКТИВИРОВАН. LLM-вызовы заблокированы.');
        }
    }
});

// /reset and /clear — clear conversation context with a compact structured recollection
bot.command('reset', runSharedTelegramCommand);
bot.command('clear', runSharedTelegramCommand);

// /atelier — show skill requests with inline management (owners only)
bot.command('atelier', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { getDb } = require('../db');
    const text = (ctx.message as any)?.text || '';
    const showAll = text.trim().toLowerCase().endsWith('all');

    const statusFilter = showAll
        ? "status IN ('pending', 'in_progress', 'done', 'rejected')"
        : "status IN ('pending', 'in_progress')";

    const requests = getDb()
        .prepare(
            `SELECT * FROM skill_requests WHERE ${statusFilter} ORDER BY
         CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'done' THEN 2 WHEN 'rejected' THEN 3 END,
         CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
         votes DESC, created_at DESC LIMIT 15`
        )
        .all() as any[];

    if (requests.length === 0) {
        await ctx.reply(
            showAll
                ? 'Ателье пусто. Ни одного запроса.'
                : 'Ателье пусто. Все навыки на месте.\n\n/atelier all — показать завершённые.'
        );
        return;
    }

    const STATUS_EMOJI: Record<string, string> = {
        pending: '⏳',
        in_progress: '🔧',
        done: '✅',
        rejected: '❌',
        cleared: '🗑',
    };
    const PRIORITY_EMOJI: Record<string, string> = { high: '🔴', normal: '🟢', low: '🟡' };

    for (const r of requests) {
        const status = STATUS_EMOJI[r.status] || '❓';
        const prio = PRIORITY_EMOJI[r.priority] || '';
        const date = r.created_at?.substring(0, 10) || '';
        const votes = (r.votes || 1) > 1 ? ` (${r.votes} голосов)` : '';
        const hw = r.hardware_needed ? `\n🔩 Железо: ${r.hardware_needed}` : '';
        const pack = r.assistant_pack_id ? `\n📦 Pack: ${r.assistant_pack_id}` : '';
        const gap = r.capability_gap ? `\n🧩 Gap: ${r.capability_gap}` : '';
        const ticket = r.implementation_ticket_status ? `\n🎫 Ticket: ${r.implementation_ticket_status}` : '';

        const line = `${status}${prio} ${r.skill_name}${votes}\n"${r.user_request}"\n${r.description}${gap}${pack}${hw}${ticket}\n${date}`;

        // Only show action buttons for active requests
        if (r.status === 'pending' || r.status === 'in_progress') {
            const buttons = [];
            if (r.status === 'pending') buttons.push(Markup.button.callback('🔧 В работу', `atl:ip:${r.id}`));
            if (r.status === 'in_progress') buttons.push(Markup.button.callback('✅ Готово', `atl:done:${r.id}`));
            if (!r.implementation_ticket_status) buttons.push(Markup.button.callback('🎫 Тикет', `atl:ticket:${r.id}`));
            buttons.push(Markup.button.callback('❌ Откл.', `atl:rej:${r.id}`));
            buttons.push(Markup.button.callback('🗑', `atl:del:${r.id}`));

            await ctx.reply(line, Markup.inlineKeyboard(buttons));
        } else {
            await ctx.reply(line);
        }
    }

    if (!showAll) {
        await ctx.reply('/atelier all — показать все (включая завершённые)');
    }
});

bot.action(/^atl:ticket:(\d+)$/, async (ctx) => {
    const approverId = ctx.from?.id.toString();
    if (!approverId || !isOwner(approverId)) {
        await ctx.answerCbQuery('Только жильцы могут создавать тикеты Ателье.');
        return;
    }

    const requestId = parseInt(ctx.match[1]);
    const { getDb } = require('../db');
    const db = getDb();
    const request = db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(requestId) as any;
    if (!request) {
        await ctx.answerCbQuery('Запрос не найден.');
        return;
    }

    const handlers = require('../skills/_registry').getRegisteredHandlers();
    if (!handlers.atelier_create_ticket) {
        await ctx.answerCbQuery('Создание тикета недоступно.');
        return;
    }

    const result = await handlers.atelier_create_ticket(
        { request_id: requestId },
        {
            chatId: request.space_id || ctx.chat?.id?.toString() || 'unknown',
            userId: approverId,
            spaceId: request.space_id || undefined,
        }
    );

    await ctx.answerCbQuery('Тикет создан');
    await ctx.reply(result);
});

// Atelier status change callbacks
bot.action(/^atl:(ip|done|rej|del):(\d+)$/, async (ctx) => {
    const approverId = ctx.from?.id.toString();
    if (!approverId || !isOwner(approverId)) {
        await ctx.answerCbQuery('Только жильцы могут управлять Ателье.');
        return;
    }

    const action = ctx.match[1];
    const requestId = parseInt(ctx.match[2]);
    const { getDb } = require('../db');
    const db = getDb();

    const request = db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(requestId) as any;
    if (!request) {
        await ctx.answerCbQuery('Запрос не найден.');
        return;
    }

    const STATUS_MAP: Record<string, string> = { ip: 'in_progress', done: 'done', rej: 'rejected', del: 'cleared' };
    const STATUS_LABEL: Record<string, string> = {
        ip: '🔧 В работе',
        done: '✅ Готово',
        rej: '❌ Отклонён',
        del: '🗑 Удалён',
    };
    const newStatus = STATUS_MAP[action];
    const label = STATUS_LABEL[action];
    const oldStatus = request.status;

    // Update status
    const resolvedAt = newStatus === 'done' || newStatus === 'rejected' ? new Date().toISOString() : null;
    db.prepare('UPDATE skill_requests SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?').run(
        newStatus,
        resolvedAt,
        requestId
    );

    // Log to history
    db.prepare(
        'INSERT INTO skill_request_history (request_id, old_status, new_status, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(requestId, oldStatus, newStatus, approverId, new Date().toISOString());

    await ctx.editMessageText(`${label}: ${request.skill_name}\n"${request.user_request}"`);
    await ctx.answerCbQuery(label);

    // Notify household when skill is done
    if (newStatus === 'done' && HOUSEHOLD_CHAT_ID) {
        const title = request.description?.match(/\[([^\]]+)\]/)?.[1] || request.skill_name;
        await sendMessageToChat(HOUSEHOLD_CHAT_ID, `🎉 Навык "${title}" реализован! Попробуйте.`);
    }

    logEvent('atelier_status_change', { requestId, oldStatus, newStatus, by: approverId });
});

// /space — inspect or reconfigure the current chat space (owners only)
bot.command('space', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;

    if (parts.length === 0) {
        result = handlers.space_status
            ? await handlers.space_status({}, context)
            : '[TOOL_RESULT] Space management is not available.';
    } else if (parts[0] === 'packs') {
        result = handlers.space_list_packs
            ? await handlers.space_list_packs({}, context)
            : '[TOOL_RESULT] Space management is not available.';
    } else if (parts[0] === 'sprints') {
        result = handlers.space_list_sprints
            ? await handlers.space_list_sprints({}, context)
            : '[TOOL_RESULT] Space management is not available.';
    } else if (parts[0] === 'pack' && parts[1]) {
        result = handlers.space_set_pack
            ? await handlers.space_set_pack({ pack_id: parts[1] }, context)
            : '[TOOL_RESULT] Space management is not available.';
    } else if (parts[0] === 'policy' && parts[1] && parts[2]) {
        const flag = parts[1];
        const rawValue = parts[2].toLowerCase();
        const value = ['on', 'true', '1', 'yes'].includes(rawValue)
            ? true
            : ['off', 'false', '0', 'no'].includes(rawValue)
              ? false
              : null;

        if (value === null) {
            result = '[TOOL_RESULT] Policy value must be on/off.';
        } else if (!['browser', 'tasks', 'sandbox'].includes(flag)) {
            result = '[TOOL_RESULT] Unknown policy flag. Allowed: browser, tasks, sandbox.';
        } else if (handlers.space_set_policy) {
            const policyArg = flag === 'sandbox' ? { sandbox_enabled: value } : { [flag]: value };
            result = await handlers.space_set_policy(policyArg, context);
        } else {
            result = '[TOOL_RESULT] Space management is not available.';
        }
    } else if (parts[0] === 'sprint' && parts[1]) {
        const days = Number(parts[1]);
        if (!Number.isFinite(days)) {
            result = '[TOOL_RESULT] Sprint length must be a number of days.';
        } else if (handlers.space_set_policy) {
            result = await handlers.space_set_policy({ memory_sprint_days: Math.round(days) }, context);
        } else {
            result = '[TOOL_RESULT] Space management is not available.';
        }
    } else if (parts[0] === 'workspace') {
        const rawPath = text.replace(/^\/space(?:@\w+)?\s+workspace\s+/i, '').trim();
        if (!rawPath) {
            result = '[TOOL_RESULT] Usage: /space workspace </absolute/path|off>';
        } else if (handlers.space_set_workspace) {
            result = await handlers.space_set_workspace({ workspace_path: rawPath }, context);
        } else {
            result = '[TOOL_RESULT] Space management is not available.';
        }
    } else {
        result = `[TOOL_RESULT] Usage:
/space
/space packs
/space sprints
/space pack <jeeves|tutor|office|reporter>
/space policy <browser|tasks|sandbox> <on|off>
/space sprint <days>
/space workspace </absolute/path|off>`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /project — inspect or manage a long-running project in the current space (owners only)
bot.command('project', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const { getRegisteredHandlers } = require('../skills/_registry');
    const handlers = getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;

    if (parts.length === 0) {
        result = handlers.project_status
            ? await handlers.project_status({}, context)
            : '[TOOL_RESULT] Project management is not available.';
    } else if (parts[0] === 'list') {
        result = handlers.project_list
            ? await handlers.project_list({ state: parts[1] }, context)
            : '[TOOL_RESULT] Project management is not available.';
    } else if (parts[0] === 'create') {
        const spec = text.replace(/^\/project(?:@\w+)?\s+create\s+/i, '');
        const segments = spec.split(/\s+\|\s+/);
        if (!segments[0]?.trim()) {
            result = '[TOOL_RESULT] Usage: /project create <title> | [goal] | [next step]';
        } else {
            result = handlers.project_create
                ? await handlers.project_create(
                      {
                          title: segments[0].trim(),
                          goal: segments[1]?.trim() || undefined,
                          next_step: segments[2]?.trim() || undefined,
                      },
                      context
                  )
                : '[TOOL_RESULT] Project management is not available.';
        }
    } else if (parts[0] === 'open') {
        const selector = text.replace(/^\/project(?:@\w+)?\s+open\s+/i, '').trim();
        result =
            selector && handlers.project_open
                ? await handlers.project_open({ project_selector: selector }, context)
                : '[TOOL_RESULT] Usage: /project open <slug|exact title>';
    } else if (parts[0] === 'next') {
        const nextStep = text.replace(/^\/project(?:@\w+)?\s+next\s*/i, '').trim();
        result = handlers.project_next
            ? await handlers.project_next({ next_step: nextStep || undefined }, context)
            : '[TOOL_RESULT] Project management is not available.';
    } else if (parts[0] === 'pause') {
        const selector = text.replace(/^\/project(?:@\w+)?\s+pause\s*/i, '').trim();
        result = handlers.project_pause
            ? await handlers.project_pause({ project_selector: selector || undefined }, context)
            : '[TOOL_RESULT] Project management is not available.';
    } else if (parts[0] === 'done') {
        const selector = text.replace(/^\/project(?:@\w+)?\s+done\s*/i, '').trim();
        result = handlers.project_done
            ? await handlers.project_done({ project_selector: selector || undefined }, context)
            : '[TOOL_RESULT] Project management is not available.';
    } else if ((parts[0] === 'link' || parts[0] === 'unlink') && parts[1]) {
        const linkType = parts[1];
        const targetId = text.replace(new RegExp(`^/project(?:@\\w+)?\\s+${parts[0]}\\s+\\S+\\s*`, 'i'), '').trim();
        const handler = parts[0] === 'link' ? handlers.project_link : handlers.project_unlink;
        result = handler
            ? await handler({ link_type: linkType, target_id: targetId || undefined }, context)
            : '[TOOL_RESULT] Project management is not available.';
    } else {
        result = `[TOOL_RESULT] Usage:
/project
/project list [active|paused|someday|done]
/project create <title> | [goal] | [next step]
/project open <slug|exact title>
/project next [new next step]
/project pause [slug|exact title]
/project done [slug|exact title]
/project link <space|task|artifact> [target]
/project unlink <space|task|artifact> [target]`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /grounding — inspect or adjust the world-model for the current space (owners only)
bot.command('grounding', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;

    if (parts.length === 0) {
        result = handlers.grounding_status
            ? await handlers.grounding_status({}, context)
            : '[TOOL_RESULT] Grounding management is not available.';
    } else if (parts[0] === 'packs') {
        result = handlers.grounding_list_packs
            ? await handlers.grounding_list_packs({}, context)
            : '[TOOL_RESULT] Grounding management is not available.';
    } else if (parts[0] === 'pack' && parts[1]) {
        result = handlers.grounding_set_pack
            ? await handlers.grounding_set_pack({ grounding_pack_id: parts[1] }, context)
            : '[TOOL_RESULT] Grounding management is not available.';
    } else if (parts[0] === 'overrides') {
        result = handlers.grounding_list_overrides
            ? await handlers.grounding_list_overrides({ include_inactive: parts[1] === 'all' }, context)
            : '[TOOL_RESULT] Grounding management is not available.';
    } else if (parts[0] === 'add') {
        const spec = text.replace(/^\/grounding(?:@\w+)?\s+add\s+/i, '');
        const segments = spec.split(/\s+\|\s+/);
        if (segments.length < 3) {
            result = '[TOOL_RESULT] Usage: /grounding add <person|place|rule|org|glossary> | <subject> | <content>';
        } else {
            result = handlers.grounding_add_override
                ? await handlers.grounding_add_override(
                      {
                          kind: segments[0].trim(),
                          subject: segments[1].trim(),
                          content: segments.slice(2).join(' | ').trim(),
                      },
                      context
                  )
                : '[TOOL_RESULT] Grounding management is not available.';
        }
    } else if (parts[0] === 'disable' && parts[1]) {
        const overrideId = Number(parts[1]);
        if (!Number.isFinite(overrideId)) {
            result = '[TOOL_RESULT] Override id must be a number.';
        } else {
            result = handlers.grounding_disable_override
                ? await handlers.grounding_disable_override({ override_id: Math.round(overrideId) }, context)
                : '[TOOL_RESULT] Grounding management is not available.';
        }
    } else {
        result = `[TOOL_RESULT] Usage:
/grounding
/grounding packs
/grounding pack <grounding_pack_id>
/grounding overrides [all]
/grounding add <person|place|rule|org|glossary> | <subject> | <content>
/grounding disable <override_id>`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /tasks — inspect or manage scheduled assistant tasks (owners only)
bot.command('tasks', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;

    if (parts.length === 0) {
        result = handlers.task_list
            ? await handlers.task_list({}, context)
            : '[TOOL_RESULT] Scheduled task management is not available.';
    } else if (parts[0] === 'create') {
        const spec = text.replace(/^\/tasks(?:@\w+)?\s+create\s+/i, '');
        const segments = spec.split(/\s+\|\s+/);
        if (segments.length < 3) {
            result = '[TOOL_RESULT] Usage: /tasks create <cron> | <title> | <prompt>';
        } else {
            const cronExpression = segments[0].trim();
            const title = segments[1].trim();
            const prompt = segments.slice(2).join(' | ').trim();
            result = handlers.task_create
                ? await handlers.task_create({ cron_expression: cronExpression, title, prompt }, context)
                : '[TOOL_RESULT] Scheduled task management is not available.';
        }
    } else if (parts[0] === 'all') {
        result = handlers.task_list
            ? await handlers.task_list({ include_inactive: true }, context)
            : '[TOOL_RESULT] Scheduled task management is not available.';
    } else if (parts[0] === 'pause' && parts[1]) {
        result = handlers.task_pause
            ? await handlers.task_pause({ task_id: parts[1] }, context)
            : '[TOOL_RESULT] Scheduled task management is not available.';
    } else if (parts[0] === 'resume' && parts[1]) {
        result = handlers.task_resume
            ? await handlers.task_resume({ task_id: parts[1] }, context)
            : '[TOOL_RESULT] Scheduled task management is not available.';
    } else if (parts[0] === 'run' && parts[1]) {
        result = handlers.task_run_now
            ? await handlers.task_run_now({ task_id: parts[1] }, context)
            : '[TOOL_RESULT] Scheduled task management is not available.';
    } else if (parts[0] === 'cancel' && parts[1]) {
        result = handlers.task_cancel
            ? await handlers.task_cancel({ task_id: parts[1] }, context)
            : '[TOOL_RESULT] Scheduled task management is not available.';
    } else {
        result = `[TOOL_RESULT] Usage:
/tasks
/tasks create <cron> | <title> | <prompt>
/tasks all
/tasks run <task_id>
/tasks pause <task_id>
/tasks resume <task_id>
/tasks cancel <task_id>`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /rituals — inspect or manage simple day/week rituals (owners only)
bot.command('rituals', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;

    if (parts.length === 0) {
        result = handlers.ritual_list
            ? await handlers.ritual_list({}, context)
            : '[TOOL_RESULT] Ritual management is not available.';
    } else if (parts[0] === 'set' && parts[1] === 'weekly' && parts[2] && parts[3]) {
        result = handlers.ritual_configure
            ? await handlers.ritual_configure(
                  {
                      ritual_key: 'weekly',
                      weekday: parts[2],
                      time_local: parts[3],
                  },
                  context
              )
            : '[TOOL_RESULT] Ritual management is not available.';
    } else if (parts[0] === 'set' && parts[1] && parts[2] && parts[1] !== 'weekly') {
        result = handlers.ritual_configure
            ? await handlers.ritual_configure(
                  {
                      ritual_key: parts[1],
                      time_local: parts[2],
                  },
                  context
              )
            : '[TOOL_RESULT] Ritual management is not available.';
    } else if ((parts[0] === 'on' || parts[0] === 'off') && parts[1]) {
        result = handlers.ritual_configure
            ? await handlers.ritual_configure(
                  {
                      ritual_key: parts[1],
                      enabled: parts[0] === 'on',
                  },
                  context
              )
            : '[TOOL_RESULT] Ritual management is not available.';
    } else if (parts[0] === 'run' && parts[1]) {
        result = handlers.ritual_run_now
            ? await handlers.ritual_run_now({ ritual_key: parts[1] }, context)
            : '[TOOL_RESULT] Ritual management is not available.';
    } else {
        result = `[TOOL_RESULT] Usage:
/rituals
/rituals set morning <HH:MM>
/rituals set evening <HH:MM>
/rituals set weekly <mon|tue|wed|thu|fri|sat|sun> <HH:MM>
/rituals on <morning|evening|weekly>
/rituals off <morning|evening|weekly>
/rituals run <morning|evening|weekly>`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /members — inspect or manage members in the current space (owners only)
bot.command('members', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const replyTarget = getReplyTarget(ctx.message);
    if (replyTarget) {
        ensureReplyTargetMembership(chatId, ctx.chat?.type, replyTarget);
    }

    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };
    const command = parseMembersCommandRequest(text, replyTarget?.personId);

    let result: string;

    if (command.action === 'list') {
        result = handlers.member_list
            ? await handlers.member_list({}, context)
            : '[TOOL_RESULT] Member management is not available.';
    } else if (command.action === 'show') {
        result = handlers.member_show
            ? await handlers.member_show({ person_id: command.selector }, context)
            : '[TOOL_RESULT] Member management is not available.';
    } else if (command.action === 'role') {
        result = handlers.member_set_role
            ? await handlers.member_set_role({ person_id: command.selector, role: command.role }, context)
            : '[TOOL_RESULT] Member management is not available.';
    } else if (command.action === 'rep') {
        result = handlers.member_set_reputation
            ? await handlers.member_set_reputation(
                  { person_id: command.selector, reputation_delta: command.reputation_delta },
                  context
              )
            : '[TOOL_RESULT] Member management is not available.';
    } else if (command.action === 'trust') {
        result = handlers.member_set_trust_flag
            ? await handlers.member_set_trust_flag(
                  { person_id: command.selector, flag: command.flag, enabled: command.enabled },
                  context
              )
            : '[TOOL_RESULT] Member management is not available.';
    } else if (command.action === 'usage') {
        result = `[TOOL_RESULT] ${command.message}`;
    } else {
        result = `[TOOL_RESULT] ${MEMBERS_USAGE}`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /artifacts — list active artifacts in the space
bot.command('artifacts', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    const result = handlers.artifacts_list
        ? await handlers.artifacts_list({}, context)
        : '[TOOL_RESULT] Artifact management is not available.';

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /workspace — inspect or use the attached workspace for the current space (owners only)
bot.command('workspace', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;

    if (parts.length === 0) {
        result = handlers.workspace_status
            ? await handlers.workspace_status({}, context)
            : '[TOOL_RESULT] Workspace tools are not available.';
    } else if (parts[0] === 'artifacts') {
        const folder = text.replace(/^\/workspace(?:@\w+)?\s+artifacts\s*/i, '').trim();
        result = handlers.workspace_list_artifacts
            ? await handlers.workspace_list_artifacts({ folder: folder || undefined }, context)
            : '[TOOL_RESULT] Workspace tools are not available.';
    } else if (parts[0] === 'ls') {
        const relativePath = text.replace(/^\/workspace(?:@\w+)?\s+ls\s*/i, '').trim();
        result = handlers.workspace_list
            ? await handlers.workspace_list({ relative_path: relativePath || undefined }, context)
            : '[TOOL_RESULT] Workspace tools are not available.';
    } else if (parts[0] === 'find' && parts[1]) {
        const query = text.replace(/^\/workspace(?:@\w+)?\s+find\s+/i, '').trim();
        result = handlers.workspace_find_files
            ? await handlers.workspace_find_files({ query }, context)
            : '[TOOL_RESULT] Workspace tools are not available.';
    } else if (parts[0] === 'grep' && parts[1]) {
        const query = text.replace(/^\/workspace(?:@\w+)?\s+grep\s+/i, '').trim();
        result = handlers.workspace_find_text
            ? await handlers.workspace_find_text({ query }, context)
            : '[TOOL_RESULT] Workspace tools are not available.';
    } else if (parts[0] === 'read' && parts[1]) {
        const relativePath = text.replace(/^\/workspace(?:@\w+)?\s+read\s+/i, '').trim();
        result = handlers.workspace_read_text
            ? await handlers.workspace_read_text({ relative_path: relativePath }, context)
            : '[TOOL_RESULT] Workspace tools are not available.';
    } else if (parts[0] === 'note') {
        const spec = text.replace(/^\/workspace(?:@\w+)?\s+note\s+/i, '');
        const segments = spec.split(/\s+\|\s+/);
        if (segments.length < 2) {
            result = '[TOOL_RESULT] Usage: /workspace note <title> | <content>';
        } else {
            const title = segments[0].trim();
            const content = segments.slice(1).join(' | ').trim();
            result = handlers.workspace_save_artifact
                ? await handlers.workspace_save_artifact({ title, content }, context)
                : '[TOOL_RESULT] Workspace tools are not available.';
        }
    } else {
        result = `[TOOL_RESULT] Usage:
/workspace
/workspace artifacts [folder]
/workspace ls [subpath]
/workspace find <query>
/workspace grep <query>
/workspace read <relative_path>
/workspace note <title> | <content>`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /workflow — inspect current pack workflows and recent workflow artifacts (owners only)
bot.command('workflow', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;

    if (parts.length === 0 || parts[0] === 'templates') {
        result = handlers.workflow_list_templates
            ? await handlers.workflow_list_templates({}, context)
            : '[TOOL_RESULT] Workflow tools are not available.';
    } else if (parts[0] === 'artifacts') {
        result = handlers.workflow_list_recent_artifacts
            ? await handlers.workflow_list_recent_artifacts({}, context)
            : '[TOOL_RESULT] Workflow tools are not available.';
    } else {
        result = `[TOOL_RESULT] Usage:
/workflow
/workflow templates
/workflow artifacts`;
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /history — search prior messages across tracked chats or in the current space (owners only)
bot.command('history', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const raw = text.replace(/^\/history(?:@\w+)?\s*/i, '').trim();
    const handlers = require('../skills/_registry').getRegisteredHandlers();
    const context = { chatId, userId: senderId };

    let result: string;
    const normalized = raw.toLowerCase();

    if (!raw) {
        result =
            '[TOOL_RESULT] Usage:\n/history <query>\n/history here <query>\n/history memory <query>\n/history here memory <query>';
    } else if (normalized.startsWith('here memory ')) {
        const query = raw.substring('here memory '.length).trim();
        result = handlers.chat_search
            ? await handlers.chat_search({ query, scope: 'current_space', mode: 'recollections' }, context)
            : '[TOOL_RESULT] History search is not available.';
    } else if (normalized.startsWith('memory ')) {
        const query = raw.substring('memory '.length).trim();
        result = handlers.chat_search
            ? await handlers.chat_search({ query, scope: 'all_spaces', mode: 'recollections' }, context)
            : '[TOOL_RESULT] History search is not available.';
    } else if (normalized.startsWith('here ')) {
        const query = raw.substring(5).trim();
        result = handlers.chat_search
            ? await handlers.chat_search({ query, scope: 'current_space', mode: 'messages' }, context)
            : '[TOOL_RESULT] History search is not available.';
    } else {
        result = handlers.chat_search
            ? await handlers.chat_search({ query: raw, scope: 'all_spaces', mode: 'messages' }, context)
            : '[TOOL_RESULT] History search is not available.';
    }

    await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
});

// /gdrive — connect or manage Google Drive OAuth for this space (owners only)
bot.command('gdrive', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!senderId || !chatId || !isOwner(senderId)) return;

    const text = ((ctx.message as any)?.text || '').trim();
    const parts = text.split(/\s+/).slice(1);
    const spaceId = buildTelegramSpaceId(chatId);

    if (!isGoogleOAuthConfigured()) {
        await ctx.reply(
            'Google OAuth is not configured on this server.\n' +
                'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI in your .env file.'
        );
        return;
    }

    if (parts.length === 0 || parts[0] === 'status') {
        const status = getGoogleAuthStatus(spaceId);
        if (!status.connected) {
            await ctx.reply('Google Drive: not connected.\n\nRun /gdrive auth to connect.');
        } else {
            const expiresIn = status.expires_at ? Math.round((status.expires_at - Date.now()) / 60000) : null;
            const expiryNote =
                expiresIn !== null
                    ? expiresIn > 0
                        ? ` (token valid, refreshes in ~${expiresIn}m)`
                        : ' (token expired, will refresh automatically)'
                    : '';
            await ctx.reply(`Google Drive: connected${expiryNote}.\nScopes: ${status.scope || 'unknown'}`);
        }
    } else if (parts[0] === 'auth') {
        const url = generateGoogleAuthUrl(spaceId);
        if (!url) {
            await ctx.reply('Could not generate authorization URL. Check server OAuth configuration.');
            return;
        }
        await ctx.reply(
            `Authorize Google Drive access for this space:\n\n${url}\n\nAfter approving, Google will redirect back to the server and the bot will confirm here.`
        );
    } else if (parts[0] === 'revoke') {
        const revoked = revokeGoogleOAuthTokens(spaceId);
        await ctx.reply(
            revoked ? 'Google Drive access revoked for this space.' : 'No Google Drive connection found for this space.'
        );
    } else {
        await ctx.reply(
            'Usage:\n/gdrive — check connection status\n/gdrive auth — connect Google Drive\n/gdrive revoke — disconnect Google Drive'
        );
    }
});
