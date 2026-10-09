/**
 * KISMATIK against real SQLite, with fake LLM, embedder and Telegram. No
 * network: the model and the bot are both stand-ins that record what they saw.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const A = '-1001111111111';
const B = '-1002222222222';
const OWNER = '999';

let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kismatik-'));
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: dataDir,
        KISMATIK_CHAT_IDS: `${A},${B}`,
        KISMATIK_EMBEDDER: 'none',
        OWNER_TG_IDS: OWNER,
    };
    vi.resetModules();
});

afterEach(async () => {
    const store = await import('./store');
    store.closeKismatikDb();
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(dataDir, { recursive: true, force: true });
});

async function load() {
    const store = await import('./store');
    const llm = await import('./llm');
    const embedder = await import('./embedder');
    const answer = await import('./answer');
    const inbound = await import('./inbound');
    const digest = await import('./digest');
    const text = await import('./text');
    return { store, llm, embedder, answer, inbound, digest, text };
}

const OPTS = { gapMs: 10 * 60_000, maxChars: 1500 };
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function msg(id: number, user: string, text: string, ts = T0 + id * 60_000) {
    return { message_id: id, user_id: user, user_name: `User${user}`, text, ts };
}

/** A fake model that records every prompt and answers from a script. */
function scriptedLlm(answer: (input: { system: string; user: string }) => string) {
    const calls: Array<{ system: string; user: string }> = [];
    const fn = async (input: { system: string; user: string }) => {
        calls.push(input);
        return answer(input);
    };
    return { fn, calls };
}

function fakeCtx(chatId: string, fromId: string, message: any, extra: Partial<Record<string, any>> = {}) {
    const replies: Array<{ text: string; extra: any }> = [];
    return {
        replies,
        ctx: {
            update: { message },
            chat: { id: Number(chatId), type: 'supergroup', title: 'Test' },
            from: { id: Number(fromId), first_name: `User${fromId}` },
            message,
            botInfo: { id: 5000, username: 'km_bot' },
            reply: async (text: string, replyExtra: any) => {
                replies.push({ text, extra: replyExtra });
            },
            sendChatAction: async () => undefined,
            ...extra,
        },
    };
}

describe('text', () => {
    it('stems Russian inflections onto one form and drops question words', async () => {
        const { text } = await load();
        expect(text.stemText('проектора')).toBe(text.stemText('проектору'));
        expect(text.stemText('ёлка')).toBe(text.stemText('елка'));
        expect(text.toStemQuery('Кто знает, где взять проектор?')).toBe('"взят" OR "проектор"');
    });
});

describe('store', () => {
    it('folds a conversation into one chunk and starts another after silence', async () => {
        const { store } = await load();
        expect(store.addMessage(A, msg(1, '101', 'привет'), OPTS)).toBe(true);
        expect(store.addMessage(A, msg(2, '102', 'как дела'), OPTS)).toBe(true);
        expect(store.addMessage(A, msg(3, '101', 'вернулся', T0 + 60 * 60_000), OPTS)).toBe(true);
        const chunks = store.getChunks(A, [1, 2]);
        expect(chunks.map((chunk) => chunk.msg_ids)).toEqual([[1, 2], [3]]);
        expect(chunks[0].closed).toBe(1);
    });

    it('ignores a redelivered message', async () => {
        const { store } = await load();
        expect(store.addMessage(A, msg(1, '101', 'раз'), OPTS)).toBe(true);
        expect(store.addMessage(A, msg(1, '101', 'раз'), OPTS)).toBe(false);
    });

    it("never returns one community's chunks to another", async () => {
        const { store, text } = await load();
        store.addMessage(A, msg(1, '101', 'Могу одолжить проектор'), OPTS);
        store.addMessage(B, msg(1, '101', 'Рецепт борща'), OPTS);
        expect(store.searchChunksFts(A, text.toStemQuery('проектор'), 10)).toHaveLength(1);
        expect(store.searchChunksFts(B, text.toStemQuery('проектор'), 10)).toHaveLength(0);
        const idInA = store.searchChunksFts(A, text.toStemQuery('проектор'), 10)[0].id;
        expect(store.getChunks(B, [idInA])).toHaveLength(0);
    });

    it('forgets a message from search and from its chunk', async () => {
        const { store, text } = await load();
        store.addMessage(A, msg(1, '101', 'Мой телефон 123'), OPTS);
        store.addMessage(A, msg(2, '102', 'Привет всем'), OPTS);
        expect(store.forgetMessage(A, 1)).toBe(true);
        expect(store.searchChunksFts(A, text.toStemQuery('телефон'), 10)).toHaveLength(0);
        expect(store.getChunks(A, [1])[0].text).not.toContain('телефон');
    });
});

