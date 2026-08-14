import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadSkill() {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-skill-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, GEMINI_API_KEY: '' };
    return (await import('./brain.skill')).default;
}

/** Same skill, with the model stubbed, for the tools that synthesise text. */
async function loadSkillWithModel(responses: string[]) {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-skill-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir, GEMINI_API_KEY: 'test-key' };

    const generateBrainText = vi.fn();
    for (const response of responses) generateBrainText.mockResolvedValueOnce(response);

    vi.doMock('../core/brain-model', async () => {
        const actual = await vi.importActual<typeof import('../core/brain-model')>('../core/brain-model');
        return { ...actual, generateBrainText };
    });

    return { skill: (await import('./brain.skill')).default, generateBrainText };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
    try {
        const brain = await import('../core/brain');
        brain.closeBrainDatabases();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.doUnmock('../core/brain-model');
    vi.resetModules();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
});

describe('brain skill', () => {
    it('supports scoped append, search, promotion, wiki read, update, and notebook compilation', async () => {
        const skill = await loadSkill();
        const context = {
            channel: 'telegram',
            channelRef: 'chat-1',
            chatId: 'chat-1',
            userId: '111',
            spaceId: 'telegram:chat-1',
        };

        const appended = await skill.handlers.append_note(
            {
                topic: 'pipi-os',
                text: 'Notebook precedes wiki in the memory architecture.',
                tags: ['memory'],
            },
            context
        );
        const noteId = appended.match(/note_\S+/)?.[0];
        expect(noteId).toBeTruthy();

        const search = await skill.handlers.search_notes({ query: 'architecture' }, context);
        expect(search).toContain(noteId);

        const promoted = await skill.handlers.promote_note_to_wiki(
            {
                note_id: noteId!,
                target_page: 'projects/pipi-os.md',
            },
            context
        );
        expect(promoted).toContain('projects/pipi-os.md');

        const page = await skill.handlers.read_wiki_page({ path: 'projects/pipi-os.md' }, context);
        expect(page).toContain(`Source note: ${noteId}`);

        const updated = await skill.handlers.update_wiki_page(
            {
                path: 'projects/pipi-os.md',
                body: '# Pipi OS\n\n## Decision\nNotebook feeds curated wiki pages.',
            },
            context
        );
        expect(updated).toContain('Wiki page updated');

        const compiled = await skill.handlers.compile_notebook({ topic: 'pipi-os' }, context);
        expect(compiled).toContain('Notebook Compilation');
        expect(compiled).toContain('promoted');
    });

    it('captures sources into the queue and reports duplicates instead of refiling them', async () => {
        const skill = await loadSkill();
        const context = {
            channel: 'telegram',
            channelRef: 'chat-1',
            chatId: 'chat-1',
            userId: '111',
            spaceId: 'telegram:chat-1',
        };

        const captured = await skill.handlers.brain_capture(
            {
                title: 'Sleep debt and afternoon focus',
                content: 'Sleep debt accumulates across the week.',
                topic: 'health',
                url: 'https://example.com/sleep',
            },
            context
        );
        expect(captured).toContain('Source captured');
        expect(captured).toContain('raw/health/');
        expect(captured).toContain('State: queued');

        const again = await skill.handlers.brain_capture(
            {
                title: 'Sleep debt and afternoon focus',
                content: 'Sleep debt accumulates across the week.',
                topic: 'health',
            },
            context
        );
        expect(again).toContain('already in raw/');
        expect(again).toContain('Nothing was written');

        const queue = await skill.handlers.list_raw_sources({ state: 'queued' }, context);
        expect(queue).toContain('raw/health/');
        expect(queue).toContain('(queued)');

        const otherSpace = await skill.handlers.list_raw_sources({}, { ...context, spaceId: 'telegram:chat-2' });
        expect(otherSpace).toContain('No captured sources');
    });

    it('searches, answers, archives, and lints through the tool surface', async () => {
        const { skill } = await loadSkillWithModel([
            'Sleep debt builds across the week — see [Sleep](health/sleep.md).',
            JSON.stringify({ contradictions: [] }),
        ]);
        const context = {
            channel: 'telegram',
            channelRef: 'chat-1',
            chatId: 'chat-1',
            userId: '111',
            spaceId: 'telegram:chat-1',
        };

        await skill.handlers.update_wiki_page(
            { path: 'health/sleep.md', body: '# Sleep\n\nSleep debt accumulates across the week.' },
            context
        );

        const empty = await skill.handlers.wiki_search({ query: 'quantum tunnelling' }, context);
        expect(empty).toContain('Searched the wiki index and full text');

        const found = await skill.handlers.wiki_search({ query: 'sleep debt' }, context);
        expect(found).toContain('health/sleep.md');

        const answered = await skill.handlers.wiki_answer({ question: 'what about sleep debt?' }, context);
        expect(answered).toContain('Sleep debt builds across the week');
        expect(answered).toContain('Cited: health/sleep.md');

        const archived = await skill.handlers.wiki_archive(
            { title: 'Sleep summary', body: 'The summary.', topic: 'health', citations: ['health/sleep.md'] },
            context
        );
        expect(archived).toContain('health/sleep-summary.md');

        const linted = await skill.handlers.wiki_lint({}, context);
        expect(linted).toContain('Shared wiki —');
    });

    it('declares the background jobs that make ingest and lint run without the owner', async () => {
        const skill = await loadSkill();
        const descriptions = (skill.crons || []).map((job) => job.description);

        expect(descriptions).toContain('Drain the wiki ingest queue');
        expect(descriptions).toContain('Wiki lint on the memory-sprint cadence');
        for (const job of skill.crons || []) {
            expect(job.expression).toMatch(/^[\d*/ ,-]+$/);
        }
    });

    it('shows the schema that actually governs the shared wiki', async () => {
        const skill = await loadSkill();
        const context = {
            channel: 'telegram',
            channelRef: 'chat-1',
            chatId: 'chat-1',
            userId: '111',
            spaceId: 'telegram:chat-1',
        };

        const shipped = await skill.handlers.wiki_schema({}, context);
        expect(shipped).toContain('Schema in force for the shared wiki');
        expect(shipped).toContain('Compile, never append');

        // Nothing writes a schema override yet, so no tool may claim to.
        expect(skill.tools.map((tool) => tool.name)).not.toContain('wiki_schema_set');

        const withTemplate = await skill.handlers.wiki_schema({ template: 'article' }, context);
        expect(withTemplate).toContain('--- article template ---');
        expect(withTemplate).toContain('"kind": "article"');

        const missing = await skill.handlers.wiki_schema({ template: 'nope' }, context);
        expect(missing).toContain('no template named');
    });

    it('saves to the shared wiki and files a document batch, both behind an approval', async () => {
        const skill = await loadSkill();
        const store = await import('../core/brain-store');
        const brain = await import('../core/brain');
        const contextA = {
            channel: 'telegram',
            channelRef: 'chat-a',
            chatId: 'chat-a',
            userId: '111',
            spaceId: 'telegram:chat-a',
        };
        const contextB = { ...contextA, channelRef: 'chat-b', chatId: 'chat-b', spaceId: 'telegram:chat-b' };

        const saved = await skill.handlers.wiki_save(
            { path: 'people/anna.md', title: 'Anna', body: '# Anna\n\nPrefers early appointments.' },
            contextA
        );
        expect(saved).toContain('Saved to the shared wiki');

        // Saved in chat A, found in chat B — that is the whole point.
        const found = await skill.handlers.wiki_search({ query: 'Anna appointments' }, contextB);
        expect(found).toContain('people/anna.md');
        expect(found).not.toContain('[this chat only]');

        const filed = await skill.handlers.wiki_capture_documents(
            {
                documents: [
                    { title: 'Lease', content: 'The lease text.', topic: 'home' },
                    { title: 'Lease copy', content: 'The lease text.', topic: 'home' },
                ],
            },
            contextA
        );
        expect(filed).toContain('Filed 1 document');
        expect(filed).toContain('already there');

        // Both landed in the shared wiki, not in the chat they were handed over in.
        const shared = store.sharedScope({ spaceId: contextA.spaceId });
        expect(brain.readWikiPage('people/anna.md', shared).exists).toBe(true);
        expect(brain.readWikiPage('people/anna.md', { spaceId: contextA.spaceId }).exists).toBe(false);

        // A write everyone can read is a decision the owner signs.
        for (const tool of ['wiki_save', 'wiki_capture_documents', 'wiki_archive']) {
            expect(skill.toolMeta?.[tool]?.approval).toBe('explicit');
        }
    });

    it('marks a page that only one chat can see', async () => {
        const skill = await loadSkill();
        const context = {
            channel: 'telegram',
            channelRef: 'chat-a',
            chatId: 'chat-a',
            userId: '111',
            spaceId: 'telegram:chat-a',
        };

        // update_wiki_page is the assistant's own filing, so it stays in this chat.
        await skill.handlers.update_wiki_page(
            { path: 'notes/local.md', body: '# Local\n\nA chat-only observation.' },
            context
        );

        const found = await skill.handlers.wiki_search({ query: 'chat-only observation' }, context);
        expect(found).toContain('[this chat only]');

        const elsewhere = await skill.handlers.wiki_search(
            { query: 'chat-only observation' },
            { ...context, channelRef: 'chat-b', chatId: 'chat-b', spaceId: 'telegram:chat-b' }
        );
        expect(elsewhere).toContain('found no page');
    });

    it('refuses a chat-local edit to a page the shared wiki owns', async () => {
        const skill = await loadSkill();
        const context = {
            channel: 'telegram',
            channelRef: 'chat-a',
            chatId: 'chat-a',
            userId: '111',
            spaceId: 'telegram:chat-a',
        };

        await skill.handlers.wiki_save({ path: 'people/anna.md', body: '# Anna\n\nThe shared version.' }, context);

        // Reads prefer the shared wiki, so a local write here would report a lie.
        await expect(
            skill.handlers.update_wiki_page({ path: 'people/anna.md', body: '# Anna\n\nLocal edit.' }, context)
        ).rejects.toThrow(/lives in the shared wiki/);

        const page = await skill.handlers.read_wiki_page({ path: 'people/anna.md' }, context);
        expect(page).toContain('The shared version.');
        expect(page).not.toContain('Local edit.');
    });

    it('puts the batch size and titles in front of the owner before filing', async () => {
        const skill = await loadSkill();

        expect(
            skill.preflight?.wiki_capture_documents?.({ documents: [{ title: 'Lease' }, { title: 'Warranty' }] })
        ).toMatchObject({ count: 2, titles: 'Lease, Warranty' });
        expect(skill.preflight?.wiki_save?.({ path: 'a.md', body: '# A\n\nThe body text.' }).preview).toBe(
            '# A The body text.'
        );

        // Every approval detail field must exist as an argument, or the prompt shows nothing.
        for (const [tool, meta] of Object.entries(skill.toolMeta || {})) {
            const prepared = skill.preflight?.[tool]?.({ documents: [], body: '', path: 'a.md', title: 't' }) ?? {
                title: 't',
            };
            for (const field of meta.approval_detail_fields || []) {
                expect(Object.keys(prepared)).toContain(field);
            }
        }
    });
});
