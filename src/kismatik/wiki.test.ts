/**
 * The community wiki against real SQLite with a scripted model. The model is
 * routed by its system prompt: index navigation, step A (pick pages), step B
 * (write pages), answers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const A = '-1001111111111';
const B = '-1002222222222';
const OPTS = { gapMs: 10 * 60_000, maxChars: 1500 };
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
let dataDir: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kismatik-wiki-'));
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: dataDir,
        KISMATIK_CHAT_IDS: `${A},${B}`,
        KISMATIK_EMBEDDER: 'none',
        KISMATIK_WIKI: 'on',
    };
    vi.resetModules();
});

afterEach(async () => {
    (await import('./store')).closeKismatikDb();
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(dataDir, { recursive: true, force: true });
});

type Script = {
    stepA?: (user: string) => string;
    stepB?: (user: string) => string;
    select?: (user: string) => string;
    answer?: (user: string) => string;
};

async function load(script: Script = {}) {
    const store = await import('./store');
    const llm = await import('./llm');
    const wiki = await import('./wiki');
    const answer = await import('./answer');
    const calls: string[] = [];
    llm.setKismatikLlmForTest(async ({ system, user }) => {
        if (system.includes('навигатор по вики'))
            return (calls.push('select'), (script.select ?? (() => '{"pages":[]}'))(user));
        if (system.includes('шаг A')) return (calls.push('A'), (script.stepA ?? (() => '{"pages":[]}'))(user));
        if (system.includes('шаг B')) return (calls.push('B'), (script.stepB ?? (() => '{"pages":[]}'))(user));
        calls.push('answer');
        return (script.answer ?? (() => 'NO_ANSWER'))(user);
    });
    return { store, wiki, answer, calls };
}

function seed(store: typeof import('./store'), chatId: string, texts: string[]) {
    texts.forEach((text, i) =>
        store.addMessage(
            chatId,
            { message_id: i + 1, user_id: `10${i}`, user_name: `U${i}`, text, ts: T0 + i * 60_000 },
            OPTS
        )
    );
    store.closeStaleChunks(chatId, T0 + 10 * 60 * 60_000, OPTS.gapMs);
}

const page = (p: string, body: string) =>
    JSON.stringify({ pages: [{ path: p, title: 'Лиссабон', summary_one_line: 'город', body }] });

describe('sanitizeBody', () => {
    it('keeps allowed citations, drops invented ones and every uncited bullet', async () => {
        const { wiki } = await load();
        const { body, dropped } = wiki.sanitizeBody(
            [
                '# Лиссабон',
                'Город в Португалии [msg:1].',
                '- Никита держит ресторан [msg:1, 77]',
                '- Выдумка [msg:77]',
                '- Без источника',
                'Абзац без ссылки остаётся.',
            ].join('\n'),
            new Set([1])
        );
        expect(body).toContain('- Никита держит ресторан [msg:1]');
        expect(body).not.toContain('Выдумка');
        expect(body).not.toContain('Без источника');
        expect(body).toContain('Абзац без ссылки остаётся.');
        expect(dropped).toBe(2);
    });
});

describe('ingest', () => {
    it('writes only planned, valid paths and keeps the index current', async () => {
        const { store, wiki } = await load({
            stepA: () => '{"pages": ["places/lisbon.md", "../etc/passwd", "Places/Bad Path.md"]}',
            stepB: () => page('places/lisbon.md', '# Лиссабон\n- Никита открыл ресторан [msg:1]\n- Слух [msg:99]'),
        });
        seed(store, A, ['Никита открыл ресторан в Лиссабоне']);
        const result = await wiki.ingestPending(A, T0 + 11 * 60 * 60_000);
        expect(result).toEqual({ done: 1, failed: 0 });
        const saved = wiki.getPage(A, 'places/lisbon.md')!;
        expect(saved.body).toContain('[msg:1]');
        expect(saved.body).not.toContain('Слух');
        expect(saved.msg_ids).toEqual([1]);
        expect(wiki.indexText(A)).toContain('[[places/lisbon.md]] — Лиссабон: город');
        expect(wiki.listPages(B)).toHaveLength(0);
        expect(wiki.indexText(B)).toBe('');
    });

    it('counts a failed conversation and gives up after three attempts', async () => {
        const { store, wiki } = await load({ stepA: () => 'not json' });
        seed(store, A, ['Что-то']);
        for (let hour = 0; hour < 3; hour++) {
            expect((await wiki.ingestPending(A, T0 + (11 + hour * 2) * 60 * 60_000)).failed).toBe(1);
        }
        expect((await wiki.ingestPending(A, T0 + 20 * 60 * 60_000)).failed).toBe(0);
        const row = store
            .getKismatikDb()
            .prepare(`SELECT wiki_state, wiki_attempts FROM chunks WHERE chat_id = ?`)
            .get(A);
        expect(row).toEqual({ wiki_state: 2, wiki_attempts: 3 });
    });

    it('stays within the hourly allowance shared by all communities', async () => {
        process.env.KISMATIK_WIKI_CHUNKS_PER_HOUR = '1';
        const { store, wiki } = await load({ stepA: () => '{"pages":[]}' });
        // Two conversations an hour apart in A, one in B.
        store.addMessage(A, { message_id: 1, user_id: '1', user_name: 'U', text: 'раз', ts: T0 }, OPTS);
        store.addMessage(A, { message_id: 2, user_id: '1', user_name: 'U', text: 'два', ts: T0 + 60 * 60_000 }, OPTS);
        store.addMessage(B, { message_id: 1, user_id: '1', user_name: 'U', text: 'три', ts: T0 }, OPTS);
        const now = T0 + 10 * 60 * 60_000;
        store.closeStaleChunks(A, now, OPTS.gapMs);
        store.closeStaleChunks(B, now, OPTS.gapMs);
        expect((await wiki.ingestPending(A, now)).done).toBe(1);
        expect((await wiki.ingestPending(A, now)).done).toBe(0);
        expect((await wiki.ingestPending(B, now)).done).toBe(0);
        expect((await wiki.ingestPending(B, now + 61 * 60_000)).done).toBe(1);
    });
});

describe('answers with the wiki', () => {
    it('reads the chosen pages and links facts that only the page cites', async () => {
        const { store, wiki, answer, calls } = await load({
            stepA: () => '{"pages":["places/lisbon.md"]}',
            stepB: () => page('places/lisbon.md', '# Лиссабон\n- Никита держит ресторан Santelmo [msg:1]'),
            select: () => '{"pages":["places/lisbon.md","people/nobody.md"]}',
            answer: (user) => {
                expect(user).toContain('<wiki path="places/lisbon.md">');
                return 'В Лиссабоне работает Никита [msg:1] и кто-то ещё [msg:500].';
            },
        });
        seed(store, A, ['Никита держит ресторан Santelmo в Лиссабоне']);
        await wiki.ingestPending(A, T0 + 11 * 60 * 60_000);
        // The question shares no words with the chat, so only the wiki page can answer it.
        const html = await answer.answerQuestion(A, 'кто у нас в португальской столице?');
        expect(html).toContain('/1111111111/1"');
        expect(html).not.toContain('500');
        expect(calls).toContain('select');
    });

    it('asks nothing of the wiki when it is off', async () => {
        process.env.KISMATIK_WIKI = 'off';
        const { store, answer, calls } = await load({ answer: () => 'Обсуждали [msg:1]' });
        seed(store, A, ['Проектор есть у Бори']);
        await answer.answerQuestion(A, 'у кого проектор');
        expect(calls).toEqual(['answer']);
    });
});

describe('forget', () => {
    it('removes the message from every page and drops a page left with no source', async () => {
        const { store, wiki } = await load({
            stepA: () => '{"pages":["places/lisbon.md","people/nikita.md"]}',
            stepB: () =>
                JSON.stringify({
                    pages: [
                        {
                            path: 'places/lisbon.md',
                            title: 'Лиссабон',
                            body: '# Лиссабон\n- Никита [msg:1]\n- Борис [msg:2]',
                        },
                        { path: 'people/nikita.md', title: 'Никита', body: '# Никита\n- Ресторан [msg:1]' },
                    ],
                }),
        });
        seed(store, A, ['Никита в Лиссабоне', 'Борис тоже']);
        await wiki.ingestPending(A, T0 + 11 * 60 * 60_000);
        expect(wiki.forgetInWiki(A, 1)).toBe(2);
        expect(wiki.getPage(A, 'places/lisbon.md')!.body).not.toContain('Никита');
        expect(wiki.getPage(A, 'people/nikita.md')).toBeUndefined();
    });
});