describe('answers', () => {
    it('answers from the community with links to the cited messages', async () => {
        const { store, llm, answer } = await load();
        store.addMessage(A, msg(7, '101', 'Пробовали Whisper для расшифровки интервью, таймкоды врут'), OPTS);
        const model = scriptedLlm(() => 'User101 пробовал Whisper, но таймкоды врут [msg:7]. [msg:999]');
        llm.setKismatikLlmForTest(model.fn);

        const html = await answer.answerQuestion(A, 'чем расшифровать интервью?');
        expect(html).toContain('href="https://t.me/c/1111111111/7"');
        // A citation the model invented is dropped, not linked.
        expect(html).not.toContain('999');
        expect(model.calls[0].user).toContain('[msg:7]');
    });

    it('says it does not know instead of answering from general knowledge', async () => {
        const { store, llm, answer } = await load();
        store.addMessage(A, msg(1, '101', 'Кто идёт на пикник в субботу?'), OPTS);
        llm.setKismatikLlmForTest(scriptedLlm(() => 'Обычно пикник лучше в парке.').fn);
        expect(await answer.answerQuestion(A, 'где пикник?')).toBe(answer.NOTHING_FOUND);

        llm.setKismatikLlmForTest(scriptedLlm(() => 'NO_ANSWER').fn);
        expect(await answer.answerQuestion(A, 'где пикник?')).toBe(answer.NOTHING_FOUND);
    });

    it("never shows the model another community's messages", async () => {
        const { store, llm, answer } = await load();
        store.addMessage(A, msg(1, '101', 'Секретный рецепт проектора из группы А'), OPTS);
        const model = scriptedLlm(() => 'NO_ANSWER');
        llm.setKismatikLlmForTest(model.fn);
        expect(await answer.answerQuestion(B, 'проектор')).toBe(answer.NOTHING_FOUND);
        expect(model.calls).toHaveLength(0);
    });

    it('points at the discussion when the model is down', async () => {
        const { store, llm, answer } = await load();
        store.addMessage(A, msg(4, '101', 'Велосипед чинит мастер на Ленина'), OPTS);
        llm.setKismatikLlmForTest(async () => {
            throw new Error('timeout');
        });
        const html = await answer.answerQuestion(A, 'где починить велосипед');
        expect(html).toContain('https://t.me/c/1111111111/4');
    });

    it('ranks by vector similarity within the community only', async () => {
        const { store, llm, embedder, answer, digest } = await load();
        // One axis per topic: the "embedding" is a one-hot on whether the text mentions a bike.
        const fake = {
            id: 'fake@2',
            embedDocuments: async (texts: string[]) => texts.map((t) => vec(t)),
            embedQuery: async (t: string) => vec(t),
        };
        function vec(t: string) {
            return /велос|байк/i.test(t) ? new Float32Array([1, 0]) : new Float32Array([0, 1]);
        }
        embedder.setEmbedderForTest(fake);
        store.addMessage(A, msg(1, '101', 'Мой байк скрипит', T0), OPTS);
        store.addMessage(A, msg(2, '102', 'Погода отличная', T0 + 60 * 60_000), OPTS);
        store.addMessage(B, msg(1, '103', 'Продаю велосипед', T0), OPTS);
        store.closeStaleChunks(A, T0 + 10 * 60 * 60_000, OPTS.gapMs);
        store.closeStaleChunks(B, T0 + 10 * 60 * 60_000, OPTS.gapMs);
        await digest.embedPending(A);
        await digest.embedPending(B);

        const model = scriptedLlm(({ user }) => (user.includes('скрипит') ? 'Скрипит байк [msg:1]' : 'NO_ANSWER'));
        llm.setKismatikLlmForTest(model.fn);
        // No shared words with the stored text: only the vector side can find it.
        const html = await answer.answerQuestion(A, 'велосипед');
        expect(html).toContain('/1111111111/1');
        expect(model.calls[0].user).not.toContain('Продаю');
    });
});

