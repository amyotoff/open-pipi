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
    it('loads a Telegram Desktop export once, skipping service and channel messages', async () => {
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
                    from: 'Канал',
                    from_id: 'channel55',
                    text: 'пост',
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
