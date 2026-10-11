/**
 * The community wiki, after Karpathy's LLM-Wiki: an LLM keeps interlinked
 * pages about people, places, organisations, events, job boards and topics,
 * updating them one conversation at a time, and answers list questions by
 * reading the index and then whole pages.
 *
 * On a year of @foodconnections (201 posts, 48 synthesis questions, three
 * runs, blind judges) wiki pages plus four search chunks raised list recall
 * from 0.57 to 0.75 over search alone; the owner's own blind pairwise check
 * preferred them 10 to 4.
 *
 * Every fact on a page carries [msg:ID]. A model may only cite the
 * conversation it is reading or ids already on the page, and a bullet left
 * without a citation is dropped: an uncited line is the wiki talking, not
 * the community.
 */

import { logInfo, logWarn } from '../utils/logging';
import { kismatikConfig } from './config';
import { kismatikLlm, parseJsonLoose } from './llm';
import { getCommunity, getKismatikDb, type Chunk } from './store';

export const FOLDERS = ['people', 'places', 'orgs', 'events', 'jobs', 'topics'] as const;
const PATH_RE = /^(?:(?:people|places|orgs|events|jobs|topics)\/[a-z0-9][a-z0-9-]{0,60}\.md|overview\.md)$/;
export const PAGE_CAP = 7000;
const MAX_PAGES_PER_SOURCE = 8;
const MAX_ATTEMPTS = 3;
const HOUR = 60 * 60 * 1000;

export interface WikiPage {
    path: string;
    title: string;
    summary: string;
    category: string;
    body: string;
    msg_ids: number[];
    updated_at: number;
}

/* ------------------------------------------------------------------- pages */

function rowToPage(row: any): WikiPage {
    return { ...row, msg_ids: JSON.parse(row.msg_ids) };
}

export function getPage(chatId: string, path: string): WikiPage | undefined {
    const row = getKismatikDb().prepare(`SELECT * FROM wiki_pages WHERE chat_id = ? AND path = ?`).get(chatId, path);
    return row ? rowToPage(row) : undefined;
}

export function listPages(chatId: string): WikiPage[] {
    return (
        getKismatikDb().prepare(`SELECT * FROM wiki_pages WHERE chat_id = ? ORDER BY path`).all(chatId) as any[]
    ).map(rowToPage);
}

function savePage(chatId: string, page: Omit<WikiPage, 'msg_ids' | 'updated_at'>, now: number): void {
    getKismatikDb()
        .prepare(
            `INSERT INTO wiki_pages (chat_id, path, title, summary, category, body, msg_ids, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(chat_id, path) DO UPDATE SET title = excluded.title, summary = excluded.summary,
               category = excluded.category, body = excluded.body, msg_ids = excluded.msg_ids, updated_at = excluded.updated_at`
        )
        .run(
            chatId,
            page.path,
            page.title,
            page.summary,
            page.category,
            page.body,
            JSON.stringify([...citedIds(page.body)].sort((a, b) => a - b)),
            now
        );
}

/** The catalogue the model navigates by: one line per page, grouped by kind. */
export function indexText(chatId: string): string {
    const pages = listPages(chatId);
    const lines: string[] = [];
    for (const folder of [...FOLDERS, 'overview']) {
        const group = pages.filter((p) => p.category === folder);
        if (group.length === 0) continue;
        lines.push(`## ${folder}`);
        for (const p of group) lines.push(`- [[${p.path}]] — ${p.title}: ${p.summary}`);
        lines.push('');
    }
    return lines.join('\n');
}

/* --------------------------------------------------------------- citations */

const CITE_RE = /\[msg:(\d+(?:\s*,\s*(?:msg:)?\d+)*)\]/g;

export function citedIds(body: string): Set<number> {
    const ids = new Set<number>();
    for (const m of body.matchAll(CITE_RE)) for (const n of m[1].matchAll(/\d+/g)) ids.add(Number(n[0]));
    return ids;
}

const BULLET = /^\s*[-*•]\s+\S/;

/**
 * Keep citations to `allowed` ids only. A line whose every citation was
 * invalid goes, and so does any bullet with no citation at all.
 */
export function sanitizeBody(body: string, allowed: Set<number>): { body: string; dropped: number } {
    let dropped = 0;
    const out: string[] = [];
    for (const line of body.split('\n')) {
        let invalid = 0;
        let valid = 0;
        const cleaned = line.replace(CITE_RE, (_m, list: string) => {
            const ids = [...list.matchAll(/\d+/g)].map((x) => Number(x[0]));
            const keep = ids.filter((id) => allowed.has(id));
            invalid += ids.length - keep.length;
            valid += keep.length;
            return keep.length ? `[msg:${keep.join(', ')}]` : '';
        });
        if ((invalid > 0 && valid === 0) || (BULLET.test(line) && valid === 0)) {
            dropped += 1;
            continue;
        }
        out.push(invalid > 0 ? cleaned.replace(/\s+$/, '') : line);
    }
    return { body: out.join('\n'), dropped };
}

