import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadBrain() {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-ingest-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, GEMINI_API_KEY: '' };
    return {
        brain: await import('./brain'),
        ingest: await import('./brain-ingest'),
        store: await import('./brain-store'),
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
    vi.resetModules();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
});

const scope = { spaceId: 'telegram:chat-1' };

/** Every derived row that carries meaning. Surrogate autoincrement ids are excluded. */
function snapshotIndex(db: Database.Database): string {
    return JSON.stringify({
        notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
        note_events: db
            .prepare(
                'SELECT note_id, event_type, target_page, created_at FROM note_events ORDER BY note_id, created_at'
            )
            .all(),
        wiki_pages: db.prepare('SELECT * FROM wiki_pages ORDER BY path').all(),
        wiki_links: db.prepare('SELECT * FROM wiki_links ORDER BY from_path, to_path, kind').all(),
        wiki_fts: db.prepare('SELECT path, title, excerpt, body FROM wiki_fts ORDER BY path').all(),
        raw_sources: db.prepare('SELECT * FROM raw_sources ORDER BY path').all(),
    });
}

describe('core/brain-ingest', () => {
    it('captures a source into raw/ and queues it', async () => {
        const { ingest, store } = await loadBrain();

        const result = ingest.captureRawSource({
            ...scope,
            title: 'Sleep debt and afternoon focus',
            content: 'Sleep debt accumulates across the week and shows up as an afternoon dip.',
            topic: 'health',
            url: 'https://example.com/sleep',
            published_at: '2026-08-01',
            now: new Date('2026-08-13T10:00:00.000Z'),
        });

        expect(result.duplicate).toBe(false);
        expect(result.source.state).toBe('queued');
        expect(result.source.topic).toBe('health');
        expect(result.source.path).toMatch(/^raw\/health\/2026-08-01-sleep-debt-and-afternoon-focus-[0-9a-f]{8}\.md$/);

        const fileText = fs.readFileSync(path.join(store.getBrainScopeRoot(scope), result.file_path), 'utf-8');
        expect(fileText).toContain('# Sleep debt and afternoon focus');
        expect(fileText).toContain('> Source: https://example.com/sleep');
        expect(fileText).toContain('> Collected: 2026-08-13');
        expect(fileText).toContain('> Published: 2026-08-01');
        expect(fileText).toContain('Sleep debt accumulates');
    });

    it('is idempotent for identical content and never writes a second file', async () => {
        const { ingest, store } = await loadBrain();
        const input = {
            ...scope,
            title: 'Sleep debt',
            content: 'Same body, captured twice.',
            topic: 'health',
        };

        const first = ingest.captureRawSource(input);
        const second = ingest.captureRawSource({ ...input, title: 'Sleep debt (again)' });

        expect(second.duplicate).toBe(true);
        expect(second.source.path).toBe(first.source.path);

        const files = fs.readdirSync(path.join(store.getBrainScopeRoot(scope), 'raw', 'health'));
        expect(files).toHaveLength(1);
    });

    it('reuses an existing topic directory regardless of case', async () => {
        const { ingest } = await loadBrain();

        ingest.captureRawSource({ ...scope, title: 'First', content: 'One.', topic: 'health' });
        const second = ingest.captureRawSource({ ...scope, title: 'Second', content: 'Two.', topic: 'Health' });

        expect(second.source.topic).toBe('health');
    });

    it('recovers compile state from the log, because the file cannot carry it', async () => {
        const { brain, ingest } = await loadBrain();

        const thin = ingest.captureRawSource({ ...scope, title: 'Thin recap', content: 'Nothing new.', topic: 'news' });
        const useful = ingest.captureRawSource({
            ...scope,
            title: 'Real find',
            content: 'A new claim.',
            topic: 'news',
        });

        brain.appendWikiLog({
            ...scope,
            action: 'ingest',
            subject: `no material: ${thin.source.path}`,
            details: { Disposition: 'No material' },
        });
        brain.appendWikiLog({
            ...scope,
            action: 'ingest',
            subject: 'Real find',
            details: { Disposition: 'New', Raw: useful.source.path },
        });

        ingest.reindexRawTree(scope);

        expect(ingest.getRawSource(thin.source.path, scope)?.state).toBe('no_material');
        expect(ingest.getRawSource(useful.source.path, scope)?.state).toBe('compiled');
        expect(ingest.listRawSources({ ...scope, state: 'queued' })).toHaveLength(0);
    });

    it('rebuilds an identical index from markdown after the database is deleted', async () => {
        const { brain, ingest, store } = await loadBrain();

        const note = brain.appendNote({ ...scope, topic: 'dispatch', text: 'Notebook note that gets promoted.' });
        await brain.promoteNoteToWiki({ ...scope, note_id: note.id, target_page: 'projects/pipi-os.md' });
        brain.updateWikiPage({
            ...scope,
            path: 'people/anna.md',
            body: '# Anna\n\nSee [Pipi OS](../projects/pipi-os.md).\n\n## See Also\n\n- [Nobody](nobody.md)',
        });
        ingest.captureRawSource({
            ...scope,
            title: 'Captured source',
            content: 'Body of the captured source.',
            topic: 'health',
            url: 'https://example.com/a',
            now: new Date('2026-08-13T10:00:00.000Z'),
        });
        brain.appendWikiLog({ ...scope, action: 'lint', subject: '0 issues found, 0 auto-fixed' });

        const before = snapshotIndex(store.getBrainDb(scope));
        expect(before).toContain('projects/pipi-os.md');

        const indexPath = path.join(store.getBrainScopeRoot(scope), 'indexes', 'sqlite.db');
        store.closeBrainDatabases();
        fs.rmSync(indexPath, { force: true });

        const counts = brain.rebuildBrainIndex(scope);
        expect(counts).toEqual({ notes: 1, events: 1, wiki_pages: 2, raw_sources: 1 });
        expect(snapshotIndex(store.getBrainDb(scope))).toBe(before);
    });

    it('keeps scopes separate', async () => {
        const { ingest } = await loadBrain();

        ingest.captureRawSource({ spaceId: 'telegram:chat-1', title: 'A', content: 'Body A.', topic: 'health' });

        expect(ingest.listRawSources({ spaceId: 'telegram:chat-1' })).toHaveLength(1);
        expect(ingest.listRawSources({ spaceId: 'telegram:chat-2' })).toHaveLength(0);
    });

    it('rebuilds the index automatically when a schema change empties it', async () => {
        const { brain, ingest, store } = await loadBrain();

        const note = brain.appendNote({ ...scope, topic: 'dispatch', text: 'A note that must survive an upgrade.' });
        brain.updateWikiPage({ ...scope, path: 'health/sleep.md', body: '# Sleep\n\nA page.' });
        ingest.captureRawSource({ ...scope, title: 'S', content: 'Body.', topic: 'health' });

        // Simulate an install written by an older schema version.
        store.getBrainDb(scope).pragma('user_version = 1');
        store.closeBrainDatabases();

        // Markdown is the source of truth, so the next open must restore everything.
        expect(brain.searchNotes({ ...scope, query: note.id })).toHaveLength(1);
        expect(brain.listWikiPages(scope).map((page) => page.path)).toContain('health/sleep.md');
        expect(ingest.listRawSources({ ...scope })).toHaveLength(1);
    });

    it('keeps header fields on one line so a crafted title cannot forge metadata', async () => {
        const { ingest } = await loadBrain();

        const captured = ingest.captureRawSource({
            ...scope,
            title: 'Real title\n> Collected: 1999-01-01',
            content: 'Body text.',
            topic: 'health',
            now: new Date('2026-08-13T10:00:00.000Z'),
        });
        const before = ingest.getRawSource(captured.source.path, scope);

        ingest.reindexRawTree(scope);
        const after = ingest.getRawSource(captured.source.path, scope);

        expect(before?.title).toBe('Real title > Collected: 1999-01-01');
        expect(after?.collected_at).toBe('2026-08-13');
        expect(after?.title).toBe(before?.title);
        // The D1 round-trip has to survive hostile input, not just tidy input.
        expect(after?.content_hash).toBe(before?.content_hash);
    });

    it('retries the rebuild on the next open when it fails, instead of stamping the version', async () => {
        const { brain, store } = await loadBrain();

        brain.appendNote({ ...scope, topic: 'dispatch', text: 'A note that must survive a failed upgrade.' });
        store.getBrainDb(scope).pragma('user_version = 1');
        store.closeBrainDatabases();

        // A rebuild that throws must not leave a current version over an empty index.
        const failing = vi.fn(() => {
            throw new Error('disk went away');
        });
        store.registerIndexRebuilder(failing);
        expect(() => store.getBrainDb(scope)).toThrow(/disk went away/);
        expect(failing).toHaveBeenCalled();

        // Restore the real rebuilder: the stale version means the next open tries again.
        store.registerIndexRebuilder((rebuildScope) => {
            brain.rebuildBrainIndex(rebuildScope);
        });
        expect(brain.searchNotes({ ...scope, query: 'failed upgrade' })).toHaveLength(1);
        expect(store.getBrainDb(scope).pragma('user_version', { simple: true })).toBe(2);
    });
});
