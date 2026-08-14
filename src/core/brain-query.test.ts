import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadQuery(responses: string[] = []) {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-query-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, GEMINI_API_KEY: 'test-key' };

    const generateBrainText = vi.fn();
    for (const response of responses) generateBrainText.mockResolvedValueOnce(response);

    vi.doMock('./brain-model', async () => {
        const actual = await vi.importActual<typeof import('./brain-model')>('./brain-model');
        return { ...actual, generateBrainText };
    });

    return {
        brain: await import('./brain'),
        query: await import('./brain-query'),
        wiki: await import('./brain-wiki'),
        store: await import('./brain-store'),
        generateBrainText,
    };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const store = await import('./brain-store');
        store.closeBrainDatabases();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.doUnmock('./brain-model');
    vi.resetModules();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
});

const scope = { spaceId: 'telegram:chat-1' };

describe('core/brain-query', () => {
    it('finds pages by full text and by title', async () => {
        const { brain, query } = await loadQuery();

        brain.updateWikiPage({
            ...scope,
            path: 'health/sleep.md',
            body: '# Sleep\n\nSleep debt accumulates across the week and shows up as an afternoon dip.',
        });
        brain.updateWikiPage({ ...scope, path: 'people/anna.md', body: '# Anna\n\nRuns in the morning.' });

        expect(query.searchWiki({ ...scope, query: 'afternoon dip' }).map((hit) => hit.path)).toEqual([
            'health/sleep.md',
        ]);
        expect(query.searchWiki({ ...scope, query: 'Anna' }).map((hit) => hit.path)).toEqual(['people/anna.md']);
        expect(query.searchWiki({ ...scope, query: 'nothing here at all' })).toHaveLength(0);
    });

    it('keeps owner-only pages out of space search, matching what a direct read allows', async () => {
        const { brain, query } = await loadQuery();

        brain.updateWikiPage({ ...scope, path: 'health/sleep.md', body: '# Sleep\n\nShared sleep notes.' });
        brain.updateWikiPage({
            ...scope,
            path: 'health/private.md',
            body: '---\n{"visibility":"owner"}\n---\n# Private\n\nSleep secrets.',
        });

        const visible = query.searchWiki({ ...scope, query: 'sleep' }).map((hit) => hit.path);
        expect(visible).toContain('health/sleep.md');
        expect(visible).not.toContain('health/private.md');

        // The host-level wiki has no space audience, so owner pages are in scope there.
        expect(query.searchWiki({ query: 'sleep' })).toBeInstanceOf(Array);
    });

    it('says it searched rather than claiming the wiki is empty', async () => {
        const { query, generateBrainText } = await loadQuery();

        const answer = await query.answerFromWiki({ ...scope, question: 'What do I know about sleep?' });

        expect(answer.searched).toBe(true);
        expect(answer.citations).toHaveLength(0);
        expect(answer.text).toContain('searched the wiki index and its full text');
        expect(generateBrainText).not.toHaveBeenCalled();
    });

    it('answers from pages and returns their paths as citations', async () => {
        const { brain, query, generateBrainText } = await loadQuery([
            'Sleep debt builds over the week — see [Sleep](health/sleep.md).',
        ]);

        brain.updateWikiPage({
            ...scope,
            path: 'health/sleep.md',
            body: '# Sleep\n\nSleep debt accumulates across the week.',
        });

        const answer = await query.answerFromWiki({ ...scope, question: 'sleep debt' });

        expect(answer.citations).toEqual(['health/sleep.md']);
        expect(answer.text).toContain('Sleep debt builds over the week');
        // The page body reaches the model; the question is fenced separately.
        const call = generateBrainText.mock.calls[0][0];
        expect(call.prompt).toContain('<wiki_pages_json>');
        expect(call.prompt).toContain('"path":"health/sleep.md"');
        expect(call.prompt).toContain('<question>');
        expect(call.system).toContain('untrusted reference data');
    });

    it('reports only citations that appear in the answer and were actually supplied to the model', async () => {
        const { brain, query } = await loadQuery([
            'Use [Sleep](health/sleep.md), not an invented [Secret](health/secret.md).',
        ]);
        brain.updateWikiPage({ ...scope, path: 'health/sleep.md', body: '# Sleep\n\nSleep debt.' });

        const answer = await query.answerFromWiki({ ...scope, question: 'sleep debt' });

        expect(answer.citations).toEqual(['health/sleep.md']);
        expect(answer.citations).not.toContain('health/secret.md');
    });

    it('keeps relevance ahead of freshness and produces clean excerpts', async () => {
        const { brain, query } = await loadQuery();
        brain.updateWikiPage({
            ...scope,
            path: 'campaigns/orbit-coffee.md',
            body: '# Orbit Coffee campaign\n\nBudget and CPA launch plan for 2026-09-15. See [KPIs](../analytics/kpis.md).',
        });
        brain.updateWikiPage({
            ...scope,
            path: 'people/bob.md',
            body: '# Bob\n\nBob briefly mentioned Orbit Coffee.',
        });

        const hits = query.searchWiki({ ...scope, query: 'Orbit Coffee budget CPA launch' });
        const block = query.buildWikiContextBlock({ ...scope, query: 'Orbit Coffee budget CPA launch' });

        expect(hits[0].path).toBe('campaigns/orbit-coffee.md');
        expect(block).toContain('2026-09-15');
        expect(block).toContain('See KPIs');
        expect(block).not.toContain('../analytics/kpis.md');
        expect(block).toContain('untrusted index data');
    });

    it('ranks shared knowledge before local drafts without comparing scores from different indexes', async () => {
        const { brain, query, store } = await loadQuery();
        brain.updateWikiPage({
            ...store.sharedScope(scope),
            path: 'people/anna.md',
            body: '# Anna\n\nAnna leads strategy for the agency.',
        });
        brain.updateWikiPage({
            ...scope,
            path: 'people/anna-draft.md',
            body: `# Anna draft\n\n${'Anna strategy '.repeat(20)}`,
        });

        const hits = query.searchWiki({ ...scope, query: 'Anna strategy' });

        expect(hits[0]).toMatchObject({ path: 'people/anna.md', origin: 'shared' });
        expect(hits.find((hit) => hit.path === 'people/anna-draft.md')).toMatchObject({ origin: 'space' });
    });

    it('archives an answer into the shared wiki and logs it', async () => {
        const { brain, query, store } = await loadQuery();

        const page = await query.archiveAnswer({
            ...scope,
            title: 'Sleep vs focus',
            body: 'The comparison, as of today.',
            topic: 'health',
            citations: ['health/sleep.md'],
            now: new Date('2026-08-13T10:00:00.000Z'),
        });

        expect(page.path).toBe('health/sleep-vs-focus.md');
        expect(page.content).toContain('"kind": "archive"');
        expect(page.content).toContain('"archived_at": "2026-08-13"');
        expect(page.content).toContain('health/sleep.md');

        const shared = store.sharedScope(scope);
        expect(brain.readWikiLog(shared)[0]).toMatchObject({
            action: 'query',
            subject: 'Archived: Sleep vs focus',
        });

        // An explicit save belongs to the household, not to the chat it was asked in.
        expect(brain.readWikiPage(page.path, shared).exists).toBe(true);
        expect(brain.readWikiPage(page.path, scope).exists).toBe(false);

        // Archives are marked in the generated catalogue.
        expect(brain.projectWikiIndexFile(shared)).toContain('[Archived]');
    });

    it('builds a capped [WIKI] block of index rows, never page bodies', async () => {
        const { brain, query } = await loadQuery();

        brain.updateWikiPage({
            ...scope,
            path: 'health/sleep.md',
            body: '# Sleep\n\nSleep debt accumulates across the week and shows up as an afternoon dip.',
        });

        const block = query.buildWikiContextBlock({ ...scope, query: 'sleep debt' });
        expect(block).toContain('[WIKI]');
        expect(block).toContain('health/sleep.md');
        expect(block).toContain('read_wiki_page');
        expect(block.length).toBeLessThanOrEqual(1200);

        expect(query.buildWikiContextBlock({ ...scope, query: '' })).toBe('');
        expect(query.buildWikiContextBlock({ ...scope, query: 'unrelated gibberish' })).toBe('');
    });

    it('never overwrites an existing page when archiving', async () => {
        const { brain, query, store } = await loadQuery();

        const first = await query.archiveAnswer({
            ...scope,
            title: 'Same title',
            body: 'First answer.',
            topic: 'health',
        });
        const second = await query.archiveAnswer({
            ...scope,
            title: 'Same title',
            body: 'Second answer.',
            topic: 'health',
        });

        const shared = store.sharedScope(scope);
        expect(first.path).toBe('health/same-title.md');
        expect(second.path).toBe('health/same-title-2.md');
        // A snapshot that replaces the earlier snapshot is not a snapshot.
        expect(brain.readWikiPage(first.path, shared).content).toContain('First answer.');
        expect(brain.readWikiPage(second.path, shared).content).toContain('Second answer.');
    });

    it('does not clobber a canonical article whose title slugifies the same way', async () => {
        const { brain, query, store } = await loadQuery();

        const shared = store.sharedScope(scope);
        brain.updateWikiPage({ ...shared, path: 'health/sleep.md', body: '# Sleep\n\nCanonical article.' });
        const archived = await query.archiveAnswer({ ...scope, title: 'Sleep', body: 'An answer.', topic: 'health' });

        expect(archived.path).toBe('health/sleep-2.md');
        expect(brain.readWikiPage('health/sleep.md', shared).content).toContain('Canonical article.');
    });
});
