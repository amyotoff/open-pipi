/**
 * Test-only harness: a virtual clock, Telegram update builders, a hash-based
 * embedder and a scripted LLM, wired to the real KISMATIK modules. Offline and
 * deterministic. Not loaded by production code.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { stemToken, tokenize } from '../kismatik/text';

export const ANON_ADMIN_ID = 1087968824;
export const CHANNEL_BOT_ID = 136817688;
export const TG_SERVICE_ID = 777000;
export const BOT_USERNAME = 'km_bot';
export const OWNER_ID = '999';
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

export interface SimChat {
    id: string | number;
    title?: string;
    username?: string;
    type?: 'supergroup' | 'channel';
}

export interface SimUpdate {
    chat: { id: number; type: string; title?: string; username?: string };
    from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
    update: any;
    message?: any;
}

export type LlmKind = 'answer' | 'signals' | 'match';
export type LlmInput = { system: string; user: string; maxTokens?: number };
export type LlmHook = (input: LlmInput) => string | Promise<string>;

export const HASH_DIM = 64;

function fnv(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return hash;
}

/** Bag of stemmed tokens hashed into 64 signed buckets, unit length. */
export function hashEmbed(text: string): Float32Array {
    const clean = text
        .replace(/↳ к посту/g, ' ')
        .replace(/\[msg:\d+\]/g, ' ')
        .replace(/\(\d{4}-\d\d-\d\d \d\d:\d\d\)/g, ' ');
    const vec = new Float32Array(HASH_DIM);
    for (const token of tokenize(clean)) {
        const hash = fnv(stemToken(token));
        vec[hash % HASH_DIM] += hash & 0x10000 ? 1 : -1;
    }
    let norm = 0;
    for (const value of vec) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < HASH_DIM; i++) vec[i] /= norm;
    return vec;
}

export const hashEmbedder = {
    id: 'hash@64',
    embedDocuments: async (texts: string[]) => texts.map(hashEmbed),
    embedQuery: async (text: string) => hashEmbed(text),
};

function kindOf(system: string): LlmKind {
    if (system.includes('память Telegram-сообщества')) return 'answer';
    if (system.includes('разбираешь переписку')) return 'signals';
    return 'match';
}

