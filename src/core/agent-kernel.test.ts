import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModules() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-agent-kernel-${Date.now()}` };

    const db = await import('../db');
    db.initDatabase();
    const kernel = await import('./agent-kernel');

    return { db, kernel };
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

describe('core/agent-kernel', () => {
    it('materializes the installable Jeeves agent for a Jeeves space', async () => {
        const { db, kernel } = await loadModules();

        db.upsertChat({ jid: 'chat-1', type: 'private' });

        const agent = kernel.materializeAgentForSpace('telegram:chat-1');

        expect(agent.id).toBe('jeeves');
        expect(agent.source).toBe('installable');
        expect(agent.system_prompt).toContain('You are Jeeves');
    });

    it('materializes the installable Office agent for an Office space', async () => {
        const { db, kernel } = await loadModules();

        db.upsertSpace({
            id: 'telegram:office',
            kind: 'group_chat',
            title: 'Office',
            channel: 'telegram',
            external_ref: 'office',
            assistant_pack_id: 'office',
        });

        const agent = kernel.materializeAgentForSpace('telegram:office');

        expect(agent.id).toBe('office');
        expect(agent.source).toBe('installable');
        expect(agent.enabled_capabilities).toContain('workspace');
        expect(agent.pack_tools.map((tool) => tool.id)).toEqual(
            expect.arrayContaining(['office_focus_note', 'office_standup_note'])
        );
    });

    it('pins the per-space pack snapshot under DATA_DIR once it exists', async () => {
        const { db, kernel } = await loadModules();
        const behavior = await import('./space-behavior');

        db.upsertSpace({
            id: 'telegram:office',
            kind: 'group_chat',
            title: 'Office',
            channel: 'telegram',
            external_ref: 'office',
            assistant_pack_id: 'office',
        });

        behavior.ensureSpaceBehaviorSnapshot('telegram:office');
        const snapshotRoot = behavior.getSpacePackSnapshotRoot('telegram:office');
        expect(snapshotRoot).toBeTruthy();

        const agentPath = path.join(snapshotRoot!, 'agent.md');
        const original = fs.readFileSync(agentPath, 'utf-8');
        fs.writeFileSync(
            agentPath,
            original.replace(
                'You are PiPi, a calm office facilitator for team chats and operational coordination.',
                'You are a pinned office ghost who refuses surprise upgrades.'
            )
        );

        const agent = kernel.materializeAgentForSpace('telegram:office');
        expect(agent.system_prompt).toContain('pinned office ghost');
        expect(agent.pack_root).toBe(snapshotRoot);
    });
});
