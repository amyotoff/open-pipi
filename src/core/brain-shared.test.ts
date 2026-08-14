import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadBrain(responses: string[] = []) {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-shared-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, GEMINI_API_KEY: 'test-key' };

    const generateBrainText = vi.fn();
    for (const response of responses) generateBrainText.mockResolvedValueOnce(response);

    vi.doMock('./brain-model', async () => {
        const actual = await vi.importActual<typeof import('./brain-model')>('./brain-model');
        return { ...actual, generateBrainText };
    });

    return {
        brain: await import('./brain'),
        wiki: await import('./brain-wiki'),
        query: await import('./brain-query'),
        ingest: await import('./brain-ingest'),
        store: await import('./brain-store'),
        generateBrainText,
    };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        (await import('./brain-store')).closeBrainDatabases();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.doUnmock('./brain-model');
    vi.resetModules();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
});

const chatA = { spaceId: 'telegram:chat-a' };
const chatB = { spaceId: 'telegram:chat-b' };

describe('shared wiki', () => {
    it('finds a page saved in one chat from another chat', async () => {
        const { brain, query, store } = await loadBrain();

        brain.updateWikiPage({
            ...store.sharedScope(chatA),
            path: 'people/anna.md',
            body: '# Anna\n\nPrefers the early evening slot for the dentist.',
        });

        const fromB = query.searchWiki({ ...chatB, query: 'Anna dentist' });
        expect(fromB.map((hit) => hit.path)).toContain('people/anna.md');
        expect(fromB[0].origin).toBe('shared');
    });

    it('gives a brand-new space the shared wiki immediately, with no setup', async () => {
        const { brain, query, store } = await loadBrain();

        brain.updateWikiPage({
            ...store.sharedScope(chatA),
            path: 'projects/renovation.md',
            body: '# Renovation\n\nThe contractor starts in March.',
        });

        // A space nobody has ever written to still reads the household's knowledge.
        const block = query.buildWikiContextBlock({ spaceId: 'telegram:brand-new', query: 'renovation contractor' });
        expect(block).toContain('projects/renovation.md');
    });

    it("keeps one chat's own pages out of another chat", async () => {
        const { brain, query } = await loadBrain();

        // Filed automatically inside chat A, so it stays there.
        brain.updateWikiPage({ ...chatA, path: 'health/private.md', body: '# Private\n\nA sensitive detail.' });

        expect(query.searchWiki({ ...chatA, query: 'sensitive detail' }).map((hit) => hit.path)).toContain(
            'health/private.md'
        );
        expect(query.searchWiki({ ...chatB, query: 'sensitive detail' })).toHaveLength(0);
    });

    it("still reads a chat's older pages in that chat, without migrating them", async () => {
        const { brain, wiki } = await loadBrain();

        brain.updateWikiPage({ ...chatA, path: 'notes/old.md', body: '# Old\n\nFiled before the wiki was shared.' });

        const inA = wiki.readWikiPageForReader({ ...chatA, path: 'notes/old.md' });
        expect(inA.exists).toBe(true);
        expect(inA.origin).toBe('space');
        expect(inA.content).toContain('before the wiki was shared');

        const inB = wiki.readWikiPageForReader({ ...chatB, path: 'notes/old.md' });
        expect(inB.exists).toBe(false);
    });

    it('prefers the shared page when both wikis hold the same path', async () => {
        const { brain, wiki, store } = await loadBrain();

        brain.updateWikiPage({ ...chatA, path: 'people/anna.md', body: '# Anna\n\nThe old per-chat version.' });
        brain.updateWikiPage({
            ...store.sharedScope(chatA),
            path: 'people/anna.md',
            body: '# Anna\n\nThe shared version.',
        });

        const page = wiki.readWikiPageForReader({ ...chatA, path: 'people/anna.md' });
        expect(page.origin).toBe('shared');
        expect(page.content).toContain('The shared version.');
    });

    it('compiles a shared source once, not once per space', async () => {
        const { brain, ingest, store, generateBrainText } = await loadBrain([
            JSON.stringify({ disposition: 'new', targets: [], rationale: 'because' }),
            JSON.stringify({
                subject: 'Sleep',
                pages: [{ path: 'health/sleep.md', title: 'Sleep', body: '# Sleep\n\nCompiled once.' }],
            }),
        ]);

        const shared = store.sharedScope(chatA);
        ingest.captureRawSource({ ...shared, title: 'S', content: 'Body.', topic: 'health' });

        await ingest.runIngestQueue({ shared: true });
        // A second pass over the spaces must find nothing left to do.
        await ingest.runIngestQueue({ ...chatA });
        await ingest.runIngestQueue({ ...chatB });

        expect(generateBrainText).toHaveBeenCalledTimes(2);
        expect(brain.readWikiPage('health/sleep.md', shared).content).toContain('Compiled once.');
        expect(brain.listWikiPages(chatA)).toHaveLength(0);
    });

    it('files a batch of converted documents into the shared wiki under one decision', async () => {
        const { ingest, store } = await loadBrain();

        const result = ingest.captureSharedDocuments({
            ...chatA,
            documents: [
                { title: 'Lease', content: 'The lease text.', topic: 'home' },
                { title: 'Warranty', content: 'The warranty text.', topic: 'home' },
                { title: 'Lease again', content: 'The lease text.', topic: 'home' },
            ],
        });

        expect(result.captured).toHaveLength(2);
        expect(result.duplicates).toBe(1);
        expect(result.failed).toHaveLength(0);

        const shared = store.sharedScope(chatA);
        expect(ingest.listRawSources({ ...shared, state: 'queued' })).toHaveLength(2);
        // Nothing was filed into the chat it was handed over in.
        expect(ingest.listRawSources({ ...chatA })).toHaveLength(0);
    });

    it('reports a document it cannot file instead of dropping it', async () => {
        const { ingest } = await loadBrain();

        const result = ingest.captureSharedDocuments({
            ...chatA,
            documents: [
                { title: 'Good', content: 'Real text.' },
                { title: 'Empty', content: '   ' },
            ],
        });

        expect(result.captured).toHaveLength(1);
        expect(result.failed).toEqual([{ title: 'Empty', reason: 'A captured source cannot be empty.' }]);
    });

    it('routes a scope by its shared flag, not by whether it names a chat', async () => {
        const { store } = await loadBrain();

        const shared = store.sharedScope(chatA);
        expect(store.getBrainScopeRoot(shared)).toBe(store.getBrainScopeRoot({}));
        expect(store.getBrainScopeRoot(chatA)).not.toBe(store.getBrainScopeRoot(shared));
        // The chat is still carried, so a shared write stays attributable.
        expect(shared.spaceId).toBe(chatA.spaceId);
    });
});
