/**
 * Telegram bot core — the shared Telegraf instance and its lifecycle.
 *
 * Command handlers live in telegram-commands.ts, outbound sending in
 * telegram-send.ts. Import the ./telegram facade (not this module) to get
 * a bot with all handlers registered in the right order.
 */

import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT_TOKEN } from '../config';
import { TELEGRAM_MENU_COMMANDS } from './telegram-menu';

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
        .setMyCommands([...TELEGRAM_MENU_COMMANDS])
        .catch((err) => console.error('[BOT] Failed to set commands:', err.message));

    bot.launch();
    console.log('Telegram bot started.');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