describe('inbound', () => {
    it('leaves non-KISMATIK chats and private chats to PiPi', async () => {
        const { inbound } = await load();
        const other = fakeCtx('-1003333333333', '101', { message_id: 1, text: 'hi', date: 1 });
        expect(await inbound.handleKismatikUpdate(other.ctx as any)).toBe(false);
        const dm = fakeCtx('101', '101', { message_id: 1, text: 'hi', date: 1 });
        dm.ctx.chat = { id: 101, type: 'private', title: '' };
        expect(await inbound.handleKismatikUpdate(dm.ctx as any)).toBe(false);
    });

    it('consumes and remembers ambient chatter without replying', async () => {
        const { inbound, store } = await load();
        const { ctx, replies } = fakeCtx(A, '101', {
            message_id: 10,
            text: 'Кто знает хорошего стоматолога?',
            date: 1,
        });
        expect(await inbound.handleKismatikUpdate(ctx as any)).toBe(true);
        expect(replies).toHaveLength(0);
        expect(store.getMessage(A, 10)?.text).toContain('стоматолога');
    });

    it("swallows PiPi commands from members but lets the owner's through", async () => {
        const { inbound } = await load();
        const member = fakeCtx(A, '101', { message_id: 1, text: '/setup', date: 1 });
        expect(await inbound.handleKismatikUpdate(member.ctx as any)).toBe(true);
        const owner = fakeCtx(A, OWNER, { message_id: 2, text: '/setup', date: 1 });
        expect(await inbound.handleKismatikUpdate(owner.ctx as any)).toBe(false);
    });

    it('answers when mentioned', async () => {
        const { inbound, llm } = await load();
        llm.setKismatikLlmForTest(scriptedLlm(() => 'Стоматолога советовали [msg:10]').fn);
        await inbound.handleKismatikUpdate(
            fakeCtx(A, '101', { message_id: 10, text: 'Хороший стоматолог на Мира', date: 1 }).ctx as any
        );
        const { ctx, replies } = fakeCtx(A, '102', { message_id: 11, text: '@km_bot где стоматолог?', date: 2 });
        await inbound.handleKismatikUpdate(ctx as any);
        expect(replies).toHaveLength(1);
        expect(replies[0].text).toContain('/1111111111/10');
        expect(replies[0].extra.parse_mode).toBe('HTML');
    });

    it('lets only the author or the owner make it forget a message', async () => {
        const { inbound, store } = await load();
        await inbound.handleKismatikUpdate(
            fakeCtx(A, '101', { message_id: 20, text: 'мой адрес', date: 1 }).ctx as any
        );
        const stranger = fakeCtx(A, '102', {
            message_id: 21,
            text: '/km forget',
            date: 2,
            reply_to_message: { message_id: 20 },
        });
        await inbound.handleKismatikUpdate(stranger.ctx as any);
        expect(store.getMessage(A, 20)).toBeDefined();
        const author = fakeCtx(A, '101', {
            message_id: 22,
            text: '/km forget',
            date: 3,
            reply_to_message: { message_id: 20 },
        });
        await inbound.handleKismatikUpdate(author.ctx as any);
        expect(store.getMessage(A, 20)).toBeUndefined();
    });

    it('stops remembering when the owner turns it off', async () => {
        const { inbound, store } = await load();
        await inbound.handleKismatikUpdate(fakeCtx(A, '101', { message_id: 1, text: '/km off', date: 1 }).ctx as any);
        expect(store.isPaused(A)).toBe(false);
        await inbound.handleKismatikUpdate(fakeCtx(A, OWNER, { message_id: 2, text: '/km off', date: 1 }).ctx as any);
        expect(store.isPaused(A)).toBe(true);
        await inbound.handleKismatikUpdate(fakeCtx(A, '101', { message_id: 3, text: 'тишина', date: 1 }).ctx as any);
        expect(store.getMessage(A, 3)).toBeUndefined();
    });

    it('ignores other bots and commands addressed to other bots', async () => {
        const { inbound, store } = await load();
        const botMsg = fakeCtx(A, '777', { message_id: 1, text: 'я бот', date: 1 });
        (botMsg.ctx.from as any).is_bot = true;
        expect(await inbound.handleKismatikUpdate(botMsg.ctx as any)).toBe(true);
        expect(store.getMessage(A, 1)).toBeUndefined();
        const foreign = fakeCtx(A, '101', { message_id: 2, text: '/km@other_bot help', date: 1 });
        await inbound.handleKismatikUpdate(foreign.ctx as any);
        expect(foreign.replies).toHaveLength(0);
    });
});

