import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('core/handoff', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env = {
            ...ORIGINAL_ENV,
            DATA_DIR: `/tmp/open-pipi-handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    it('builds and stores a compact handoff artifact from current space state', async () => {
        const db = await import('../db');
        const memoryWrite = await import('./memory-write');
        const timeline = await import('./timeline');
        db.initDatabase();

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        const space = db.ensureTelegramSpace('chat-handoff', 'group', 'Ops Room');
        db.ensureSpaceMembership(space.id, '111', 'owner');

        const project = db.createProject({
            title: 'Release Prep',
            goal: 'Prepare the next release safely.',
            next_step: 'Check the rollout checklist.',
        });
        db.setSpaceActiveProject(space.id, project.id);

        db.createArtifact({
            id: 'art_plan_1',
            space_id: space.id,
            source_message_id: null,
            kind: 'plan',
            title: 'Release Plan',
            ref: '# Plan\n\nShip carefully.',
            summary: 'Short release plan.',
        });

        memoryWrite.rememberWorkMemory(space.id, 'note', 'Staging deploy already approved.', {
            salience: 0.8,
            source: 'test',
        });
        timeline.appendTimelineEvent({
            spaceId: space.id,
            type: 'task.completed',
            summary: 'Drafted the rollout checklist.',
        });

        const handoff = await import('./handoff');
        const artifact = handoff.createHandoffArtifactForSpace(space.id);

        expect(artifact.kind).toBe('handoff');
        expect(artifact.ref).toContain('Release Prep');
        expect(artifact.ref).toContain('Release Plan');
        expect(artifact.ref).toContain('Drafted the rollout checklist.');
        expect(artifact.ref).toContain('Staging deploy already approved.');

        const resumed = handoff.resumeFromHandoffForSpace(space.id);
        expect(resumed.id).toBe(artifact.id);
    });
});
