/**
 * Telegram update -> IncomingMessage.
 *
 * This is the only place that knows what a Telegram update looks like. It is a
 * pure function over structurally-typed input rather than telegraf's own types,
 * which keeps it testable from fixtures and means even the normalizer does not
 * need the SDK.
 *
 * Whatever this file fails to translate, Core cannot see.
 */

import { randomUUID } from 'node:crypto';
import { buildIncomingMessageId } from '../types';
import type { IncomingAttachment, IncomingMessage, IncomingSender, TransportEndpointType } from '../types';

// ==========================================
// The shape of what Telegram sends
// ==========================================

export interface TelegramUser {
    id?: number | string;
    username?: string | null;
    first_name?: string | null;
    is_bot?: boolean;
}

export interface TelegramChat {
    id?: number | string;
    type?: string;
    title?: string;
}

export interface TelegramPhotoSize {
    file_id?: string;
    file_unique_id?: string;
    file_size?: number;
    width?: number;
    height?: number;
}

export interface TelegramMessage {
    message_id?: number | string;
    date?: number;
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
    message_thread_id?: number | string;
    from?: TelegramUser;
    reply_to_message?: TelegramMessage;
}

export interface TelegramNormalizerInput {
    message: TelegramMessage;
    chat: TelegramChat;
    from?: TelegramUser;
    bot?: { id?: number | string; username?: string | null };
}

// ==========================================
// Normalization
// ==========================================

const TRANSPORT = 'telegram';

function containsExactMention(text: string, username: string): boolean {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
}

/** Telegram's chat types collapse into the closed set Core shares with every transport. */
export function normalizeTelegramEndpointType(chatType: string | undefined): TransportEndpointType {
    if (chatType === 'private') return 'direct';
    if (chatType === 'channel') return 'channel';
    return 'group';
}

export function readTelegramText(message: TelegramMessage): string {
    return message.text || message.caption || '';
}

function normalizeSender(user: TelegramUser | undefined): IncomingSender | null {
    const id = user?.id;
    if (id === undefined || id === null || id === '') return null;

    return {
        transportUserId: String(id),
        displayName: user?.first_name || user?.username || null,
        username: user?.username || null,
        isBot: Boolean(user?.is_bot),
    };
}

/**
 * Only the largest photo size is kept: Telegram sends the same image at several
 * resolutions, and the assistant always wants the best one.
 *
 * The file id travels in metadata because it is meaningless off Telegram — the
 * adapter exchanges it for a local path before Core ever looks at the
 * attachment.
 */
function normalizePhotoAttachment(message: TelegramMessage): IncomingAttachment | null {
    const sizes = message.photo;
    if (!Array.isArray(sizes) || sizes.length === 0) return null;

    const largest = sizes[sizes.length - 1];
    if (!largest?.file_id) return null;

    return {
        id: largest.file_unique_id || largest.file_id,
        type: 'image',
        mimeType: 'image/jpeg',
        sizeBytes: largest.file_size,
        metadata: { fileId: largest.file_id },
    };
}

function normalizeReplyContext(message: TelegramMessage): IncomingMessage['replyTo'] {
    const replyTo = message.reply_to_message;
    if (!replyTo) return undefined;

    return {
        transportMessageId: replyTo.message_id === undefined ? null : String(replyTo.message_id),
        sender: normalizeSender(replyTo.from) ?? undefined,
        text: readTelegramText(replyTo) || null,
    };
}

/**
 * Was this aimed at the assistant? An @mention of its username, or a reply to
 * something it said. Core gets the verdict; the matching rules stay here.
 */
export function isAddressedToTelegramBot(input: TelegramNormalizerInput): boolean {
    const botUsername = input.bot?.username;
    const botId = input.bot?.id === undefined ? undefined : String(input.bot.id);

    if (botUsername) {
        if (containsExactMention(readTelegramText(input.message), botUsername)) return true;
    }

    const replyTo = input.message.reply_to_message;
    if (!replyTo?.from) return false;

    if (botUsername && replyTo.from.username?.toLowerCase() === botUsername.toLowerCase()) return true;
    return Boolean(botId && replyTo.from.id !== undefined && String(replyTo.from.id) === botId);
}

/**
 * Translate an update, or return null when there is nothing routable in it.
 *
 * A message with neither text nor a supported attachment is not an error — it
 * is a sticker, a poll, a service notice — so it normalizes to null and the
 * adapter drops it without bothering the gateway.
 */
export function normalizeTelegramMessage(input: TelegramNormalizerInput): IncomingMessage | null {
    const chatId = input.chat?.id;
    const messageId = input.message?.message_id;
    const sender = normalizeSender(input.from ?? input.message?.from);

    if (chatId === undefined || chatId === null || chatId === '') return null;
    if (messageId === undefined || messageId === null || messageId === '') return null;
    if (!sender) return null;

    const endpointId = String(chatId);
    const text = readTelegramText(input.message);
    const photo = normalizePhotoAttachment(input.message);
    const attachments = photo ? [photo] : [];

    if (!text && attachments.length === 0) return null;

    const threadId =
        input.message.message_thread_id === undefined || input.message.message_thread_id === null
            ? undefined
            : String(input.message.message_thread_id);

    return {
        id: buildIncomingMessageId(TRANSPORT, endpointId, String(messageId)),
        transportMessageId: String(messageId),
        transport: TRANSPORT,
        endpoint: {
            id: endpointId,
            type: normalizeTelegramEndpointType(input.chat?.type),
            title: input.chat?.title ?? null,
        },
        ...(threadId ? { threadId } : {}),
        sender,
        content: {
            ...(text ? { text } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
        },
        replyTo: normalizeReplyContext(input.message),
        // Telegram dates are whole seconds since the epoch; a missing one means
        // the update was synthesized, so fall back to arrival time.
        timestamp: input.message.date ? new Date(input.message.date * 1000).toISOString() : new Date().toISOString(),
        correlationId: randomUUID(),
        addressedToAssistant: isAddressedToTelegramBot(input),
    };
}