describe('needs and offers', () => {
    async function seed() {
        const mods = await load();
        const now = T0 + 60 * 60_000;
        mods.store.addMessage(A, msg(1, '101', 'Ищу проектор на пятницу'), OPTS);
        mods.store.addMessage(A, msg(2, '102', 'Могу одолжить проектор на выходные'), OPTS);
        mods.store.closeStaleChunks(A, now + 60 * 60_000, OPTS.gapMs);
        return { ...mods, now };
    }

    it('extracts only signals that point at real messages', async () => {
        const { store, llm, digest, now } = await seed();
        llm.setKismatikLlmForTest(
            scriptedLlm(() =>
                JSON.stringify({
                    items: [
                        { kind: 'need', msg: 1, summary: 'проектор на пятницу' },
                        { kind: 'offer', msg: 2, summary: 'проектор на выходные' },
                        { kind: 'offer', msg: 404, summary: 'выдумка' },
                    ],
                })
            ).fn
        );
        const signals = await digest.extractSignals(A, store.listChunksToDigest(A, 10), now);
        expect(signals.map((s) => [s.kind, s.message_id, s.user_id])).toEqual([
            ['need', 1, '101'],
            ['offer', 2, '102'],
        ]);
    });

    it('suggests a match once, tagging both people', async () => {
        const { store, llm, digest, now } = await seed();
        llm.setKismatikLlmForTest(scriptedLlm(() => '{"pick": 1}').fn);
        const need = store.addSignal(A, {
            kind: 'need',
            message_id: 1,
            user_id: '101',
            user_name: 'Аня',
            summary: 'проектор на пятницу',
            expires_at: now + 1e9,
        })!;
        store.addSignal(A, {
            kind: 'offer',
            message_id: 2,
            user_id: '102',
            user_name: 'Боря',
            summary: 'одолжу проектор',
            expires_at: now + 1e9,
        });
        const sent: Array<{ chatId: string; html: string; reply?: number }> = [];
        digest.setGroupSender({ sendHtml: async (chatId, html, reply) => void sent.push({ chatId, html, reply }) });

        expect(await digest.matchSignals(A, [store.getSignal(A, need)!], now)).toBe(1);
        expect(sent[0].chatId).toBe(A);
        expect(sent[0].reply).toBe(1);
        expect(sent[0].html).toContain('tg://user?id=101');
        expect(sent[0].html).toContain('tg://user?id=102');
        // Already matched: not suggested again.
        expect(await digest.matchSignals(A, [store.getSignal(A, need)!], now)).toBe(0);
    });

    it('never matches across communities or a person with themselves', async () => {
        const { store, llm, digest, now } = await seed();
        llm.setKismatikLlmForTest(scriptedLlm(() => '{"pick": 1}').fn);
        const need = store.addSignal(A, {
            kind: 'need',
            message_id: 1,
            user_id: '101',
            user_name: 'Аня',
            summary: 'проектор',
            expires_at: now + 1e9,
        })!;
        store.addSignal(A, {
            kind: 'offer',
            message_id: 3,
            user_id: '101',
            user_name: 'Аня',
            summary: 'проектор отдам',
            expires_at: now + 1e9,
        });
        store.addSignal(B, {
            kind: 'offer',
            message_id: 2,
            user_id: '102',
            user_name: 'Боря',
            summary: 'проектор',
            expires_at: now + 1e9,
        });
        const sent: string[] = [];
        digest.setGroupSender({ sendHtml: async (_c, html) => void sent.push(html) });
        expect(await digest.matchSignals(A, [store.getSignal(A, need)!], now)).toBe(0);
        expect(sent).toHaveLength(0);
    });
});

