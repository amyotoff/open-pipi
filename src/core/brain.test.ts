import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadBrain() {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir };
    return await import('./brain');
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const brain = await import('./brain');
        brain.closeBrainDatabases();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
});

describe('core/brain', () => {
    it('appends scoped notebook notes and searches the index', async () => {
        const brain = await loadBrain();

        const note = brain.appendNote({
            spaceId: 'telegram:chat-1',
            topic: 'pipi-os',
            text: 'Notebook should capture what the agent noticed before wiki curation.',
            tags: ['memory', 'notebook'],
        });

        expect(note.id).toContain('note_');
        expect(note.file_path).toContain('notebook/daily/');
        expect(fs.existsSync(path.join(brain.getBrainScopeRoot({ spaceId: 'telegram:chat-1' }), note.file_path))).toBe(
            true
        );

        const hits = brain.searchNotes({ spaceId: 'telegram:chat-1', query: 'curation' });
        expect(hits).toHaveLength(1);
        expect(hits[0].id).toBe(note.id);
        expect(brain.searchNotes({ spaceId: 'telegram:chat-2', query: 'curation' })).toHaveLength(0);

        const compiled = brain.compileNotebook({ spaceId: 'telegram:chat-1', topic: 'pipi-os' });
        expect(compiled).toContain('# Notebook Compilation / pipi-os');
        expect(compiled).toContain(note.id);
    });

    it('promotes a note into a wiki page with provenance idempotently', async () => {
        const brain = await loadBrain();
        const scope = { spaceId: 'telegram:chat-1' };
        const note = brain.appendNote({
            ...scope,
            topic: 'dispatch',
            text: 'Use notebook as append-only working memory and wiki as curated canonical memory.',
            tags: ['decision'],
        });

        const page = brain.promoteNoteToWiki({ ...scope, note_id: note.id, target_page: 'projects/pipi-os.md' });
        brain.promoteNoteToWiki({ ...scope, note_id: note.id, target_page: 'projects/pipi-os.md' });

        expect(page.path).toBe('projects/pipi-os.md');
        expect(page.content).toContain('## Promoted Notebook Notes');
        expect(page.content).toContain(`Source note: ${note.id}`);

        const promoted = brain.searchNotes({ ...scope, query: note.id })[0];
        expect(promoted.status).toBe('promoted');
        expect(promoted.promoted_to).toBe('projects/pipi-os.md');

        const read = brain.readWikiPage('projects/pipi-os', scope);
        expect(read.exists).toBe(true);
        expect(read.content.match(new RegExp(`Source note: ${note.id}`, 'g'))).toHaveLength(1);
    });

    it('updates wiki pages without mutating on read', async () => {
        const brain = await loadBrain();
        const scope = { spaceId: 'telegram:chat-1' };

        const page = brain.updateWikiPage({
            ...scope,
            path: 'principles/memory.md',
            body: '# Memory Principle\n\nMemory is a maintained knowledge layer.',
        });
        const statBefore = fs.statSync(path.join(brain.getBrainScopeRoot(scope), page.file_path)).mtimeMs;

        expect(page.path).toBe('principles/memory.md');
        expect(page.content).toContain('"frontmatter_format": "json"');
        expect(page.content).toContain('# Memory Principle');

        const read = brain.readWikiPage('wiki/principles/memory.md', scope);
        const statAfter = fs.statSync(path.join(brain.getBrainScopeRoot(scope), page.file_path)).mtimeMs;
        expect(read.content).toContain('Memory is a maintained knowledge layer.');
        expect(statAfter).toBe(statBefore);
    });

    it('rebuilds index explicitly from markdown files', async () => {
        const brain = await loadBrain();
        const scope = { spaceId: 'telegram:chat-1' };
        const note = brain.appendNote({
            ...scope,
            topic: 'dispatch',
            text: 'Rebuild should recover notebook notes from markdown.',
        });

        const indexPath = path.join(brain.getBrainScopeRoot(scope), 'indexes', 'sqlite.db');
        brain.closeBrainDatabases();
        fs.rmSync(indexPath, { force: true });

        expect(brain.searchNotes({ ...scope, query: note.id })).toHaveLength(0);
        const rebuilt = brain.rebuildBrainIndex(scope);
        expect(rebuilt.notes).toBe(1);
        expect(brain.searchNotes({ ...scope, query: note.id })).toHaveLength(1);
    });

    it('compiles by exact topic only', async () => {
        const brain = await loadBrain();
        const scope = { spaceId: 'telegram:chat-1' };
        const dispatch = brain.appendNote({ ...scope, topic: 'dispatch', text: 'Canonical dispatch note.' });
        const other = brain.appendNote({
            ...scope,
            topic: 'other',
            text: 'This body mentions dispatch but belongs elsewhere.',
        });

        const compiled = brain.compileNotebook({ ...scope, topic: 'dispatch' });
        expect(compiled).toContain(dispatch.id);
        expect(compiled).not.toContain(other.id);
    });

    it('guards paths and parser delimiters', async () => {
        const brain = await loadBrain();
        const scope = { spaceId: 'telegram:chat-1' };
        const note = brain.appendNote({
            ...scope,
            topic: 'parser',
            text: 'This literal marker should be harmless: <!-- /brain-note -->',
        });

        brain.rebuildBrainIndex(scope);
        expect(brain.searchNotes({ ...scope, query: note.id })[0].text).toContain('literal marker');
        expect(() => brain.readWikiPage('../etc/passwd', scope)).toThrow(/Unsafe wiki path/);
        expect(() => brain.updateWikiPage({ ...scope, path: 'wiki/../../foo', body: '# Bad' })).toThrow(
            /Unsafe wiki path/
        );
        expect(() => brain.updateWikiPage({ ...scope, path: '/absolute', body: '# Bad' })).toThrow(/Unsafe wiki path/);
    });
});
