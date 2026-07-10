import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModules() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-grounding-context-${Date.now()}` };

    const db = await import('../db');
    db.initDatabase();
    const grounding = await import('./grounding-context');

    return { db, grounding };
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

describe('core/grounding-context', () => {
    it('formats installable grounding and active overrides for a space', async () => {
        const { db, grounding } = await loadModules();

        db.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'group_chat',
            title: 'Personal',
            channel: 'telegram',
            external_ref: 'chat-1',
            assistant_pack_id: 'jeeves',
            grounding_pack_id: 'jeeves_personal',
        });
        db.upsertGroundingOverride({
            space_id: 'telegram:chat-1',
            kind: 'person',
            subject: 'Alice',
            content: 'Alice moved abroad and is no longer part of this household.',
            created_by: '111',
        });

        const context = grounding.getGroundingContext('telegram:chat-1');
        const snapshot = grounding.getGroundingSnapshot('telegram:chat-1');

        expect(snapshot?.pack.id).toBe('jeeves_personal');
        expect(snapshot?.overrides).toHaveLength(1);
        expect(context).toContain('[GROUNDING]');
        expect(context).toContain('Office Coordination');
        expect(context).toContain('small-team office coordination space');
        expect(context).toContain('[GROUNDING_OVERRIDES]');
        expect(context).toContain('Alice moved abroad');
    });

    it('uses the pinned grounding snapshot when one exists for the space', async () => {
        const { db, grounding } = await loadModules();
        const behavior = await import('./space-behavior');

        db.upsertSpace({
            id: 'telegram:chat-2',
            kind: 'group_chat',
            title: 'Personal',
            channel: 'telegram',
            external_ref: 'chat-2',
            assistant_pack_id: 'jeeves',
            grounding_pack_id: 'jeeves_personal',
        });

        behavior.ensureSpaceBehaviorSnapshot('telegram:chat-2');
        const snapshotRoot = behavior.getSpaceGroundingSnapshotRoot('telegram:chat-2');
        expect(snapshotRoot).toBeTruthy();

        const groundingPath = path.join(snapshotRoot!, 'grounding.md');
        const original = fs.readFileSync(groundingPath, 'utf-8');
        fs.writeFileSync(
            groundingPath,
            original.replace(
                'This is a small-team office coordination space.',
                'This is a dramatically pinned office coordination space.'
            )
        );

        const context = grounding.getGroundingContext('telegram:chat-2');
        expect(context).toContain('dramatically pinned office coordination space');
    });
});
