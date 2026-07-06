import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, makeDbModuleMock, seedResident } from '../test-helpers/mock-db';

let db: Database.Database;

async function loadSkill() {
    vi.resetModules();
    vi.doMock('../db', () => makeDbModuleMock(db));
    return (await import('./artifacts.skill')).default;
}

function seedSpace(db: Database.Database, spaceId: string, externalRef: string, title: string = 'Test Space'): void {
    db.prepare(
        `
        INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, policy_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
        spaceId,
        'group_chat',
        title,
        'telegram',
        externalRef,
        'ACTIVE',
        'office',
        '{}',
        new Date().toISOString(),
        new Date().toISOString()
    );
}

beforeEach(() => {
    db = createTestDb();
    seedResident(db, { tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
    seedResident(db, { tg_id: '222', username: 'bob', display_name: 'Bob', role: 'member' });
    seedSpace(db, 'telegram:chat-1', 'chat-1', 'Project Alpha');
    seedSpace(db, 'telegram:chat-2', 'chat-2', 'Project Beta');
});

afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.resetModules();
});

const CTX_SPACE_1 = { chatId: 'chat-1', userId: '111' };
const CTX_SPACE_2 = { chatId: 'chat-2', userId: '222' };

describe('cross-space artifact management', () => {
    it('copies an artifact from one space to another', async () => {
        const skill = await loadSkill();

        // Create artifact in space-1
        const createRes = await skill.handlers.artifacts_create(
            {
                kind: 'plan',
                title: 'Sprint Plan Q3',
                ref: '# Sprint Plan\n- Task A\n- Task B',
                summary: 'Q3 sprint plan',
            },
            CTX_SPACE_1
        );
        expect(createRes).toContain('created successfully');
        const idMatch = createRes.match(/ID: (art_[^\s.]+)/);
        expect(idMatch).toBeTruthy();
        const originalId = idMatch![1];

        // Copy to space-2
        const copyRes = await skill.handlers.artifacts_copy_to_space(
            { id: originalId, target_space_id: 'telegram:chat-2' },
            CTX_SPACE_1
        );
        expect(copyRes).toContain('copied successfully');
        expect(copyRes).toContain('telegram:chat-2');
        const copyIdMatch = copyRes.match(/New copy ID: (art_[^\s]+)/);
        expect(copyIdMatch).toBeTruthy();

        // Verify copy exists in space-2
        const listRes = await skill.handlers.artifacts_list({}, CTX_SPACE_2);
        expect(listRes).toContain('Sprint Plan Q3');
        expect(listRes).toContain('copied from telegram:chat-1');
    });

    it('preserves content when copying', async () => {
        const skill = await loadSkill();

        const content =
            '# Detailed Report\n\n## Section 1\nLorem ipsum dolor sit amet.\n\n## Section 2\nConsectetur adipiscing elit.';
        await skill.handlers.artifacts_create(
            { kind: 'review', title: 'Monthly Report', ref: content, summary: 'June report' },
            CTX_SPACE_1
        );
        const list1 = await skill.handlers.artifacts_list({}, CTX_SPACE_1);
        const idMatch = list1.match(/\[(art_[^\]]+)\]/);
        expect(idMatch).toBeTruthy();
        const id = idMatch![1];

        await skill.handlers.artifacts_copy_to_space({ id, target_space_id: 'telegram:chat-2' }, CTX_SPACE_1);

        // Verify content is preserved in the copy
        const row = db
            .prepare(`SELECT ref, kind, title FROM artifacts WHERE space_id = 'telegram:chat-2' LIMIT 1`)
            .get() as any;
        expect(row.ref).toBe(content);
        expect(row.kind).toBe('review');
        expect(row.title).toBe('Monthly Report');
    });

    it('rejects copy when artifact does not belong to current space', async () => {
        const skill = await loadSkill();

        await skill.handlers.artifacts_create(
            { kind: 'plan', title: 'Private Plan', ref: 'secret', summary: 'test' },
            CTX_SPACE_1
        );
        const list = await skill.handlers.artifacts_list({}, CTX_SPACE_1);
        const id = list.match(/\[(art_[^\]]+)\]/)![1];

        // Try to copy from space-2 context (artifact belongs to space-1)
        const res = await skill.handlers.artifacts_copy_to_space(
            { id, target_space_id: 'telegram:chat-2' },
            CTX_SPACE_2
        );
        expect(res).toContain('not found in current space');
    });

    it('rejects copy when target space does not exist', async () => {
        const skill = await loadSkill();

        await skill.handlers.artifacts_create(
            { kind: 'plan', title: 'Test Plan', ref: 'body', summary: 'test' },
            CTX_SPACE_1
        );
        const list = await skill.handlers.artifacts_list({}, CTX_SPACE_1);
        const id = list.match(/\[(art_[^\]]+)\]/)![1];

        const res = await skill.handlers.artifacts_copy_to_space(
            { id, target_space_id: 'telegram:nonexistent' },
            CTX_SPACE_1
        );
        expect(res).toContain('not found');
    });

    it('lists artifacts from another space', async () => {
        const skill = await loadSkill();

        // Create artifacts in space-2
        await skill.handlers.artifacts_create(
            { kind: 'walkthrough', title: 'Onboarding Guide', ref: '# Onboarding\nStep 1', summary: 'New hire guide' },
            CTX_SPACE_2
        );
        await skill.handlers.artifacts_create(
            { kind: 'code', title: 'API Schema', ref: 'type User { id: string }', summary: 'API types' },
            CTX_SPACE_2
        );

        // List from space-1 context
        const res = await skill.handlers.artifacts_list_other_space(
            { target_space_id: 'telegram:chat-2' },
            CTX_SPACE_1
        );
        expect(res).toContain('Onboarding Guide');
        expect(res).toContain('API Schema');
        expect(res).toContain('telegram:chat-2');
    });

    it('returns empty message when target space has no artifacts', async () => {
        const skill = await loadSkill();

        const res = await skill.handlers.artifacts_list_other_space(
            { target_space_id: 'telegram:chat-2' },
            CTX_SPACE_1
        );
        expect(res).toContain('No active artifacts');
    });

    it('rejects listing when target space does not exist', async () => {
        const skill = await loadSkill();

        const res = await skill.handlers.artifacts_list_other_space(
            { target_space_id: 'telegram:nonexistent' },
            CTX_SPACE_1
        );
        expect(res).toContain('not found');
    });
});
