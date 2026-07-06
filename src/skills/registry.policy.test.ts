import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const packBySpace = new Map<string, string>();

function makePackTool(name: string) {
    return {
        id: name,
        title: name,
        description: `${name} test tool`,
        script_path: `/mock/${name}.tool.js`,
        script_relative_path: `mock/${name}.tool.js`,
        execution: undefined,
        declaration: {
            name,
            description: `${name} test tool`,
            parameters: { type: 'object', properties: {} },
        },
        run: vi.fn(async () => `${name} result`),
    };
}

async function loadRegistryWithDb() {
    vi.resetModules();
    packBySpace.clear();
    process.env = {
        ...ORIGINAL_ENV,
        BOOTSTRAP_PACK: 'jeeves',
        DATA_DIR: `/tmp/open-pipi-registry-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    vi.doMock('../core/pack-tool-runtime', () => {
        return {
            getPackToolsForContext: (context?: { chatId?: string; spaceId?: string }) => {
                const spaceId = context?.spaceId || (context?.chatId ? `telegram:${context.chatId}` : undefined);
                const packId = spaceId ? packBySpace.get(spaceId) || 'jeeves' : 'jeeves';

                if (packId === 'office') {
                    return [
                        makePackTool('office_create_followup'),
                        makePackTool('office_focus_note'),
                        makePackTool('office_read_google_doc'),
                        makePackTool('office_standup_note'),
                    ];
                }

                if (packId === 'reporter') {
                    return [makePackTool('reporter_publish_note')];
                }

                if (packId === 'tutor') {
                    return [makePackTool('tutor_session_note')];
                }

                return [
                    makePackTool('jeeves_brief_note'),
                    makePackTool('jeeves_focus_plan'),
                    makePackTool('jeeves_review_note'),
                ];
            },
            executePackTool: vi.fn(async () => '[TOOL_RESULT] mocked pack tool'),
        };
    });

    const db = await import('../db');
    db.initDatabase();
    const registry = await import('./_registry');

    return { db, registry };
}

afterEach(async () => {
    try {
        const db = await import('../db');
        db.closeDatabase();
    } catch {}
    vi.doUnmock('../core/pack-tool-runtime');
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('skills registry policy filtering', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('filters tools by pack and resolved space policy', async () => {
        const { db, registry } = await loadRegistryWithDb();

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        db.upsertChat({ jid: 'chat-1', type: 'group' });
        db.upsertSpace({
            id: db.buildTelegramSpaceId('chat-1'),
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
        packBySpace.set(db.buildTelegramSpaceId('chat-1'), 'jeeves');
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-1'), '111', 'owner');

        const restricted = registry.getRegisteredToolsForContext({ chatId: 'chat-1', userId: '111' });
        const restrictedNames = restricted.map((tool) => tool.name).filter(Boolean);

        expect(restrictedNames).toContain('memory_remember');
        expect(restrictedNames).toContain('shopping_add');
        expect(restrictedNames).toContain('jeeves_brief_note');
        expect(restrictedNames).not.toContain('web_search');
        expect(restrictedNames).not.toContain('webrun_execute');
        expect(restrictedNames).not.toContain('task_create');

        db.upsertSpace({
            id: db.buildTelegramSpaceId('chat-1'),
            kind: 'group_chat',
            title: 'Team',
            channel: 'telegram',
            external_ref: 'chat-1',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({
                browser: true,
                tasks: true,
            }),
        });
        packBySpace.set(db.buildTelegramSpaceId('chat-1'), 'jeeves');

        const allowed = registry.getRegisteredToolsForContext({ chatId: 'chat-1', userId: '111' });
        const allowedNames = allowed.map((tool) => tool.name).filter(Boolean);

        expect(allowedNames).toContain('web_search');
        expect(allowedNames).toContain('webrun_execute');
        expect(allowedNames).toContain('task_create');
        expect(allowedNames).toContain('shopping_add');
        expect(allowedNames).toContain('jeeves_focus_plan');
    });

    it('shows space management tools only to members with can_change_policies', async () => {
        const { db, registry } = await loadRegistryWithDb();

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        db.upsertResident({
            tg_id: '222',
            username: 'bob',
            display_name: 'Bob',
            role: 'member',
        });
        db.upsertChat({ jid: 'chat-2', type: 'group' });
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-2'), '111', 'owner');
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-2'), '222', 'member');

        const ownerTools = registry.getRegisteredToolsForContext({ chatId: 'chat-2', userId: '111' });
        const memberTools = registry.getRegisteredToolsForContext({ chatId: 'chat-2', userId: '222' });

        expect(ownerTools.map((tool) => tool.name)).toContain('space_set_pack');
        expect(ownerTools.map((tool) => tool.name)).toContain('project_create');
        expect(ownerTools.map((tool) => tool.name)).toContain('grounding_set_pack');
        expect(ownerTools.map((tool) => tool.name)).toContain('task_create');
        expect(ownerTools.map((tool) => tool.name)).toContain('member_set_role');
        expect(ownerTools.map((tool) => tool.name)).toContain('atelier_request_capability');
        expect(memberTools.map((tool) => tool.name)).not.toContain('space_set_pack');
        expect(memberTools.map((tool) => tool.name)).not.toContain('project_create');
        expect(memberTools.map((tool) => tool.name)).not.toContain('grounding_set_pack');
        expect(memberTools.map((tool) => tool.name)).toContain('task_create');
        expect(memberTools.map((tool) => tool.name)).not.toContain('member_set_role');
        expect(memberTools.map((tool) => tool.name)).toContain('atelier_request_capability');
    });

    it('shows history search only to owner contexts', async () => {
        const { db, registry } = await loadRegistryWithDb();

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        db.upsertResident({
            tg_id: '222',
            username: 'bob',
            display_name: 'Bob',
            role: 'member',
        });
        db.upsertChat({ jid: 'chat-4', type: 'group' });
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-4'), '111', 'owner');
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-4'), '222', 'member');

        const ownerTools = registry.getRegisteredToolsForContext({ chatId: 'chat-4', userId: '111' });
        const memberTools = registry.getRegisteredToolsForContext({ chatId: 'chat-4', userId: '222' });

        expect(ownerTools.map((tool) => tool.name)).toContain('chat_search');
        expect(memberTools.map((tool) => tool.name)).not.toContain('chat_search');
    });

    it('shows workspace tools only when a workspace is attached to the space', async () => {
        const { db, registry } = await loadRegistryWithDb();

        db.upsertResident({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            role: 'owner',
        });
        db.upsertChat({ jid: 'chat-3', type: 'group' });
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-3'), '111', 'owner');

        const withoutWorkspace = registry.getRegisteredToolsForContext({ chatId: 'chat-3', userId: '111' });
        expect(withoutWorkspace.map((tool) => tool.name)).not.toContain('workspace_status');

        db.updateSpacePolicy(db.buildTelegramSpaceId('chat-3'), { workspace_path: '/tmp/project' });
        const withWorkspace = registry.getRegisteredToolsForContext({ chatId: 'chat-3', userId: '111' });
        expect(withWorkspace.map((tool) => tool.name)).toContain('workspace_status');
        expect(withWorkspace.map((tool) => tool.name)).toContain('workspace_read_text');
        expect(withWorkspace.map((tool) => tool.name)).toContain('workspace_find_text');
        expect(withWorkspace.map((tool) => tool.name)).toContain('workspace_list_artifacts');
        expect(withWorkspace.map((tool) => tool.name)).not.toContain('office_create_followup');

        db.upsertSpace({
            id: db.buildTelegramSpaceId('chat-3'),
            kind: 'group_chat',
            title: 'Office',
            channel: 'telegram',
            external_ref: 'chat-3',
            assistant_pack_id: 'office',
            policy_json: JSON.stringify({ workspace_path: '/tmp/project' }),
        });
        packBySpace.set(db.buildTelegramSpaceId('chat-3'), 'office');
        const withOfficePack = registry.getRegisteredToolsForContext({ chatId: 'chat-3', userId: '111' });
        expect(withOfficePack.map((tool) => tool.name)).toContain('workflow_list_templates');
        expect(withOfficePack.map((tool) => tool.name)).toContain('office_create_followup');
        expect(withOfficePack.map((tool) => tool.name)).toContain('office_focus_note');
        expect(withOfficePack.map((tool) => tool.name)).toContain('office_read_google_doc');
        expect(withOfficePack.map((tool) => tool.name)).toContain('office_standup_note');
        expect(withOfficePack.map((tool) => tool.name)).not.toContain('jeeves_brief_note');
    });
});
