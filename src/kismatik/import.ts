/**
 * Backfill from a Telegram Desktop export ("Export chat history" → JSON).
 * The Bot API cannot read history from before the bot joined; an admin's
 * export is the only way to give a community its past.
 */

import fs from 'node:fs';
import { kismatikConfig } from './config';
import { addMessage, upsertCommunity, type NewMessage } from './store';

interface ExportEntity {
    type?: string;
    text?: string;
}

interface ExportMessage {
    id: number;
    type: string;
    date_unixtime?: string;
    from?: string | null;
    from_id?: string;
    text?: string | Array<string | ExportEntity>;
    forwarded_from?: string;
    reply_to_message_id?: number;
    message_thread_id?: number;
}

export interface TelegramExport {
    name?: string;
    type?: string;
    id?: number;
    messages: ExportMessage[];
}

export function exportText(text: ExportMessage['text']): string {
    if (!text) return '';
    if (typeof text === 'string') return text;
    return text.map((part) => (typeof part === 'string' ? part : part.text || '')).join('');
}

/** Supergroup exports carry the bare id; the Bot API prefixes it with -100. */
export function exportChatId(data: TelegramExport): string | null {
    if (data.id === undefined) return null;
    return data.type?.includes('supergroup') || data.type?.includes('channel') ? `-100${data.id}` : `-${data.id}`;
}

export function toNewMessage(
    entry: ExportMessage,
    options: { channel?: boolean; username?: string } = {}
): NewMessage | null {
    if (entry.type !== 'message') return null;
    const text = exportText(entry.text).trim();
    const fromId = entry.from_id ?? '';
    const channelId = /^channel(\d+)$/.exec(fromId)?.[1];
    const userId = channelId ? `-100${channelId}` : fromId.replace(/^user/, '');
    // Anything without a numeric id (deleted accounts, unknown senders) cannot be tagged later.
    if (!text || !/^(-100)?\d+$/.test(userId)) return null;
    // A post is the root of its thread; in a group export it is the mirrored copy of a channel post.
    const isPost = !!channelId && (options.channel || !!entry.forwarded_from);
    return {
        message_id: entry.id,
        user_id: userId,
        user_name: entry.from || `id${userId}`,
        text,
        reply_to: entry.reply_to_message_id ?? null,
        thread_id: entry.message_thread_id ?? null,
        ts: Number(entry.date_unixtime) * 1000,
        author_kind: channelId ? 'chat' : 'user',
        link: options.channel && options.username ? `https://t.me/${options.username}/${entry.id}` : null,
        thread_root: isPost ? entry.id : null,
    };
}

export function importTelegramExport(
    data: TelegramExport,
    chatId: string,
    options: { username?: string } = {}
): { imported: number; skipped: number; duplicates: number } {
    const config = kismatikConfig();
    upsertCommunity(chatId, { title: data.name ?? null });
    const result = { imported: 0, skipped: 0, duplicates: 0 };
    const channel = !!data.type?.includes('channel');
    const username = options.username?.replace(/^@/, '');
    const ordered = [...data.messages].sort((a, b) => Number(a.date_unixtime) - Number(b.date_unixtime) || a.id - b.id);
    for (const entry of ordered) {
        const message = toNewMessage(entry, { channel, username });
        if (!message || !Number.isFinite(message.ts)) {
            result.skipped += 1;
            continue;
        }
        if (addMessage(chatId, message, { gapMs: config.chunkGapMs, maxChars: config.chunkMaxChars }))
            result.imported += 1;
        else result.duplicates += 1;
    }
    return result;
}

export function importTelegramExportFile(file: string, chatId?: string, options: { username?: string } = {}) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as TelegramExport;
    const target = chatId || exportChatId(data);
    if (!target) throw new Error('Cannot tell the chat id from the export; pass it explicitly.');
    return { chatId: target, ...importTelegramExport(data, target, options) };
}
