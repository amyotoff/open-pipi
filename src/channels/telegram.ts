/**
 * Telegram channel facade — the single entry point for the Telegram adapter.
 *
 * The implementation is split by concern:
 *   - telegram-bot.ts      bot instance, lifecycle, fallback handlers
 *   - telegram-commands.ts every bot.command()/bot.action() registration
 *   - telegram-send.ts     outbound messages, files, typing, pinning
 *   - telegram-format.ts   markdown → Telegram HTML formatting
 *
 * Telegraf middleware runs in registration order, so commands must register
 * before the catch-all message handler. This module owns that ordering:
 * importing it yields a fully wired bot.
 */

import './telegram-commands';

export { bot, registerTelegramFallbackHandlers, startTelegramBot } from './telegram-bot';
export type { TelegramInboundUpdate, TelegramFallbackHandlers } from './telegram-bot';
export { sendMessageToChat, sendFileToChat, notifyHousehold, sendTypingAction } from './telegram-send';
