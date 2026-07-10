/**
 * Telegram outbound sending — messages, files, typing, and pin scheduling.
 *
 * Formatting lives in telegram-format.ts; the bot instance in telegram-bot.ts.
 */

import { Input } from 'telegraf';
import { TELEGRAM_BOT_TOKEN, HOUSEHOLD_CHAT_ID } from '../config';
import { formatTelegramText } from './telegram-format';
import type { FileOptions, MessageOptions, SendResult } from './_types';
import { bot } from './telegram-bot';

const pinTimers = new Map<string, NodeJS.Timeout>();

function scheduleTelegramUnpin(chatId: string, messageId: number, hours: number): void {
    const key = `${chatId}:${messageId}`;
    const existing = pinTimers.get(key);
    if (existing) {
        clearTimeout(existing);
    }

    const delayMs = Math.max(1, hours) * 60 * 60 * 1000;
    const timer = setTimeout(() => {
        pinTimers.delete(key);
        bot.telegram.unpinChatMessage(chatId, messageId).catch((error) => {
            console.error(`Failed to unpin Telegram message ${messageId} in ${chatId}:`, error);
        });
    }, delayMs);
    timer.unref?.();
    pinTimers.set(key, timer);
}

async function pinTelegramMessage(
    chatId: string,
    messageId: number,
    opts?: MessageOptions | FileOptions
): Promise<void> {
    if (!opts?.pin) return;

    try {
        await bot.telegram.pinChatMessage(chatId, messageId, {
            disable_notification: opts.pinDisableNotification ?? true,
        });
        scheduleTelegramUnpin(chatId, messageId, opts.unpinAfterHours || 24);
    } catch (error) {
        console.error(`Failed to pin Telegram message ${messageId} in ${chatId}:`, error);
    }
}

export async function sendMessageToChat(chatId: string, text: string, opts?: MessageOptions): Promise<SendResult> {
    if (!TELEGRAM_BOT_TOKEN) return { success: true };
    const formatted = formatTelegramText(text);
    try {
        const sent = await bot.telegram.sendMessage(chatId, formatted.html, { parse_mode: 'HTML' });
        await pinTelegramMessage(chatId, sent.message_id, opts);
        return { success: true, messageId: String(sent.message_id) };
    } catch (error) {
        console.error(`Failed to send to ${chatId}:`, error);
        try {
            const sent = await bot.telegram.sendMessage(chatId, formatted.plain);
            await pinTelegramMessage(chatId, sent.message_id, opts);
            return { success: true, messageId: String(sent.message_id) };
        } catch (fallbackError) {
            console.error(`Failed to send fallback to ${chatId}:`, fallbackError);
            return {
                success: false,
                error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            };
        }
    }
}

export async function sendFileToChat(chatId: string, filePath: string, opts?: FileOptions): Promise<SendResult> {
    if (!TELEGRAM_BOT_TOKEN) return { success: true };

    try {
        const sent = await bot.telegram.sendDocument(
            chatId,
            Input.fromLocalFile(filePath, opts?.filename),
            opts?.caption ? { caption: opts.caption } : undefined
        );
        await pinTelegramMessage(chatId, sent.message_id, opts);
        return { success: true, messageId: String(sent.message_id) };
    } catch (error) {
        console.error(`Failed to send file to ${chatId}:`, error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export async function notifyHousehold(text: string) {
    if (HOUSEHOLD_CHAT_ID) {
        await sendMessageToChat(HOUSEHOLD_CHAT_ID, text);
    }
}

export async function sendTypingAction(chatId: string) {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        await bot.telegram.sendChatAction(chatId, 'typing');
    } catch {
        // Non-critical
    }
}