describe('import', () => {
    it('loads a Telegram Desktop export once, skipping service and authorless messages', async () => {
        const { store } = await load();
        const { importTelegramExport, exportChatId } = await import('./import');
        const data = {
            name: 'Соседи',
            type: 'private_supergroup',
            id: 1111111111,
            messages: [
                {
                    id: 2,
                    type: 'message',
                    date_unixtime: '1759320060',
                    from: 'Боря',
                    from_id: 'user102',
                    text: [{ type: 'bold', text: 'Могу' }, ' одолжить дрель'],
                },
                {
                    id: 1,
                    type: 'message',
                    date_unixtime: '1759320000',
                    from: 'Аня',
                    from_id: 'user101',
                    text: 'Ищу дрель',
                },
                { id: 3, type: 'service', date_unixtime: '1759320100', action: 'join_group_by_link' },
                {
                    id: 4,
                    type: 'message',
                    date_unixtime: '1759320200',
                    from: 'Аноним',
                    text: 'без автора',
                },
            ],
        };
        expect(exportChatId(data)).toBe(A);
        expect(importTelegramExport(data as any, A)).toEqual({ imported: 2, skipped: 2, duplicates: 0 });
        expect(importTelegramExport(data as any, A)).toEqual({ imported: 0, skipped: 2, duplicates: 2 });
        expect(store.getMessage(A, 2)?.text).toBe('Могу одолжить дрель');
        expect(store.getMessage(A, 1)?.user_id).toBe('101');
    });
});

const CH = { id: -1009999999999, title: 'Food Connections', username: 'foodconnections', type: 'channel' };

/** A channel post as it lands in the linked discussion group. */
function autoForward(id: number, text: string, originId: number, date = 1_790_000_000) {
    return {
        message_id: id,
        text,
        date,
        is_automatic_forward: true,
        sender_chat: CH,
        forward_origin: { type: 'channel', chat: CH, message_id: originId },
    };
}

function asUser(chatId: string, fromId: string, message: any) {
    return fakeCtx(chatId, fromId, message);
}

