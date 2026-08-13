import { BrainScopeInput, clampLimit, dayStamp, nowIso, slugify, withScopeLock } from './brain-store';
import {
    BrainWikiPage,
    WikiSearchHit,
    appendWikiLog,
    normalizeWikiPath,
    readWikiPage,
    searchWikiRows,
    visibilityForReader,
    writeWikiPageInternal,
} from './brain-wiki';
import { generateBrainText } from './brain-model';

/**
 * Query: how the wiki pays for itself.
 *
 * Two paths. The explicit one answers a question the owner asked. The passive one puts
 * index rows — never page bodies — into every turn's context, next to the memory blocks,
 * so the wiki improves ordinary answers rather than waiting to be consulted (D11).
 */

export interface WikiAnswer {
    text: string;
    citations: string[];
    searched: boolean;
}

const MAX_ANSWER_PAGES = 5;
const MAX_PAGE_CHARS = 8000;
const DEFAULT_WIKI_BLOCK_CHARS = 900;

const ANSWER_SYSTEM = [
    'You answer from a personal knowledge wiki that you maintain for its owner.',
    'Prefer what the wiki says over your own prior knowledge, and say so when the wiki is silent.',
    'Cite the pages you used as markdown links with their wiki-relative paths, for example [Anna](people/anna.md).',
    'Do not invent page paths, numbers, or dates. If the pages do not answer the question, say that plainly.',
    'Answer in the language the question was asked in.',
].join('\n');

/**
 * Search and direct read answer to the same rule (D3): whoever cannot open a page by path
 * does not find it by searching either.
 */
export function searchWiki(
    input: { query: string; limit?: number; personId?: string } & BrainScopeInput
): WikiSearchHit[] {
    if (!input.query.trim()) return [];
    return searchWikiRows({
        spaceId: input.spaceId,
        query: input.query,
        limit: input.limit,
        visibility: visibilityForReader({ spaceId: input.spaceId, personId: input.personId }),
    });
}

/**
 * Answer a question from the wiki. Never reports an empty wiki without having searched
 * both the index and full text, and always says that it searched.
 */
export async function answerFromWiki(
    input: { question: string; limit?: number; personId?: string } & BrainScopeInput
): Promise<WikiAnswer> {
    const hits = searchWiki({ ...input, query: input.question, limit: clampLimit(input.limit, 6, 1, 12) });
    if (hits.length === 0) {
        return {
            text: 'I searched the wiki index and its full text and found no page on this. Nothing has been compiled about it yet.',
            citations: [],
            searched: true,
        };
    }

    const pages = hits.slice(0, MAX_ANSWER_PAGES).map((hit) => {
        const page = readWikiPage(hit.path, { spaceId: input.spaceId });
        return `<page path="${hit.path}" title="${hit.title.replace(/"/g, "'")}">\n${page.content.substring(0, MAX_PAGE_CHARS)}\n</page>`;
    });

    const text = await generateBrainText({
        system: ANSWER_SYSTEM,
        mode: 'executor',
        spaceId: input.spaceId,
        prompt: [`<question>\n${input.question}\n</question>`, '<wiki_pages>', pages.join('\n'), '</wiki_pages>'].join(
            '\n'
        ),
    });

    return {
        text: text.trim(),
        citations: hits.slice(0, MAX_ANSWER_PAGES).map((hit) => hit.path),
        searched: true,
    };
}

/**
 * File a good answer back into the wiki as an archive page. Archive pages are
 * point-in-time snapshots: they cite wiki pages rather than raw sources, are never
 * merged into an existing page, and are never cascade-updated by a later ingest.
 */
export async function archiveAnswer(
    input: { title: string; body: string; topic?: string; citations?: string[]; now?: Date } & BrainScopeInput
): Promise<BrainWikiPage> {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new Error('An archived answer needs a title.');
    if (!body) throw new Error('An archived answer cannot be empty.');

    const scope: BrainScopeInput = { spaceId: input.spaceId };
    const topic = slugify(input.topic || 'archive', 40);

    return withScopeLock(scope, async () => {
        // An archive is a point-in-time snapshot, so it never replaces an existing page —
        // not an earlier snapshot of the same question, and not a canonical article whose
        // title happens to slugify the same way.
        const base = `${topic}/${slugify(title)}`;
        let relativePath = normalizeWikiPath(`${base}.md`);
        for (let suffix = 2; readWikiPage(relativePath, scope).exists; suffix += 1) {
            relativePath = normalizeWikiPath(`${base}-${suffix}.md`);
        }

        const page = writeWikiPageInternal(scope, relativePath, body.startsWith('#') ? body : `# ${title}\n\n${body}`, {
            title,
            kind: 'archive',
            sources: [...new Set(input.citations || [])],
            archived_at: dayStamp(nowIso(input.now)),
        });

        appendWikiLog({ ...scope, action: 'query', subject: `Archived: ${title}`, now: input.now });
        return page;
    });
}

/**
 * The `[WIKI]` block for the system prompt: index rows only, hard-capped. The agent
 * pulls a body with read_wiki_page when it decides it needs one.
 */
export function buildWikiContextBlock(
    input: { query: string; maxChars?: number; limit?: number; personId?: string } & BrainScopeInput
): string {
    const query = input.query.trim();
    if (!query) return '';

    let hits: WikiSearchHit[];
    try {
        hits = searchWiki({
            spaceId: input.spaceId,
            personId: input.personId,
            query,
            limit: clampLimit(input.limit, 5, 1, 10),
        });
    } catch {
        // The wiki is an enhancement to the turn, never a reason to fail it.
        return '';
    }
    if (hits.length === 0) return '';

    const budget = clampLimit(input.maxChars, DEFAULT_WIKI_BLOCK_CHARS, 200, 4000);
    const lines: string[] = [];
    let used = 0;

    for (const hit of hits) {
        const line = `- ${hit.path} — ${hit.title}: ${hit.excerpt.substring(0, 120)} (${hit.knowledge_updated_at})`;
        if (used + line.length > budget) break;
        lines.push(line);
        used += line.length + 1;
    }

    if (lines.length === 0) return '';
    return `[WIKI]\nCompiled pages that may bear on this turn. Read one with read_wiki_page before relying on it.\n${lines.join('\n')}`;
}
