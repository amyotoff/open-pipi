/**
 * Telegram bot core — the shared Telegraf instance and its lifecycle.
 *
 * Command handlers live in telegram-commands.ts, outbound sending in
 * telegram-send.ts. Import the ./telegram facade (not this module) to get
 * a bot with all handlers registered in the right order.
 */

import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT_TOKEN } from '../config';

let messageHandler: ((ctx: any) => Promise<void>) | null = null;

export function setMessageHandler(handler: (ctx: any) => Promise<void>) {
    messageHandler = handler;
}

if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN is not set.');
}

export const bot = new Telegraf(TELEGRAM_BOT_TOKEN || 'dummy_token');

let fallbackHandlersRegistered = false;

/**
 * Register the catch-all handlers. Telegraf middleware runs in registration
 * order, so this must be called AFTER every bot.command()/bot.action() —
 * the ./telegram facade does that.
 */
export function registerTelegramFallbackHandlers(): void {
    if (fallbackHandlersRegistered) return;
    fallbackHandlersRegistered = true;

    // Auto-register household group
    bot.on('my_chat_member', async (ctx) => {
        const newStatus = ctx.myChatMember.new_chat_member.status;
        const chat = ctx.chat;
        if (chat.type === 'group' || chat.type === 'supergroup') {
            if (newStatus === 'member' || newStatus === 'administrator') {
                const { upsertChat } = require('../db');
                upsertChat({ jid: chat.id.toString(), type: 'household_group', status: 'ACTIVE' });
                console.log(`[BOT] Registered group ${chat.id} as household chat.`);
            }
        }
    });

    // Main message handler
    bot.on('message', async (ctx) => {
        try {
            if (messageHandler) {
                await messageHandler(ctx);
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });
}

export function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('Skipping Telegram bot (missing token).');
        return;
    }

    // Register hamburger menu commands
    bot.telegram
        .setMyCommands([
            { command: 'jeeves', description: '🎩 PA Jeeves status and setup' },
            { command: 'setup', description: '🧭 Guided setup for this space' },
            { command: 'brief', description: '📰 On-demand Jeeves briefing' },
            { command: 'focus', description: '🎯 On-demand focus plan' },
            { command: 'review', description: '🌙 On-demand evening review' },
            { command: 'audit', description: '🔎 Structured review of current work' },
            { command: 'plan', description: '🪜 Build a concrete next-step plan' },
            { command: 'research', description: '🧭 Build a compact research brief' },
            { command: 'handoff', description: '📦 Save a compact resume snapshot' },
            { command: 'resume', description: '📌 Show the latest handoff snapshot' },
            { command: 'today', description: '📓 Timeline for today' },
            { command: 'yesterday', description: '📒 Timeline for yesterday' },
            { command: 'week', description: '🗓 Timeline for the last 7 days' },
            { command: 'status', description: '📡 System status and token usage' },
            { command: 'killswitch', description: '⛔ Toggle the kill switch' },
            { command: 'reset', description: '🔄 Clear conversation context' },
            { command: 'channel', description: '📮 Inspect or change channel mode' },
            { command: 'pack', description: '📦 Inspect or switch assistant pack' },
            { command: 'backup', description: '💾 Create or inspect runtime backups' },
            { command: 'approve', description: '✅ Approve a pending risky action' },
            { command: 'deny', description: '🚫 Deny a pending risky action' },
            { command: 'atelier', description: '🧰 Review requested capabilities' },
            { command: 'space', description: '🧭 Inspect or configure this chat space' },
            { command: 'project', description: '🪜 Inspect or steer a project' },
            { command: 'history', description: '🕰 Search prior chat history' },
            { command: 'artifacts', description: '📋 List active space artifacts' },
            { command: 'workspace', description: '🗂 Inspect or use the attached workspace' },
            { command: 'workflow', description: '🧱 Inspect pack workflows and artifacts' },
            { command: 'tasks', description: '⏰ Inspect or manage scheduled tasks' },
            { command: 'rituals', description: '🕯 Inspect or manage day/week rituals' },
            { command: 'members', description: '👥 Inspect or manage chat members' },
            { command: 'gdrive', description: '🔗 Connect or manage Google Drive access' },
        ])
        .catch((err) => console.error('[BOT] Failed to set commands:', err.message));

    bot.launch();
    console.log('Telegram bot started.');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