describe('channel with discussion group', () => {
    it('stores an automatic forward as a post by the channel with its t.me link', async () => {
        const { inbound, store } = await load();
        const { ctx, replies } = asUser(A, '777000', autoForward(50, 'Новый пост про ферму', 12));
        expect(await inbound.handleKismatikUpdate(ctx as any)).toBe(true);
        const stored = store.getMessage(A, 50)!;
        expect(stored).toMatchObject({
            user_id: String(CH.id),
            user_name: 'Food Connections',
            author_kind: 'chat',
            link: 'https://t.me/foodconnections/12',
            thread_root: 50,
        });
        expect(replies).toHaveLength(0);
    });

    it('keeps a late comment in the post chunk, and a long thread continues under a context line', async () => {
        const { inbound, store } = await load();
        const post = autoForward(50, 'Новый пост про ферму', 12);
        await inbound.handleKismatikUpdate(asUser(A, '777000', post).ctx as any);
        const comment = (id: number, text: string, date: number, extra: any = {}) =>
            asUser(A, '101', { message_id: id, text, date, message_thread_id: 50, ...extra }).ctx as any;
        await inbound.handleKismatikUpdate(comment(51, 'Классно!', post.date + 3 * 3600));
        // Unrelated chatter in between does not break the thread's chunk.
        await inbound.handleKismatikUpdate(
            asUser(A, '102', { message_id: 60, text: 'про погоду', date: post.date + 3 * 3600 + 5 }).ctx as any
        );
        await inbound.handleKismatikUpdate(
            comment(52, 'Согласна', post.date + 3 * 3600 + 10, { reply_to_message: { message_id: 51 } })
        );
        const first = store.getMessage(A, 50)!.chunk_id!;
        expect(store.getMessage(A, 51)!.chunk_id).toBe(first);
        expect(store.getMessage(A, 52)!.chunk_id).toBe(first);
        expect(store.getMessage(A, 60)!.chunk_id).not.toBe(first);
        expect(store.getChunks(A, [first])[0].closed).toBe(0);

        // A comment too big for the chunk starts the next one with the post as context.
        const big = 'очень длинный комментарий '.repeat(60);
        await inbound.handleKismatikUpdate(comment(53, big, post.date + 3 * 3600 + 20));
        const next = store.getMessage(A, 53)!.chunk_id!;
        expect(next).not.toBe(first);
        const chunk = store.getChunks(A, [next])[0];
        expect(chunk.thread_root).toBe(50);
        expect(chunk.text.startsWith('↳ к посту [msg:50]: Новый пост про ферму\n[msg:53]')).toBe(true);
        expect(store.getChunks(A, [first])[0].closed).toBe(1);
        // The unrelated chunk stays open.
        expect(store.getChunks(A, [store.getMessage(A, 60)!.chunk_id!])[0].closed).toBe(0);
    });

    it('resolves thread roots through topic id, reply chain, or not at all', async () => {
        const { store } = await load();
        store.addMessage(A, { ...msg(50, '1', 'пост'), thread_root: 50 }, OPTS);
        store.addMessage(A, { ...msg(51, '2', 'коммент'), thread_id: 50 }, OPTS);
        store.addMessage(A, { ...msg(52, '3', 'ответ'), reply_to: 51 }, OPTS);
        store.addMessage(A, { ...msg(53, '4', 'мимо'), thread_id: 51, reply_to: 7 }, OPTS);
        expect(store.getMessage(A, 51)!.thread_root).toBe(50);
        expect(store.getMessage(A, 52)!.thread_root).toBe(50);
        expect(store.getMessage(A, 53)!.thread_root).toBeNull();
    });

    it('keeps thread chunks inside their community', async () => {
        const { store, text } = await load();
        store.addMessage(A, { ...msg(50, '1', 'пост про проектор'), thread_root: 50 }, OPTS);
        store.addMessage(B, { ...msg(50, '1', 'пост про борщ'), thread_root: 50 }, OPTS);
        store.addMessage(B, { ...msg(51, '2', 'борщ вкусный'), thread_id: 50 }, OPTS);
        expect(store.getMessage(A, 51)).toBeUndefined();
        expect(store.getChunks(A, [store.getMessage(B, 51)!.chunk_id!])).toHaveLength(0);
        expect(store.searchChunksFts(A, text.toStemQuery('борщ'), 10)).toHaveLength(0);
    });

    it('stores anonymous-admin and as-channel messages under the sender chat, but drops real bots', async () => {
        const { inbound, store } = await load();
        const group = { id: Number(A), title: 'Food Chat', type: 'supergroup' };
        const anon = asUser(A, '1087968824', { message_id: 1, text: 'От админов', date: 1, sender_chat: group });
        (anon.ctx.from as any).is_bot = true;
        await inbound.handleKismatikUpdate(anon.ctx as any);
        expect(store.getMessage(A, 1)).toMatchObject({ user_id: A, user_name: 'Food Chat', author_kind: 'chat' });

        const asChannel = asUser(A, '136817688', { message_id: 2, text: 'От канала', date: 2, sender_chat: CH });
        (asChannel.ctx.from as any).is_bot = true;
        await inbound.handleKismatikUpdate(asChannel.ctx as any);
        expect(store.getMessage(A, 2)).toMatchObject({ user_id: String(CH.id), author_kind: 'chat' });
        expect(asChannel.replies).toHaveLength(0);

        const bot = asUser(A, '5000', { message_id: 3, text: 'я бот', date: 3 });
        (bot.ctx.from as any).is_bot = true;
        expect(await inbound.handleKismatikUpdate(bot.ctx as any)).toBe(true);
        expect(store.getMessage(A, 3)).toBeUndefined();
    });

    it('stores a listed channel post and never replies to it', async () => {
        process.env.KISMATIK_CHAT_IDS = `${A},${B},${CH.id}`;
        vi.resetModules();
        const mods = await load();
        const replies: string[] = [];
        const ctx = {
            update: { channel_post: { message_id: 7, text: '@km_bot расскажи?', date: 1_790_000_000, chat: CH } },
            chat: CH,
            botInfo: { id: 5000, username: 'km_bot' },
            reply: async (t: string) => void replies.push(t),
        };
        expect(await mods.inbound.handleKismatikUpdate(ctx as any)).toBe(true);
        expect(mods.store.getMessage(String(CH.id), 7)).toMatchObject({
            author_kind: 'chat',
            link: 'https://t.me/foodconnections/7',
            thread_root: 7,
        });
        expect(replies).toHaveLength(0);
        // An edited post is consumed but not stored again.
        const edited = { ...ctx, update: { edited_channel_post: { message_id: 7, text: 'иначе', date: 1, chat: CH } } };
        expect(await mods.inbound.handleKismatikUpdate(edited as any)).toBe(true);
        expect(mods.store.getMessage(String(CH.id), 7)?.text).toContain('@km_bot');
    });

    it('cites a channel post with its original link', async () => {
        const { inbound, llm, answer } = await load();
        await inbound.handleKismatikUpdate(
            asUser(A, '777000', autoForward(50, 'Ферма принимает волонтёров', 12)).ctx as any
        );
        llm.setKismatikLlmForTest(scriptedLlm(() => 'Ферма ищет волонтёров [msg:50]').fn);
        expect(await answer.answerQuestion(A, 'волонтёры ферма')).toContain('href="https://t.me/foodconnections/12"');
        llm.setKismatikLlmForTest(async () => {
            throw new Error('down');
        });
        expect(await answer.answerQuestion(A, 'волонтёры ферма')).toContain('https://t.me/foodconnections/12');
    });

    it('does not tag a channel as a person in a suggestion', async () => {
        const { store, digest } = await load();
        const now = T0;
        store.addMessage(A, msg(1, '101', 'Ищу волонтёров'), OPTS);
        store.addMessage(
            A,
            {
                ...msg(50, String(CH.id), 'Нужны волонтёры'),
                user_name: 'Food Connections',
                author_kind: 'chat',
                link: 'https://t.me/foodconnections/12',
                thread_root: 50,
            },
            OPTS
        );
        const need = store.getSignal(
            A,
            store.addSignal(A, {
                kind: 'need',
                message_id: 1,
                user_id: '101',
                user_name: 'Аня',
                summary: 'волонтёры',
                expires_at: now + 1e9,
            })!
        )!;
        const offer = store.getSignal(
            A,
            store.addSignal(A, {
                kind: 'offer',
                message_id: 50,
                user_id: String(CH.id),
                user_name: 'Food Connections',
                summary: 'волонтёры на ферме',
                expires_at: now + 1e9,
            })!
        )!;
        const html = digest.renderSuggestion(A, need, offer);
        expect(html).toContain('tg://user?id=101');
        expect(html).not.toContain(`tg://user?id=${CH.id}`);
        expect(html).toContain('Food Connections');
        expect(html).toContain('https://t.me/foodconnections/12');
    });
});