/** `/km forget`: the message leaves every page; facts that rested on it alone go with it. */
export function forgetInWiki(chatId: string, messageId: number, now = Date.now()): number {
    let changed = 0;
    for (const page of listPages(chatId)) {
        if (!page.msg_ids.includes(messageId)) continue;
        const allowed = new Set(page.msg_ids.filter((id) => id !== messageId));
        const { body } = sanitizeBody(page.body, allowed);
        if (citedIds(body).size === 0) {
            getKismatikDb().prepare(`DELETE FROM wiki_pages WHERE chat_id = ? AND path = ?`).run(chatId, page.path);
        } else {
            savePage(chatId, { ...page, body }, now);
        }
        changed += 1;
    }
    return changed;
}

/* ------------------------------------------------------------------ schema */

function schema(chatId: string): string {
    const title = getCommunity(chatId)?.title || 'сообщества';
    return [
        `# Схема вики «${title}»`,
        '',
        'Ты — редактор вики Telegram-сообщества. Источник — переписка и посты (у каждого сообщения id: [msg:ID]). Вики — связанные markdown-страницы, которые ведёшь только ты. Люди читают вики вместо сырой переписки, поэтому каждая новая порция ДОПОЛНЯЕТ существующие страницы, а не плодит дубликаты.',
        '',
        '## Типы страниц и папки',
        '- `people/<slug>.md` — люди, о которых есть содержательные данные: город, страна, роль, опыт, что ищут и что предлагают. Контакты — только @хэндлы, уже публично названные. Один человек = одна страница.',
        '- `places/<slug>.md` — хабы городов и стран: кто там (ссылки на people), вакансии (ссылка на jobs), события, заведения.',
        '- `orgs/<slug>.md` — заведения, компании, проекты, медиа.',
        '- `events/<slug>.md` — серии и разовые события: даты, место, цена, программа, спикеры, итоги по каждой редакции.',
        '- `jobs/<slug>.md` — доска вакансий по стране или городу; каждая вакансия — пункт: работодатель, город, позиция, условия, как откликнуться, дата.',
        '- `topics/<slug>.md` — повторяющиеся темы.',
        '- `overview.md` — краткий обзор сообщества (обновляй редко).',
        '`slug` — латиница в нижнем регистре, цифры и дефисы.',
        '',
        '## Формат',
        'Первая строка — `# Название`, затем короткий абзац-резюме и разделы со списками. Без таблиц и HTML.',
        '',
        '## Правила',
        '1. Пиши по-русски; имена и названия — как в источнике.',
        '2. Каждый факт заканчивается ссылкой [msg:ID]. Пункт без ссылки будет удалён. Ссылаться можно только на сообщения текущей порции или на уже указанные на этой странице.',
        '3. Ничего не выдумывай и не переноси на человека или место то, что относится к другому.',
        '4. Различай, что сделало само сообщество, а что лишь анонсировано или упомянуто (чужие события, чужие вакансии).',
        '5. Даты — абсолютные; относительные пересчитывай от даты сообщения.',
        '6. Связывай страницы ссылками [[путь]] на страницы из индекса или создаваемые сейчас.',
        '7. Одна сущность — одна страница. Есть подходящая в индексе — обнови её.',
        '8. Не затирай прежние факты: сохраняй всё, что было, добавляй новое; противоречия фиксируй с обеими ссылками.',
        '9. Болтовня, приветствия, реакции без фактов — не повод менять вики.',
    ].join('\n');
}

const STEP_A = (s: string) =>
    [
        s,
        '',
        '## Задача — шаг A: выбор страниц',
        'Дан индекс вики и новая порция переписки. Реши, какие страницы создать или обновить.',
        `Не больше ${MAX_PAGES_PER_SOURCE} путей. Предпочитай существующие страницы. Если фактов нет — пустой список.`,
        'Ответь ТОЛЬКО JSON: {"pages": ["people/ivan-petrov.md", "places/lisbon.md"]}',
    ].join('\n');

const STEP_B = (s: string) =>
    [
        s,
        '',
        '## Задача — шаг B: написание страниц',
        'Даны порция переписки и текущие тексты выбранных страниц (или пометка «новая страница»). Верни ПОЛНЫЕ новые тексты: всё, что было, плюс новые факты.',
        `Страница ≤ ${PAGE_CAP - 1000} символов; если не помещается — сожми формулировки, не теряя фактов и ссылок.`,
        'Ответь ТОЛЬКО JSON, переводы строк экранируй (\\n):',
        '{"pages":[{"path":"...","title":"Название","summary_one_line":"одна строка для индекса","body":"# Название\\n..."}]}',
    ].join('\n');

