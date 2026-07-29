import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadReviewModule() {
    vi.resetModules();
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: `/tmp/open-pipi-atelier-self-review-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    const processWithLLM = vi.fn();
    vi.doMock('./llm', () => ({ processWithLLM }));

    const db = await import('../db');
    db.initDatabase();
    const review = await import('./atelier-self-review');
    return { db, review, processWithLLM };
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
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

describe('core/atelier-self-review', () => {
    it('becomes due exactly 48 hours after the last completed review', async () => {
        const { review } = await loadReviewModule();
        const last = '2026-07-27T12:00:00.000Z';

        expect(review.isAtelierSelfReviewDue(undefined, Date.parse(last))).toBe(true);
        expect(review.isAtelierSelfReviewDue(last, Date.parse('2026-07-29T11:59:59.999Z'))).toBe(false);
        expect(review.isAtelierSelfReviewDue(last, Date.parse('2026-07-29T12:00:00.000Z'))).toBe(true);
    });

    it('requires material evidence, deduplication, a one-request cap, and silent completion', async () => {
        const { review } = await loadReviewModule();
        const prompt = review.buildAtelierSelfReviewPrompt({
            nowIso: '2026-07-29T12:00:00.000Z',
            space: {
                id: 'telegram:chat-1',
                kind: 'direct_chat',
                slug: null,
                title: 'Work',
                channel: 'telegram',
                external_ref: 'chat-1',
                status: 'ACTIVE',
                assistant_pack_id: 'office',
                grounding_pack_id: 'jeeves_personal',
                policy_json: null,
                created_at: '2026-07-01T00:00:00.000Z',
                updated_at: '2026-07-29T10:00:00.000Z',
                human_message_count: 4,
                last_human_message_at: '2026-07-29T10:00:00.000Z',
            },
            activeSpaceCount: 2,
            dialogue: [],
            toolEvidence: '- workspace_read_text: 3 run(s), status=error',
            openRequests: [],
        });

        expect(prompt).toContain('supported by repeated or material evidence');
        expect(prompt).toContain('not already represented by an open Atelier request');
        expect(prompt).toContain('At most ONE atelier_request_capability call');
        expect(prompt).toContain('This review is silent');
        expect(prompt).toContain('NO_REQUEST:');
        expect(prompt).toContain('REQUESTED:');
    });

    it('records a created request and does not run again before the next 48-hour boundary', async () => {
        const { db, review, processWithLLM } = await loadReviewModule();
        const now = new Date();

        db.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'direct_chat',
            title: 'Work',
            channel: 'telegram',
            external_ref: 'chat-1',
            status: 'ACTIVE',
            assistant_pack_id: 'office',
            grounding_pack_id: 'jeeves_personal',
        });
        db.storeMessage({
            id: 'human-1',
            space_id: 'telegram:chat-1',
            chat_jid: 'chat-1',
            sender_tg_id: 'owner-1',
            content: 'We keep losing time because this integration is missing.',
            timestamp: now.toISOString(),
            is_bot: 0,
        });

        processWithLLM.mockImplementationOnce(async (_messages: unknown, context: any) => {
            expect(context.allowedTools).toEqual([
                'atelier_list_requests',
                'atelier_request_capability',
                'consult_advisor',
            ]);
            expect(context.userId).toBe('system_self_review');
            expect(context.taskId).toContain('system:atelier-self-review:');

            db.createCapabilityGapRequest({
                space_id: context.spaceId,
                assistant_pack_id: 'office',
                capability_gap: 'reliable_calendar_sync',
                description: 'Repeated scheduling handoffs need a reliable calendar sync.',
                requested_by: context.userId,
                user_request: 'Internal 48-hour evidence review.',
            });
            return { text: 'REQUESTED: reliable_calendar_sync reduces repeated scheduling handoff work' };
        });

        const first = await review.runAtelierSelfReviewIfDue({ now });
        const second = await review.runAtelierSelfReviewIfDue({
            now: new Date(now.getTime() + 60 * 60 * 1000),
        });

        expect(first).toMatchObject({
            status: 'request_created',
            spaceId: 'telegram:chat-1',
            assistantPackId: 'office',
        });
        expect(first.requestIds).toHaveLength(1);
        expect(second.status).toBe('not_due');
        expect(processWithLLM).toHaveBeenCalledTimes(1);

        const event = db
            .getDb()
            .prepare(
                "SELECT details FROM event_log WHERE event_type = 'atelier_self_review_completed' ORDER BY id DESC LIMIT 1"
            )
            .get() as { details: string };
        expect(JSON.parse(event.details)).toMatchObject({
            status: 'request_created',
            space_id: 'telegram:chat-1',
            assistant_pack_id: 'office',
        });
    });
});
