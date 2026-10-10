/**
 * The Telegram front door, written against the shape of a Telegraf context
 * rather than Telegraf itself so core code stays transport-free.
 *
 * A KISMATIK group belongs to KISMATIK: every update from it is consumed here
 * and never reaches the PiPi gateway. Only the owner's own commands are let
 * through, and those are owner-checked where they live.
 */

import { isOwner } from '../config';
import { listWikiPages } from '../core/brain-wiki';
import { isAddressedToTelegramBot } from '../transports/telegram/normalizer';
import { logError, logInfo } from '../utils/logging';
import { answerQuestion } from './answer';
import { communitySpaceId, isKismatikChat, kismatikConfig } from './config';
import {
    addMessage,
    communityStats,
    forgetMessage,
    getMessage,
    isPaused,
    setPaused,
    takeAsk,
    upsertCommunity,
} from './store';
import { escapeHtml } from './text';

export interface KismatikContext {
    update: any;
    chat?: { id: number | string; type?: string; title?: string; username?: string };
    from?: { id: number | string; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
    message?: any;
    botInfo?: { id: number; username?: string };
    reply(text: string, extra?: any): Promise<unknown>;
    sendChatAction?(action: string): Promise<unknown>;
}

export const HELP_TEXT = [
    '<b>KISMATIK</b> — память этого чата.',
    'Спросите: <code>@бот вопрос</code>, ответьте на сообщение бота или <code>/km ask вопрос</code> — отвечу по тому, что здесь обсуждали, со ссылками.',
    'Если кто-то ищет то, что другой предлагает, — подскажу обоим.',
    '<code>/km wiki</code> — что я уже знаю. <code>/km forget</code> (ответом на своё сообщение) — забыть его.',
].join('\n');

function displayName(from: KismatikContext['from']): string {
    if (!from) return 'Участник';
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
    return name || (from.username ? `@${from.username}` : `id${from.id}`);
}

// Telegram redelivers an update it never saw acknowledged; a command is not stored, so remember it here.
const seenCommands = new Set<string>();

function isFirstDelivery(chatId: string, messageId: number | undefined): boolean {
    if (messageId === undefined) return true;
    const key = `${chatId}:${messageId}`;
    if (seenCommands.has(key)) return false;
    seenCommands.add(key);
    if (seenCommands.size > 1000) seenCommands.delete(seenCommands.values().next().value as string);
    return true;
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

async function replyHtml(ctx: KismatikContext, html: string): Promise<void> {
    await ctx.reply(html, {
        parse_mode: 'HTML',
        reply_parameters: ctx.message
            ? { message_id: ctx.message.message_id, allow_sending_without_reply: true }
            : undefined,
        link_preview_options: { is_disabled: true },
    });
}

async function ask(ctx: KismatikContext, chatId: string, question: string): Promise<void> {
    const userId = String(ctx.from?.id ?? '');
    if (!question.trim()) {
        await replyHtml(ctx, 'Что именно спросить? Например: <code>/km ask кто чинил велосипед?</code>');
        return;
    }
    if (!isOwner(userId) && !takeAsk(chatId, userId, today(), kismatikConfig().maxAsksPerUserPerDay)) {
        await replyHtml(ctx, 'На сегодня вопросов достаточно — продолжим завтра.');
        return;
    }
    await ctx.sendChatAction?.('typing').catch(() => {});
    const answer = await answerQuestion(chatId, question);
    await replyHtml(ctx, answer);
}

function parseCommand(text: string): { name: string; target: string | null; args: string } | null {
    const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return null;
    return { name: match[1].toLowerCase(), target: match[2] ?? null, args: (match[3] ?? '').trim() };
}

async function handleKm(ctx: KismatikContext, chatId: string, args: string): Promise<void> {
    const [sub = 'help', ...rest] = args.split(/\s+/);
    const tail = args.slice(sub.length).trim();
    const userId = String(ctx.from?.id ?? '');
    const owner = isOwner(userId);

    switch (sub.toLowerCase()) {
        case 'ask':
            if (isPaused(chatId)) return replyHtml(ctx, 'KISMATIK на паузе.');
            return ask(ctx, chatId, tail);
        case 'wiki': {
            if (!kismatikConfig().wiki) return replyHtml(ctx, 'Вики в этом чате не ведётся — спросите меня напрямую.');
            const pages = listWikiPages({ spaceId: communitySpaceId(chatId), limit: 30 });
            if (pages.length === 0)
                return replyHtml(ctx, 'Вики пока пустая — она собирается из переписки раз в пару часов.');
            return replyHtml(
                ctx,
                ['<b>Что я знаю:</b>', ...pages.map((page) => `• ${escapeHtml(page.title)}`)].join('\n')
            );
        }
        case 'forget': {
            const target = ctx.message?.reply_to_message?.message_id ?? Number(rest[0]?.match(/(\d+)\/?$/)?.[1]);
            if (!target)
                return replyHtml(ctx, 'Ответьте командой <code>/km forget</code> на сообщение, которое нужно забыть.');
            const stored = getMessage(chatId, Number(target));
            if (!stored) return replyHtml(ctx, 'Этого сообщения в памяти нет.');
            if (stored.user_id !== userId && !owner) return replyHtml(ctx, 'Забыть можно только своё сообщение.');
            forgetMessage(chatId, Number(target));
            return replyHtml(ctx, 'Забыл.');
        }
        case 'on':
        case 'off':
            if (!owner) return;
            setPaused(chatId, sub.toLowerCase() === 'off');
            return replyHtml(ctx, sub.toLowerCase() === 'off' ? 'KISMATIK выключен в этом чате.' : 'KISMATIK включён.');
        case 'stats': {
            if (!owner) return;
            const stats = communityStats(chatId);
            return replyHtml(
                ctx,
                Object.entries(stats)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join('\n')
            );
        }
        default:
            return replyHtml(ctx, HELP_TEXT);
    }
}

function stripBotMention(text: string, username?: string): string {
    if (!username) return text;
    return text
        .replace(new RegExp(`@${username}\\b`, 'ig'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function chatLink(username: string | undefined, messageId: number | undefined): string | null {
    return username && messageId ? `https://t.me/${username}/${messageId}` : null;
}

/** True when the update belonged to a KISMATIK group and has been dealt with. */
export async function handleKismatikUpdate(ctx: KismatikContext): Promise<boolean> {
    const chat = ctx.chat;
    if (!chat || chat.type === 'private' || !isKismatikChat(chat.id)) return false;
    const chatId = String(chat.id);

    try {
        // Bot added, promoted, removed: record the community, and keep PiPi from
        // adopting the group as one of its own household chats.
        if (ctx.update?.my_chat_member) {
            upsertCommunity(chatId, { title: chat.title, username: chat.username });
            return true;
        }

        // A listed channel: remember its posts, never answer in it.
        const post = ctx.update?.channel_post;
        if (post) {
            const postText: string = post.text ?? post.caption ?? '';
            upsertCommunity(chatId, { title: chat.title, username: chat.username });
            if (!isPaused(chatId) && postText.trim()) {
                addMessage(
                    chatId,
                    {
                        message_id: post.message_id,
                        user_id: chatId,
                        user_name: chat.title || 'Канал',
                        username: chat.username ?? null,
                        text: postText,
                        ts: (post.date ?? Math.floor(Date.now() / 1000)) * 1000,
                        author_kind: 'chat',
                        link: chatLink(chat.username, post.message_id),
                        thread_root: post.message_id,
                    },
                    { gapMs: kismatikConfig().chunkGapMs, maxChars: kismatikConfig().chunkMaxChars }
                );
            }
            return true;
        }

        const message = ctx.update?.message;
        if (!message) return !ctx.update?.callback_query;
        // Anonymous admins and "as channel" senders arrive as bots with a sender_chat.
        if (!ctx.from || (ctx.from.is_bot && !message.sender_chat)) return true;

        const text: string = message.text ?? message.caption ?? '';
        const userId = String(ctx.from.id);
        upsertCommunity(chatId, { title: chat.title, username: chat.username });

        // A channel post mirrored into the discussion group; comments hang under it.
        const origin =
            message.is_automatic_forward && message.forward_origin?.type === 'channel' ? message.forward_origin : null;
        const authorChat = message.sender_chat ?? origin?.chat;

        const command = !message.is_automatic_forward && text.startsWith('/') ? parseCommand(text) : null;
        if (command) {
            const botName = ctx.botInfo?.username;
            if (command.target && botName && command.target.toLowerCase() !== botName.toLowerCase()) return true;
            if (command.name === 'km') {
                if (!isFirstDelivery(chatId, message.message_id)) return true;
                await handleKm(ctx, chatId, command.args);
                return true;
            }
            // The owner's PiPi commands still work here; everyone else's are swallowed.
            return !isOwner(userId);
        }

        if (isPaused(chatId) || !text.trim()) return true;

        const isNew = addMessage(
            chatId,
            {
                message_id: message.message_id,
                user_id: authorChat ? String(authorChat.id) : userId,
                user_name: authorChat ? authorChat.title || 'Канал' : displayName(ctx.from),
                username: (authorChat ? authorChat.username : ctx.from.username) ?? null,
                text,
                reply_to: message.reply_to_message?.message_id ?? null,
                thread_id: message.message_thread_id ?? null,
                ts: (message.date ?? Math.floor(Date.now() / 1000)) * 1000,
                author_kind: authorChat ? 'chat' : 'user',
                link: origin ? chatLink(origin.chat?.username, origin.message_id) : null,
                thread_root: origin ? message.message_id : null,
            },
            { gapMs: kismatikConfig().chunkGapMs, maxChars: kismatikConfig().chunkMaxChars }
        );

        // A redelivered question was already answered.
        if (!isNew) return true;

        const addressed = isAddressedToTelegramBot({
            message,
            chat: chat as any,
            from: ctx.from as any,
            bot: ctx.botInfo ? { id: ctx.botInfo.id, username: ctx.botInfo.username } : undefined,
        });
        if (addressed && !authorChat) {
            logInfo('KISMATIK', 'question', { chat_id: chatId, message_id: message.message_id });
            await ask(ctx, chatId, stripBotMention(text, ctx.botInfo?.username));
        }
        return true;
    } catch (error: any) {
        // Fail closed: a KISMATIK group never falls through to PiPi, even on error.
        logError('KISMATIK', 'update_failed', { chat_id: chatId, message: error?.message });
        return true;
    }
}