describe('import with channels', () => {
    it('imports a channel export with channel authors and t.me links', async () => {
        const { store } = await load();
        const { importTelegramExport, exportChatId } = await import('./import');
        const data = {
            name: 'Food Connections',
            type: 'public_channel',
            id: 9999999999,
            messages: [
                {
                    id: 3,
                    type: 'message',
                    date_unixtime: '1759320000',
                    from: 'Food Connections',
                    from_id: 'channel9999999999',
                    text: 'Пост',
                },
                {
                    id: 4,
                    type: 'message',
                    date_unixtime: '1759320100',
                    from: 'Food Connections',
                    from_id: 'channel9999999999',
                    text: 'Ещё пост',
                },
            ],
        };
        expect(exportChatId(data)).toBe('-1009999999999');
        const opts = { username: 'foodconnections' };
        expect(importTelegramExport(data as any, '-1009999999999', opts).imported).toBe(2);
        expect(importTelegramExport(data as any, '-1009999999999', opts).duplicates).toBe(2);
        expect(store.getMessage('-1009999999999', 3)).toMatchObject({
            user_id: '-1009999999999',
            author_kind: 'chat',
            link: 'https://t.me/foodconnections/3',
            thread_root: 3,
        });
        // Each post is its own thread, so they do not share a chunk.
        expect(store.getMessage('-1009999999999', 3)!.chunk_id).not.toBe(
            store.getMessage('-1009999999999', 4)!.chunk_id
        );
    });

    it('threads a group export through the forwarded post and its reply chain', async () => {
        const { store } = await load();
        const { importTelegramExport } = await import('./import');
        const data = {
            name: 'Chat',
            type: 'private_supergroup',
            id: 1111111111,
            messages: [
                {
                    id: 50,
                    type: 'message',
                    date_unixtime: '1759320000',
                    from: 'Food Connections',
                    from_id: 'channel9999999999',
                    forwarded_from: 'Food Connections',
                    text: 'Пост',
                },
                {
                    id: 51,
                    type: 'message',
                    date_unixtime: '1759330000',
                    from: 'Аня',
                    from_id: 'user101',
                    reply_to_message_id: 50,
                    text: 'Коммент через три часа',
                },
                {
                    id: 52,
                    type: 'message',
                    date_unixtime: '1759330100',
                    from: 'Боря',
                    from_id: 'user102',
                    reply_to_message_id: 51,
                    text: 'Ответ на коммент',
                },
            ],
        };
        expect(importTelegramExport(data as any, A).imported).toBe(3);
        const chunk = store.getMessage(A, 50)!.chunk_id;
        expect(store.getMessage(A, 51)!.chunk_id).toBe(chunk);
        expect(store.getMessage(A, 52)!.chunk_id).toBe(chunk);
        expect(store.getMessage(A, 52)!.thread_root).toBe(50);
        expect(store.getMessage(A, 50)).toMatchObject({ user_id: '-1009999999999', author_kind: 'chat', link: null });
    });
});
