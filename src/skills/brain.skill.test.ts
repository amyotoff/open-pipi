import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir = '';

async function loadSkill() {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-brain-skill-'));
    process.env = { ...ORIGINAL_ENV, DATA_DIR: dataDir };
    return (await import('./brain.skill')).default;
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
});
