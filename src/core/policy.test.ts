import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadPolicyModule() {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-policy-${Date.now()}` };
    const db = await import('../db');
    db.initDatabase();
    const policy = await import('./policy');
    return { db, policy };
}

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/policy', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('merges pack defaults with space policy overrides', async () => {
        const { db, policy } = await loadPolicyModule();

        db.upsertSpace({
            id: 'telegram:chat-1',
            kind: 'group_chat',
            title: 'Team',
            channel: 'telegram',
            external_ref: 'chat-1',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({
                browser: false,
                tasks: false,
            }),
        });

        const resolved = policy.resolveSpacePolicy('telegram:chat-1');

        expect(resolved.browser).toBe(false);
        expect(resolved.tasks).toBe(false);
        expect(resolved.memory_sprint_days).toBe(7);
        expect(resolved.audit_trail).toBe('errors');
        expect(resolved.sandbox_enabled).toBe(false);
    });

    it('derives allowed capabilities from workspace and browser policy', async () => {
        const { db, policy } = await loadPolicyModule();

        db.upsertSpace({
            id: 'telegram:chat-2',
            kind: 'group_chat',
            title: 'Workspace',
            channel: 'telegram',
            external_ref: 'chat-2',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({
                browser: true,
                workspace_path: '/tmp/project',
                audit_trail: 'all',
            }),
        });

        const resolved = policy.resolveSpacePolicy('telegram:chat-2');
        const allowed = policy.resolveAllowedCapabilities(resolved);

        expect(resolved.audit_trail).toBe('all');
        expect(allowed).toEqual(
            expect.arrayContaining(['shell_none', 'workspace_read', 'artifact_write', 'external_http', 'web_browse'])
        );
    });

    it('keeps explicit allowed capabilities as the resolved contract', async () => {
        const { db, policy } = await loadPolicyModule();

        db.upsertSpace({
            id: 'telegram:chat-3',
            kind: 'group_chat',
            title: 'Locked down',
            channel: 'telegram',
            external_ref: 'chat-3',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({
                browser: true,
                workspace_path: '/tmp/project',
                allowed_capabilities: ['workspace_read', 'shell_none', 'workspace_read', 'invalid_capability'],
            }),
        });

        const resolved = policy.resolveSpacePolicy('telegram:chat-3');
        const allowed = policy.resolveAllowedCapabilities(resolved);

        expect(resolved.allowed_capabilities).toEqual(['workspace_read', 'shell_none']);
        expect(allowed).toEqual(['workspace_read', 'shell_none']);
    });
});
