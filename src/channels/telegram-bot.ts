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

/**
 * What the adapter receives: the pieces of a telegraf context that matter,
 * already pulled apart. Handing over the context itself would let telegraf
 * types travel further than this module.
 */
export interface TelegramInboundUpdate {
    message: any;
    chat: any;
    from: any;
    bot: { id?: number | string; username?: string | null };
}

export interface TelegramFallbackHandlers {
    onMessage: (update: TelegramInboundUpdate) => Promise<void>;
}

let messageHandler: TelegramFallbackHandlers['onMessage'] | null = null;

if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN is not set.');
}

export const bot = new Telegraf(TELEGRAM_BOT_TOKEN || 'dummy_token');

let fallbackHandlersRegistered = false;
let launched = false;
let starting: Promise<void> | null = null;
let terminalFailureHandler: (() => void | Promise<void>) | null = null;

export function onTelegramBotTerminalFailure(handler: () => void | Promise<void>): void {
    terminalFailureHandler = handler;
}

/**
 * Register the catch-all handlers. Telegraf middleware runs in registration
 * order, so this must be called AFTER every bot.command()/bot.action() —
 * the ./telegram facade does that.
 */
export function registerTelegramFallbackHandlers(handlers?: TelegramFallbackHandlers): void {
    if (handlers) messageHandler = handlers.onMessage;
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

    // Main message handler. The context is taken apart here so telegraf's types
    // stop at this module's edge.
    bot.on('message', async (ctx) => {
        try {
            if (!messageHandler) return;
            await messageHandler({
                message: ctx.message,
                chat: ctx.chat,
                from: ctx.from,
                bot: { id: ctx.botInfo?.id, username: ctx.botInfo?.username },
            });
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });
}

export async function startTelegramBot(): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('Skipping Telegram bot (missing token).');
        return;
    }
    if (launched) return;
    if (starting) return starting;

    starting = (async () => {
        // Menu setup is useful but does not decide whether polling is ready.
        void bot.telegram
            .setMyCommands([...TELEGRAM_MENU_COMMANDS])
            .catch(() => console.error('[BOT] Failed to set Telegram commands.'));

        const webhook = await bot.telegram.getWebhookInfo().catch(() => {
            throw new Error('Telegram connection could not be checked.');
        });
        if (webhook.url) {
            throw new Error('Telegram is connected to an active webhook; it was left unchanged.');
        }

        let ready = false;
        let markReady: (() => void) | undefined;
        let rejectReady: ((error: unknown) => void) | undefined;
        const readyPromise = new Promise<void>((resolve, reject) => {
            markReady = resolve;
            rejectReady = reject;
        });
        const telegram = bot.telegram as typeof bot.telegram & {
            callApi: (method: string, payload?: Record<string, unknown>, signal?: unknown) => Promise<unknown>;
        };
        const originalCallApi = telegram.callApi.bind(telegram);
        telegram.callApi = (async (method: string, payload?: Record<string, unknown>, signal?: unknown) => {
            const firstGetUpdates = method === 'getUpdates' && !ready;
            const response = await originalCallApi(
                method,
                firstGetUpdates ? { ...(payload || {}), timeout: 0 } : payload,
                signal
            );
            if (firstGetUpdates) {
                ready = true;
                launched = true;
                console.log('Telegram bot started.');
                markReady?.();
            }
            return response;
        }) as typeof telegram.callApi;

        const polling = bot.launch();
        void polling.catch(() => {
            launched = false;
            telegram.callApi = originalCallApi as typeof telegram.callApi;
            if (!ready) rejectReady?.(new Error('Telegram polling could not be started.'));
            else void terminalFailureHandler?.();
        });
        await readyPromise;
        telegram.callApi = originalCallApi as typeof telegram.callApi;
    })();

    try {
        await starting;
    } finally {
        starting = null;
    }
    // Shutdown belongs to the transport registry, which the bootstrap drives on
    // SIGINT/SIGTERM. Registering signal handlers here too would stop the bot
    // twice and make telegraf throw on the second call.
}

/** Whether launch() actually ran, so stopping a bot that never started is a no-op. */
export function isTelegramBotLaunched(): boolean {
    return launched;
}

export function markTelegramBotStopped(): void {
    launched = false;
}
