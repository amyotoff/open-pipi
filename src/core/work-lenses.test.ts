import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('core/work-lenses', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = {
            ...ORIGINAL_ENV,
            DATA_DIR: `/tmp/open-pipi-work-lenses-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
    });

    afterEach(async () => {
        try {
            const db = await import('../db');
            db.closeDatabase();
        } catch {}
        process.env = { ...ORIGINAL_ENV };
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('runs the review lens and saves a review artifact', async () => {
        const db = await import('../db');
        db.initDatabase();
        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        const space = db.ensureTelegramSpace('chat-lens', 'private', 'Lens Chat');
        db.ensureSpaceMembership(space.id, '111', 'owner');

        vi.doMock('./context-composer', () => ({
            composeConversationContext: vi.fn(() => ({
                llmMessages: [{ role: 'system', content: 'sys' }],
                systemPrompt: 'sys',
                spaceId: space.id,
                assistantPackId: 'jeeves',
                groundingPackId: 'jeeves_personal',
            })),
        }));
        vi.doMock('./llm', () => ({
            processWithLLM: vi.fn(async () => ({
                text: [
                    '## Findings',
                    '- Missing regression coverage for the latest path.',
                    '',
                    '## Risks',
                    '- Behavior may drift quietly.',
                    '',
                    '## Open questions',
                    '- Should the fallback stay permissive?',
                    '',
                    '## Next step',
                    '- Add one narrow regression test.',
                ].join('\n'),
            })),
        }));

        const lenses = await import('./work-lenses');
        const text = await lenses.runWorkLensForSpace({
            spaceId: space.id,
            channel: 'telegram',
            channelRef: 'chat-lens',
            senderId: '111',
            lens: 'review',
            requestText: 'check the latest path',
        });

        expect(text).toContain('## Findings');
        const artifact = db.getLatestArtifactByKind(space.id, 'review');
        expect(artifact?.ref).toContain('## Findings');
        expect(artifact?.summary).toContain('Review output');
        const timeline = db.listTimelineEvents(space.id, { limit: 10 });
        expect(timeline.some((event) => event.type === 'review.generated')).toBe(true);
    });
});
