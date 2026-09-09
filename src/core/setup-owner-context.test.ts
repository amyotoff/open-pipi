import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
let dataDir: string;

beforeEach(() => {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pipi-apply-owner-'));
    process.env = {
        ...ORIGINAL_ENV,
        DATA_DIR: dataDir,
        BOOTSTRAP_PACK: 'jeeves',
        BOOTSTRAP_GROUNDING: 'jeeves_starter',
    };
});

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('pending owner context runtime application', () => {
    it('applies once to the confirmed owner private space without granting tool authority', async () => {
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, {
            language: 'it',
            timezone: 'Europe/Rome',
            displayName: 'Amy',
            facts: ['Prefers concise answers'],
            currentTask: 'Prepare a travel plan',
        });
        const db = await import('../db');
        db.initDatabase();
        const runtimeContext = await import('./setup-owner-context');

        expect(runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] })).toEqual({
            status: 'applied',
            spaceId: 'telegram:111',
        });
        expect(runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] })).toEqual({
            status: 'already_applied',
        });

        const space = db.getSpace('telegram:111')!;
        expect(space.assistant_pack_id).toBe('jeeves');
        expect(space.grounding_pack_id).toBe('jeeves_starter');
        expect(JSON.parse(space.policy_json || '{}')).toMatchObject({
            default_language: 'it',
            timezone: 'Europe/Rome',
        });
        expect(db.getMembership(space.id, '111')?.role).toBe('owner');
        const overrides = db.listGroundingOverrides(space.id);
        expect(overrides).toHaveLength(1);
        expect(overrides[0].kind).toBe('person');
        expect(overrides[0].content).toContain('grants no tool authority');
    });

    it('applies explicitly saved preferences while preserving pack, grounding, and owner-edited context', async () => {
        const db = await import('../db');
        db.initDatabase();
        db.ensureSpace('telegram', '111', {
            kind: 'direct_chat',
            assistant_pack_id: 'tutor',
            grounding_pack_id: 'jeeves_personal',
        });
        db.updateSpacePolicy('telegram:111', { default_language: 'fr', timezone: 'Europe/Paris' });
        db.upsertGroundingOverride({
            space_id: 'telegram:111',
            kind: 'person',
            subject: 'Owner setup context',
            content: 'Owner corrected this context.',
            created_by: 'owner',
        });
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, {
            language: 'it',
            timezone: 'Europe/Rome',
            facts: ['Old setup suggestion'],
        });
        const runtimeContext = await import('./setup-owner-context');

        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        const space = db.getSpace('telegram:111')!;
        expect(space.assistant_pack_id).toBe('tutor');
        expect(space.grounding_pack_id).toBe('jeeves_personal');
        expect(JSON.parse(space.policy_json || '{}')).toMatchObject({
            default_language: 'it',
            timezone: 'Europe/Rome',
        });
        expect(db.listGroundingOverrides(space.id)[0].content).toBe('Owner corrected this context.');
    });

    it('refreshes an active setup-owned context on a later explicit save', async () => {
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, {
            language: 'en',
            timezone: 'UTC',
            facts: ['Context A'],
            currentTask: 'Task A',
        });
        const db = await import('../db');
        db.initDatabase();
        const runtimeContext = await import('./setup-owner-context');
        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        ownerContext.saveOwnerContext(dataDir, {
            language: 'it',
            timezone: 'Europe/Rome',
            facts: ['Context B'],
            currentTask: 'Task B',
        });
        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        const overrides = db.listGroundingOverrides('telegram:111');
        expect(overrides).toHaveLength(1);
        expect(overrides[0]).toMatchObject({ created_by: 'setup-owner-context', status: 'active' });
        expect(overrides[0].content).toContain('Context B');
        expect(overrides[0].content).toContain('Task B');
        expect(overrides[0].content).not.toContain('Context A');
        expect(overrides[0].content).not.toContain('Task A');
        expect(ownerContext.readOwnerContext(dataDir)?.applied?.revision).toBe(
            ownerContext.readOwnerContext(dataDir)?.revision
        );
    });

    it('clears stale setup context and can apply a later explicit replacement', async () => {
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, {
            language: 'en',
            timezone: 'UTC',
            facts: ['Context A'],
            currentTask: 'Task A',
        });
        const db = await import('../db');
        db.initDatabase();
        const runtimeContext = await import('./setup-owner-context');
        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        ownerContext.saveOwnerContext(dataDir, {
            language: 'en',
            timezone: 'UTC',
            displayName: '',
            facts: [],
            currentTask: '',
        });
        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        let overrides = db.listGroundingOverrides('telegram:111');
        expect(overrides).toEqual([
            expect.objectContaining({ content: '[Setup owner context intentionally empty.]', status: 'active' }),
        ]);
        expect(overrides[0].content).not.toContain('Context A');
        expect(overrides[0].content).not.toContain('Task A');
        expect(ownerContext.readOwnerSetupStatus({ dataDir, ownerTelegramIds: ['111'] })).toMatchObject({
            characterCustomized: false,
            profilePresent: false,
        });

        ownerContext.saveOwnerContext(dataDir, {
            language: 'en',
            timezone: 'UTC',
            facts: ['Context B'],
            currentTask: 'Task B',
        });
        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        overrides = db.listGroundingOverrides('telegram:111');
        expect(overrides).toHaveLength(1);
        expect(overrides[0].content).toContain('Context B');
        expect(overrides[0].content).toContain('Task B');
    });

    it('does not recreate or mutate a setup context that the owner disabled', async () => {
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, { language: 'en', timezone: 'UTC', facts: ['Context A'] });
        const db = await import('../db');
        db.initDatabase();
        const runtimeContext = await import('./setup-owner-context');
        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });
        const original = db.listGroundingOverrides('telegram:111')[0];
        db.disableGroundingOverride(original.id);

        ownerContext.saveOwnerContext(dataDir, { language: 'en', timezone: 'UTC', facts: ['Context B'] });
        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        expect(db.listGroundingOverrides('telegram:111')).toHaveLength(0);
        expect(db.listGroundingOverrides('telegram:111', { includeInactive: true })).toEqual([
            expect.objectContaining({
                id: original.id,
                content: expect.stringContaining('Context A'),
                status: 'inactive',
            }),
        ]);
    });

    it('uses configured bootstrap defaults when it creates the first private space', async () => {
        process.env.BOOTSTRAP_PACK = 'office';
        process.env.BOOTSTRAP_GROUNDING = 'jeeves_personal';
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, { language: 'en', timezone: 'UTC' });
        const db = await import('../db');
        db.initDatabase();
        const runtimeContext = await import('./setup-owner-context');

        runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] });

        expect(db.getSpace('telegram:111')).toMatchObject({
            assistant_pack_id: 'office',
            grounding_pack_id: 'jeeves_personal',
        });
    });

    it('applies context to the existing private space selected by the owner endpoint binding', async () => {
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, { language: 'it', timezone: 'Europe/Rome', facts: ['Bound fact'] });
        const db = await import('../db');
        db.initDatabase();
        db.upsertSpace({
            id: 'personal:amy',
            kind: 'direct_chat',
            title: 'Amy private',
            channel: 'web',
            external_ref: 'amy',
            assistant_pack_id: 'tutor',
        });
        db.ensureTransportBinding({
            transport: 'telegram',
            endpointId: '111',
            endpointType: 'direct',
            spaceId: 'personal:amy',
        });
        const runtimeContext = await import('./setup-owner-context');

        expect(runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111'] })).toEqual({
            status: 'applied',
            spaceId: 'personal:amy',
        });
        expect(db.listGroundingOverrides('personal:amy')[0].content).toContain('Bound fact');
        expect(db.getSpace('telegram:111')).toBeUndefined();
    });

    it('does not apply private context when the confirmed Telegram owner is ambiguous', async () => {
        const ownerContext = await import('../setup/owner-context');
        ownerContext.saveOwnerContext(dataDir, { language: 'en', timezone: 'UTC', facts: ['Private'] });
        const db = await import('../db');
        db.initDatabase();
        const runtimeContext = await import('./setup-owner-context');

        expect(runtimeContext.applyPendingOwnerContext({ dataDir, ownerTelegramIds: ['111', '222'] })).toEqual({
            status: 'ambiguous_owner',
        });
        expect(db.getSpace('telegram:111')).toBeUndefined();
    });
});