const STEP_SPLIT = (s: string) =>
    [
        s,
        '',
        '## Задача — разделить слишком большую страницу',
        `Страница больше ${PAGE_CAP} символов. Раздели по смыслу на 2–3: первая сохраняет путь, остальные получают суффикс -2, -3 в той же папке.`,
        'Ничего не теряй: все факты и все ссылки [msg:ID] остаются. Добавь перекрёстные ссылки [[путь]] и короткое резюме в начале каждой.',
        'Ответь ТОЛЬКО JSON: {"pages":[{"path":"...","title":"...","summary_one_line":"...","body":"# ...\\n..."}]}',
    ].join('\n');

type PageOut = { path: string; title?: string; summary_one_line?: string; body: string };

async function jsonStep<T>(system: string, user: string, maxTokens: number, validate: (v: any) => T | null) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await kismatikLlm()({
            system,
            user:
                attempt === 0
                    ? user
                    : `${user}\n\nПрошлый ответ не разобрался. Верни СТРОГО валидный JSON без ограждений; пути — только из <pages>.`,
            maxTokens,
            temperature: 0.1,
            timeoutMs: 180_000,
        });
        const parsed = parseJsonLoose<any>(raw);
        const valid = parsed ? validate(parsed) : null;
        if (valid) return valid;
    }
    return null;
}

function pagesOf(v: any, allowed: (path: string) => boolean): PageOut[] | null {
    const list = Array.isArray(v) ? v : v?.pages;
    if (!Array.isArray(list)) return null;
    const ok = list
        .filter((x: any) => x && typeof x.path === 'string' && typeof x.body === 'string')
        .map((x: any) => ({ ...x, path: x.path.trim() }))
        .filter((x: PageOut) => allowed(x.path));
    return ok.length ? ok : null;
}

async function split(s: string, page: PageOut): Promise<PageOut[] | null> {
    const base = page.path.replace(/\.md$/, '');
    const wanted = new Set([page.path, `${base}-2.md`, `${base}-3.md`]);
    const before = citedIds(page.body);
    return jsonStep(STEP_SPLIT(s), `<page path="${page.path}">\n${page.body}\n</page>`, 12_000, (v) => {
        const parts = pagesOf(v, (p) => wanted.has(p));
        if (!parts || parts.length < 2 || parts.some((x) => x.body.length > PAGE_CAP)) return null;
        const after = new Set(parts.flatMap((x) => [...citedIds(x.body)]));
        return [...before].every((id) => after.has(id)) ? parts : null;
    });
}

/**
 * Fold one conversation into the wiki. Throws when the model's output could
 * not be used, so the caller counts an attempt rather than calling it done.
 */
