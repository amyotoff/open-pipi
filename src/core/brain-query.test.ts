import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadQuery(responses: string[] = []) {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-query-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-key' };

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
    it('reads stored state ahead of conflicting narrative pages and accepts only supplied state citations', async () => {
        const { brain, query, generateBrainText } = await loadQuery([
            'Website is active [State](state/space/website.json); [Fake](state/space/fake.json).',
        ]);
        const state = await import('./brain-state');
        state.updateStoredState({
            ...scope,
            id: 'website',
            expected_revision: 0,
            patch_json: JSON.stringify({
                kind: 'project',
                title: 'Website',
                set_fields: {
                    phase: {
                        value: 'active',
                        status: 'known',
                        observed_at: '2026-10-24T10:00:00Z',
                        source: 'message:m1',
                    },
                },
            }),
            actor: '111',
            source: 'turn:t1',
        });
        brain.updateWikiPage({
            ...scope,
            path: 'projects/website.md',
            body: '# Website\n\nOld conversation: website is cancelled.',
        });
        const answer = await query.answerFromWiki({ ...scope, question: 'Website status' });
        const prompt = generateBrainText.mock.calls[0][0].prompt;
        expect(prompt).toContain('"value":"active"');
        expect(prompt).toContain('website is cancelled');
        expect(prompt.indexOf('<state_snapshots_json>')).toBeLessThan(prompt.indexOf('<wiki_pages_json>'));
        expect(generateBrainText.mock.calls[0][0].system).toContain('Prefer these runtime-read records');
        expect(answer.citations).toEqual(['state/space/website.json']);
    });

    it('retains narrative evidence when a broad state match does not cover the requested project', async () => {
        const { brain, query, generateBrainText } = await loadQuery(['Orion has a budget of 5000.']);
        const state = await import('./brain-state');
        state.updateStoredState({
            ...scope,
            id: 'atlas',
            expected_revision: 0,
            patch_json: JSON.stringify({ kind: 'project', title: 'Atlas', set_fields: {} }),
            actor: '111',
            source: 'turn:t1',
        });
        brain.updateWikiPage({
            ...scope,
            path: 'projects/orion.md',
            body: '# Orion\n\nProject Orion launch budget: 5000.',
        });
        await query.answerFromWiki({ ...scope, question: 'What is the launch budget for Project Orion?' });
        const prompt = generateBrainText.mock.calls[0][0].prompt;
        expect(prompt).toContain('Project Orion launch budget: 5000');
        expect(prompt.indexOf('<state_snapshots_json>')).toBeLessThan(prompt.indexOf('<wiki_pages_json>'));
    });

    it('keeps explanations in narrative retrieval without manufacturing a state object', async () => {
        const { brain, query, generateBrainText } = await loadQuery(['Plumbers have limited availability.']);
        brain.updateWikiPage({
            ...scope,
            path: 'home/plumbers.md',
            body: '# Plumber\n\nWhy calling a plumber is difficult: limited availability.',
        });
        await query.answerFromWiki({ ...scope, question: 'Why is calling a plumber difficult?' });
        expect(generateBrainText.mock.calls[0][0].prompt).toContain('limited availability');
        expect(generateBrainText.mock.calls[0][0].prompt).toContain('"snapshots":[]');
        const state = await import('./brain-state');
        expect(state.listStoredStates(scope).documents).toEqual([]);
    });

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

    it('passes typed state and its evidence to the answer model with freshness and history rules', async () => {
        const { brain, query, generateBrainText } = await loadQuery(['A live apartment check is needed.']);
        const state = {
            schema_version: 1,
            subject: { id: 'apartment', kind: 'apartment' },
            fields: {
                'kitchen.temperature': {
                    value: 21.5,
                    unit: '°C',
                    status: 'known',
                    observed_at: '2026-10-24T10:00:00Z',
                    source: 'tool:observation-1',
                    refresh: { provider: 'home_assistant', entity_id: 'sensor.kitchen_temperature' },
                    max_age_seconds: 60,
                },
                'kitchen.light_on': {
                    value: false,
                    status: 'known',
                    observed_at: '2026-10-24T10:00:00Z',
                    source: 'tool:observation-2',
                },
                'kitchen.humidity': { value: null, status: 'unknown', observed_at: null, source: null },
            },
        };
        const body = '# Apartment state\n\n## Current state\n\n```json\n' + JSON.stringify(state) + '\n```';
        brain.updateWikiPage({ ...scope, path: 'homes/apartment.md', body });

        const before = Date.now();
        await query.answerFromWiki({ ...scope, question: 'apartment state' });
        const call = generateBrainText.mock.calls[0][0];
        const pages = JSON.parse(call.prompt.match(/<wiki_pages_json>\n([\s\S]*?)\n<\/wiki_pages_json>/)[1]);
        const suppliedState = JSON.parse(pages[0].content.match(/```json\n([\s\S]*?)\n```/)[1]);
        expect(suppliedState).toEqual(state);
        const currentTime = Date.parse(call.prompt.match(/Current time \(UTC\): ([^\n]+)/)[1]);
        expect(currentTime).toBeGreaterThanOrEqual(before);
        expect(currentTime).toBeLessThanOrEqual(Date.now());
        expect(call.system).toContain('structured JSON state before searching space dialogue');
        expect(call.system).toContain('cannot refresh external state');
        expect(call.system).toContain('For historical questions');
        expect(query.buildWikiContextBlock({ ...scope, query: 'apartment state' })).toContain(
            'structured JSON state before searching space dialogue'
        );
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

    it('reserves result and answer-context slots for a relevant chat-local page', async () => {
        const { brain, query, store, generateBrainText } = await loadQuery([
            'The chat budget is €42 [Actual budget](finance/actual-budget.md).',
        ]);
        const shared = store.sharedScope(scope);
        for (let index = 0; index < 10; index += 1) {
            brain.updateWikiPage({
                ...shared,
                path: `finance/shared-${index}.md`,
                body: `# Shared mention ${index}\n\nA passing budget mention for item ${index}.`,
            });
        }
        brain.updateWikiPage({
            ...scope,
            path: 'finance/actual-budget.md',
            body: '# Actual budget\n\nThe budget for this chat is €42.',
        });

        const hits = query.searchWiki({ ...scope, query: 'budget', limit: 8 });
        const answer = await query.answerFromWiki({ ...scope, question: 'What is the budget?' });

        expect(hits).toHaveLength(8);
        expect(hits.map((hit) => hit.path)).toContain('finance/actual-budget.md');
        expect(answer.citations).toContain('finance/actual-budget.md');
        expect(generateBrainText.mock.calls[0][0].prompt).toContain('finance/actual-budget.md');
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