export async function createSim(options: {
    chats: Array<string | SimChat>;
    env?: Record<string, string>;
    embedder?: boolean;
}) {
    const originalEnv = { ...process.env };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kismatik-sim-'));
    const chats = new Map<string, SimChat>(
        options.chats.map((chat) => {
            const full = typeof chat === 'string' ? { id: chat } : chat;
            return [String(full.id), full];
        })
    );
    process.env = {
        ...originalEnv,
        DATA_DIR: dataDir,
        KISMATIK_CHAT_IDS: [...chats.keys()].join(','),
        KISMATIK_EMBEDDER: 'none',
        OWNER_TG_IDS: OWNER_ID,
        ...options.env,
    };

    // Virtual clock: Date is faked and moved explicitly, so nothing depends on wall time.
    vi.useFakeTimers({ toFake: ['Date'] });
    let clock = T0;
    vi.setSystemTime(clock);

    const llm = {
        calls: [] as Array<LlmInput & { kind: LlmKind }>,
        hooks: {} as Partial<Record<LlmKind, LlmHook>>,
        count: (kind: LlmKind) => llm.calls.filter((call) => call.kind === kind).length,
    };
    const sent: Array<{ chatId: string; html: string; replyTo?: number }> = [];
    const replies: Array<{ chatId: string; text: string; replyTo?: number }> = [];
    const defaults: Record<LlmKind, LlmHook> = {
        answer: ({ user }) => {
            const ids = [...user.matchAll(/\[msg:(\d+)\]/g)].map((match) => match[1]);
            return ids.length ? `Это обсуждали [msg:${ids[0]}] и [msg:${ids[ids.length - 1]}]` : 'NO_ANSWER';
        },
        signals: () => '{"items":[]}',
        match: () => '{"pick":1}',
    };

    let mods = await loadModules();

    async function loadModules() {
        vi.resetModules();
        const m = {
            store: await import('../kismatik/store'),
            llm: await import('../kismatik/llm'),
            embedder: await import('../kismatik/embedder'),
            answer: await import('../kismatik/answer'),
            inbound: await import('../kismatik/inbound'),
            digest: await import('../kismatik/digest'),
            retrieve: await import('../kismatik/retrieve'),
            importer: await import('../kismatik/import'),
            config: await import('../kismatik/config'),
        };
        m.embedder.setEmbedderForTest(options.embedder === false ? null : hashEmbedder);
        m.llm.setKismatikLlmForTest(async (input) => {
            const kind = kindOf(input.system);
            llm.calls.push({ ...input, kind });
            return (llm.hooks[kind] ?? defaults[kind])(input);
        });
        m.digest.setGroupSender({
            sendHtml: async (chatId, html, replyTo) => void sent.push({ chatId, html, replyTo }),
        });
        return m;
    }

    const nextId = new Map<string, number>();
    const idFor = (chatId: string, explicit?: number) => {
        if (explicit !== undefined) {
            nextId.set(chatId, Math.max(nextId.get(chatId) ?? 0, explicit));
            return explicit;
        }
        const id = (nextId.get(chatId) ?? 0) + 1;
        nextId.set(chatId, id);
        return id;
    };
    const chatOf = (chatId: string) => {
        const chat = chats.get(chatId) ?? { id: chatId };
        return { id: Number(chat.id), type: chat.type ?? 'supergroup', title: chat.title, username: chat.username };
    };
    const channelOf = (c: SimChat) => ({
        id: Number(c.id),
        title: c.title,
        username: c.username,
        type: c.type ?? 'channel',
    });
    const dateOf = (at?: number) => Math.floor((at ?? clock) / 1000);

    type MsgOpts = { id?: number; at?: number; name?: string; replyTo?: number; threadId?: number };

    function build(chatId: string, fromId: number | string, text: string, o: MsgOpts = {}): SimUpdate {
        const message: any = {
            message_id: idFor(chatId, o.id),
            text,
            date: dateOf(o.at),
            chat: chatOf(chatId),
            from: { id: Number(fromId), first_name: o.name ?? `User${fromId}` },
        };
        if (o.replyTo !== undefined) message.reply_to_message = { message_id: o.replyTo };
        if (o.threadId !== undefined) message.message_thread_id = o.threadId;
        return { chat: message.chat, from: message.from, message, update: { message } };
    }

    const sim = {
        dataDir,
        llm,
        sent,
        replies,
        get mods() {
            return mods;
        },
        chatId: (id: string | number) => String(id),
        get now() {
            return clock;
        },
        advance(ms: number) {
            clock += ms;
            vi.setSystemTime(clock);
            return clock;
        },
        setTime(ts: number) {
            clock = ts;
            vi.setSystemTime(clock);
        },

        /* ------------------------------------------------------ update builders */
        message: build,
        reply: (chatId: string, fromId: number | string, text: string, replyTo: number, o: MsgOpts = {}) =>
            build(chatId, fromId, text, { ...o, replyTo }),
        mention: (chatId: string, fromId: number | string, text: string, o: MsgOpts = {}) =>
            build(chatId, fromId, `@${BOT_USERNAME} ${text}`, o),
        command: (chatId: string, fromId: number | string, text: string, o: MsgOpts = {}) =>
            build(chatId, fromId, text, o),
        channelPost(channel: SimChat, text: string, o: MsgOpts = {}): SimUpdate {
            const chatId = String(channel.id);
            const chat = channelOf(channel);
            const post = { message_id: idFor(chatId, o.id), text, date: dateOf(o.at), chat };
            return { chat, update: { channel_post: post } };
        },
        /** The channel post as mirrored into the discussion group. */
        autoForward(chatId: string, channel: SimChat, text: string, o: MsgOpts & { originId: number }): SimUpdate {
            const origin = channelOf(channel);
            const message = {
                message_id: idFor(chatId, o.id),
                text,
                date: dateOf(o.at),
                chat: chatOf(chatId),
                is_automatic_forward: true,
                sender_chat: origin,
                forward_origin: { type: 'channel', chat: origin, message_id: o.originId },
            };
            return {
                chat: message.chat,
                from: { id: TG_SERVICE_ID, first_name: 'Telegram', is_bot: false },
                message,
                update: { message },
            };
        },
        comment: (chatId: string, fromId: number | string, text: string, postId: number, o: MsgOpts = {}) =>
            build(chatId, fromId, text, { ...o, threadId: postId, replyTo: o.replyTo ?? postId }),
        anonymousAdmin(chatId: string, text: string, o: MsgOpts = {}): SimUpdate {
            const upd = build(chatId, ANON_ADMIN_ID, text, o);
            upd.from = { id: ANON_ADMIN_ID, is_bot: true, first_name: 'Group' };
            upd.message.from = upd.from;
            upd.message.sender_chat = chatOf(chatId);
            return upd;
        },
        asChannel(chatId: string, channel: SimChat, text: string, o: MsgOpts = {}): SimUpdate {
            const upd = build(chatId, CHANNEL_BOT_ID, text, o);
            upd.from = { id: CHANNEL_BOT_ID, is_bot: true, first_name: 'Channel' };
            upd.message.from = upd.from;
            upd.message.sender_chat = channelOf(channel);
            return upd;
        },
        callback(chatId: string, fromId: number | string): SimUpdate {
            const upd = build(chatId, fromId, '');
            const query = { id: 'cb1', from: upd.from, data: 'x', message: upd.message };
            return { ...upd, message: undefined, update: { callback_query: query } };
        },

        /* ------------------------------------------------------------- driving */
        /** Run one update through the real handler. Returns whether KISMATIK consumed it. */
        async feed(upd: SimUpdate): Promise<{ handled: boolean; replies: string[] }> {
            const mine: string[] = [];
            const chatId = String(upd.chat.id);
            const ctx = {
                update: upd.update,
                chat: upd.chat,
                from: upd.from,
                message: upd.message,
                botInfo: { id: 5000, username: BOT_USERNAME },
                reply: async (text: string) => {
                    mine.push(text);
                    replies.push({ chatId, text, replyTo: upd.message?.message_id });
                },
                sendChatAction: async () => undefined,
            };
            const handled = await mods.inbound.handleKismatikUpdate(ctx as any);
            return { handled, replies: mine };
        },
        async feedAll(updates: SimUpdate[]) {
            for (const upd of updates) await sim.feed(upd);
        },

        /** Close quiet chunks and run one digest pass at the current virtual time. */
        digest: (chatId: string) => mods.digest.digestCommunity(chatId, clock),
        closeStale(chatId: string) {
            return mods.store.closeStaleChunks(chatId, clock, mods.config.kismatikConfig().chunkGapMs);
        },
        /** Embed every closed chunk (needs an embedder; run with embedder != none). */
        async embedAll(chatId: string) {
            sim.closeStale(chatId);
            while ((await mods.digest.embedPending(chatId)) > 0);
        },

        /** Close the database and reload every module, as a process restart would. */
        async restart() {
            mods.store.closeKismatikDb();
            mods = await loadModules();
        },
        dispose() {
            try {
                mods.store.closeKismatikDb();
            } catch {
                // already closed
            }
            vi.useRealTimers();
            process.env = originalEnv;
            fs.rmSync(dataDir, { recursive: true, force: true });
        },
    };
    return sim;
}

export type Sim = Awaited<ReturnType<typeof createSim>>;