export async function ingestChunk(chatId: string, chunk: Chunk, now = Date.now()): Promise<string[]> {
    const s = schema(chatId);
    const date = new Date(chunk.first_ts).toISOString().slice(0, 10);
    const source = `<conversation date="${date}">\n${chunk.text.slice(0, 14_000)}\n</conversation>`;

    const planned = await jsonStep<string[]>(
        STEP_A(s),
        `<index>\n${indexText(chatId)}\n</index>\n\n${source}`,
        2_500,
        (v) => {
            const list = Array.isArray(v) ? v : v?.pages;
            return Array.isArray(list) ? list.filter((p: any) => typeof p === 'string') : null;
        }
    );
    if (planned === null) throw new Error('step A returned no usable plan');
    const paths = [
        ...new Set(planned.map((p) => p.trim().replace(/^\[\[|\]\]$/g, '')).filter((p) => PATH_RE.test(p))),
    ].slice(0, MAX_PAGES_PER_SOURCE);
    if (paths.length === 0) return [];

    const current = paths
        .map((p) => {
            const page = getPage(chatId, p);
            return page ? `<page path="${p}">\n${page.body}\n</page>` : `<page path="${p}">(новая страница)</page>`;
        })
        .join('\n');
    const written = await jsonStep(STEP_B(s), `<pages>\n${current}\n</pages>\n\n${source}`, 30_000, (v) =>
        pagesOf(v, (p) => paths.includes(p))
    );
    if (written === null) throw new Error(`step B returned no usable pages for ${paths.join(', ')}`);

    const saved: string[] = [];
    for (const page of written) {
        const old = getPage(chatId, page.path);
        const allowed = new Set([...chunk.msg_ids, ...(old?.msg_ids ?? [])]);
        let pieces: PageOut[] = [{ ...page, body: sanitizeBody(page.body, allowed).body }];
        if (pieces[0].body.length > PAGE_CAP) pieces = (await split(s, pieces[0])) ?? pieces;
        for (const piece of pieces) {
            const body = sanitizeBody(piece.body, allowed).body.slice(0, PAGE_CAP).trim() + '\n';
            if (citedIds(body).size === 0) continue;
            const category = piece.path === 'overview.md' ? 'overview' : piece.path.split('/')[0];
            const title = String(piece.title || body.match(/^#\s+(.+)$/m)?.[1] || piece.path)
                .replace(/\s+/g, ' ')
                .slice(0, 120);
            const summary = String(piece.summary_one_line || '')
                .replace(/\s+/g, ' ')
                .slice(0, 220);
            savePage(chatId, { path: piece.path, title, summary, category, body }, now);
            saved.push(piece.path);
        }
    }
    return saved;
}

/* ------------------------------------------------------------------- queue */

export function wikiChunksThisHour(now: number): number {
    const row = getKismatikDb()
        .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE wiki_at IS NOT NULL AND wiki_at > ?`)
        .get(now - HOUR) as { n: number };
    return row.n;
}

/**
 * Work through quiet conversations oldest first, within an hourly allowance:
 * each costs two or more model calls, and PiPi stops every model call past
 * 120 an hour. A failure is counted and retried later, never marked done.
 */
export async function ingestPending(
    chatId: string,
    now = Date.now(),
    perCall = 2
): Promise<{ done: number; failed: number }> {
    const result = { done: 0, failed: 0 };
    const allowance = Math.min(perCall, kismatikConfig().wikiChunksPerHour - wikiChunksThisHour(now));
    if (allowance <= 0) return result;
    const db = getKismatikDb();
    const pending = (
        db
            .prepare(
                `SELECT * FROM chunks WHERE chat_id = ? AND closed = 1 AND wiki_state = 0 AND wiki_attempts < ?
                 ORDER BY first_ts, id LIMIT ?`
            )
            .all(chatId, MAX_ATTEMPTS, allowance) as any[]
    ).map((row) => ({ ...row, msg_ids: JSON.parse(row.msg_ids) }) as Chunk);

    for (const chunk of pending) {
        try {
            const pages = await ingestChunk(chatId, chunk, now);
            db.prepare(`UPDATE chunks SET wiki_state = 1, wiki_at = ? WHERE chat_id = ? AND id = ?`).run(
                now,
                chatId,
                chunk.id
            );
            result.done += 1;
            if (pages.length)
                logInfo('KISMATIK', 'wiki_updated', { chat_id: chatId, chunk: chunk.id, pages: pages.join(',') });
        } catch (error: any) {
            const attempts = (chunk as any).wiki_attempts + 1;
            db.prepare(
                `UPDATE chunks SET wiki_attempts = ?, wiki_state = ?, wiki_at = ? WHERE chat_id = ? AND id = ?`
            ).run(attempts, attempts >= MAX_ATTEMPTS ? 2 : 0, now, chatId, chunk.id);
            result.failed += 1;
            logWarn('KISMATIK', 'wiki_ingest_failed', {
                chat_id: chatId,
                chunk: chunk.id,
                attempts,
                message: error?.message,
            });
        }
    }
    return result;
}

/* ------------------------------------------------------------------- query */

const SELECT = [
    'Ты — навигатор по вики сообщества. Дан каталог страниц (категория → строка на страницу) и вопрос.',
    'Выбери до 5 страниц, которые нужно прочитать целиком, чтобы полно ответить. Для перечня про страну или город — хаб места и доску вакансий или страницы событий; про человека — его страницу; для хронологии — страницу события или серии.',
    'Нет подходящих — пустой список. Ответь ТОЛЬКО JSON: {"pages": ["путь.md"]}',
].join('\n');

export async function selectPages(chatId: string, question: string): Promise<WikiPage[]> {
    const index = indexText(chatId);
    if (!index.trim()) return [];
    const raw = await kismatikLlm()({
        system: SELECT,
        user: `<index>\n${index}\n</index>\n\n<question>${question}</question>`,
        maxTokens: 800,
        temperature: 0,
    });
    const parsed = parseJsonLoose<any>(raw);
    const list: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.pages) ? parsed.pages : [];
    const pages: WikiPage[] = [];
    for (const item of list) {
        const page = getPage(
            chatId,
            String(item)
                .trim()
                .replace(/^\[\[|\]\]$/g, '')
        );
        if (page && !pages.some((p) => p.path === page.path)) pages.push(page);
    }
    return pages.slice(0, 5);
}
