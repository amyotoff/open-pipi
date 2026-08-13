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
            'Sleep debt builds across the week.',
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
        expect(answered).toContain('Sleep debt builds across the week.');
        expect(answered).toContain('Cited: health/sleep.md');

        const archived = await skill.handlers.wiki_archive(
            { title: 'Sleep summary', body: 'The summary.', topic: 'health', citations: ['health/sleep.md'] },
            context
        );
        expect(archived).toContain('health/sleep-summary.md');

        const linted = await skill.handlers.wiki_lint({}, context);
        expect(linted).toContain('Wiki lint:');
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

    it('serves the schema layer and lets a space replace it', async () => {
        const skill = await loadSkill();
        const context = {
            channel: 'telegram',
            channelRef: 'chat-1',
            chatId: 'chat-1',
            userId: '111',
            spaceId: 'telegram:chat-1',
        };

        const shipped = await skill.handlers.wiki_schema({}, context);
        expect(shipped).toContain('Compile, never append');

        const withTemplate = await skill.handlers.wiki_schema({ template: 'article' }, context);
        expect(withTemplate).toContain('--- article template ---');
        expect(withTemplate).toContain('"kind": "article"');

        const missing = await skill.handlers.wiki_schema({ template: 'nope' }, context);
        expect(missing).toContain('no template named');
    });

    it('gates the schema rewrite behind an explicit approval', async () => {
        const skill = await loadSkill();

        // Changing the maintenance rules is not something to do silently on a model's say-so.
        expect(skill.toolMeta?.wiki_schema_set?.approval).toBe('explicit');
        expect(skill.toolMeta?.wiki_schema_set?.approval_detail_fields).toContain('content');
    });

    it('refuses a schema rewrite from someone who is not the space owner', async () => {
        const skill = await loadSkill();
        const context = {
            channel: 'telegram',
            channelRef: 'chat-1',
            chatId: 'chat-1',
            userId: 'not-the-owner',
            spaceId: 'telegram:chat-1',
        };

        const denied = await skill.handlers.wiki_schema_set({ content: '# Only compile recipes' }, context);
        expect(denied).toContain('Only the owner of this space');

        // The shipped schema is still in force.
        const schema = await skill.handlers.wiki_schema({}, context);
        expect(schema).toContain('Compile, never append');
    });
});
