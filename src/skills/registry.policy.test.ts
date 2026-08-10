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
        expect(
            registry.getToolExecutionSpecForContext('web_search', {}, { chatId: 'chat-1', userId: '111' })
        ).toMatchObject({ approval: 'none' });
        expect(
            registry.getToolExecutionSpecForContext('browse_web', {}, { chatId: 'chat-1', userId: '111' })
        ).toMatchObject({ approval: 'explicit', approval_action: 'browse_web' });
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
        const ownerHandlers = registry.getRegisteredHandlersForContext({ chatId: 'chat-2', userId: '111' });
        const memberHandlers = registry.getRegisteredHandlersForContext({ chatId: 'chat-2', userId: '222' });

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
        expect(ownerHandlers.space_set_pack).toBeTypeOf('function');
        expect(memberHandlers.space_set_pack).toBeUndefined();
        expect(
            registry.getToolDeclarationForContext('space_set_pack', { chatId: 'chat-2', userId: '111' })
        ).toBeDefined();
        expect(
            registry.getToolDeclarationForContext('space_set_pack', { chatId: 'chat-2', userId: '222' })
        ).toBeUndefined();
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

    it('honors an exact nested-run tool allowlist for declarations and handlers', async () => {
        const { db, registry } = await loadRegistryWithDb();

        db.upsertResident({ tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
        db.upsertSpace({
            id: db.buildTelegramSpaceId('chat-5'),
            kind: 'group_chat',
            title: 'Office',
            channel: 'telegram',
            external_ref: 'chat-5',
            assistant_pack_id: 'office',
            policy_json: JSON.stringify({ browser: true, workspace_path: '/tmp/project' }),
        });
        packBySpace.set(db.buildTelegramSpaceId('chat-5'), 'office');
        db.ensureSpaceMembership(db.buildTelegramSpaceId('chat-5'), '111', 'owner');

        const context = {
            chatId: 'chat-5',
            userId: '111',
            allowedTools: ['web_search', 'workspace_read_text', 'office_read_google_doc'],
        };
        const tools = registry.getRegisteredToolsForContext(context);
        const handlers = registry.getRegisteredHandlersForContext(context);

        expect(tools.map((tool) => tool.name)).toEqual(['web_search', 'workspace_read_text', 'office_read_google_doc']);
        expect(handlers.web_search).toBeTypeOf('function');
        expect(handlers.workspace_read_text).toBeTypeOf('function');
        expect(handlers.office_read_google_doc).toBeTypeOf('function');
        expect(handlers.reminder_set).toBeUndefined();
        expect(handlers.workspace_save_artifact).toBeUndefined();
    });

    it('exposes Home Assistant tools only to the allowlisted owner subagent', async () => {
        const { db, registry } = await loadRegistryWithDb();

        db.upsertResident({ tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
        db.upsertResident({ tg_id: '222', username: 'bob', display_name: 'Bob', role: 'member' });
        db.upsertResident({ tg_id: '333', username: 'cara', display_name: 'Cara', role: 'member' });
        db.upsertSpace({
            id: db.buildTelegramSpaceId('home'),
            kind: 'group_chat',
            title: 'Home',
            channel: 'telegram',
            external_ref: 'home',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ browser: true }),
        });
        packBySpace.set(db.buildTelegramSpaceId('home'), 'jeeves');
        db.ensureSpaceMembership(db.buildTelegramSpaceId('home'), '111', 'owner');
        db.ensureSpaceMembership(db.buildTelegramSpaceId('home'), '222', 'member');
        db.ensureSpaceMembership(db.buildTelegramSpaceId('home'), '333', 'admin');

        const parentTools = registry.getRegisteredToolsForContext({ chatId: 'home', userId: '111' });
        expect(parentTools.map((tool) => tool.name)).not.toContain('home_assistant_get_state');

        const allowedTools = ['home_assistant_get_state'];
        const ownerContext = { chatId: 'home', userId: '111', allowedTools };
        const memberContext = { chatId: 'home', userId: '222', allowedTools };
        const adminContext = { chatId: 'home', userId: '333', allowedTools };
        const ownerTools = registry.getRegisteredToolsForContext(ownerContext);
        const ownerHandlers = registry.getRegisteredHandlersForContext(ownerContext);
        const memberTools = registry.getRegisteredToolsForContext(memberContext);
        const adminTools = registry.getRegisteredToolsForContext(adminContext);
        const capabilities = registry.getRegisteredCapabilitiesForContext(ownerContext);

        expect(ownerTools.map((tool) => tool.name)).toEqual(allowedTools);
        expect(ownerHandlers.home_assistant_get_state).toBeTypeOf('function');
        expect(ownerHandlers.home_assistant_control).toBeUndefined();
        expect(registry.getToolDeclarationForContext('home_assistant_get_state', ownerContext)).toBeDefined();
        expect(registry.getToolDeclarationForContext('home_assistant_control', ownerContext)).toBeUndefined();
        expect(capabilities.find((capability) => capability.skill === 'home_assistant')?.tools).toEqual(allowedTools);
        expect(memberTools).toEqual([]);
        expect(adminTools).toEqual([]);
        expect(
            registry
                .getRegisteredToolsForContext({ chatId: 'home', userId: '111', allowedTools: [] })
                .map((tool) => tool.name)
        ).not.toContain('home_assistant_get_state');

        process.env.HOME_ASSISTANT_TOKEN = 'test-token';
        process.env.HOME_ASSISTANT_CONTROL_ENTITIES = 'light.kitchen';
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const executor = await import('../core/tool-executor');
        const approvals = await import('../utils/approvals');
        const bypassAttempt = await executor.executeToolCall({
            toolName: 'home_assistant_control',
            toolArgs: { entity_id: 'light.kitchen', action: 'turn_off' },
            context: ownerContext,
            handlers: registry.getRegisteredHandlers(),
        });

        expect(bypassAttempt).toContain('not allowed in the current execution context');
        expect(approvals.listPendingApprovalActions(ownerContext)).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resumes one approved Home Assistant call through the current registry and executor', async () => {
        const { db, registry } = await loadRegistryWithDb();
        const spaceId = db.buildTelegramSpaceId('home-resume');
        db.upsertResident({ tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
        db.upsertSpace({
            id: spaceId,
            kind: 'private',
            title: 'Home',
            channel: 'telegram',
            external_ref: 'home-resume',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ browser: false, audit_trail: 'all' }),
        });
        packBySpace.set(spaceId, 'jeeves');
        db.ensureSpaceMembership(spaceId, '111', 'owner');
        process.env.HOME_ASSISTANT_URL = 'http://127.0.0.1:8123';
        process.env.HOME_ASSISTANT_TOKEN = 'test-token';
        process.env.HOME_ASSISTANT_CONTROL_ENTITIES = 'light.kitchen';

        const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/api/services/light/turn_off')) {
                expect(init?.method).toBe('POST');
                return new Response('[]', { status: 200 });
            }
            if (url.endsWith('/api/states/light.kitchen')) {
                return new Response(
                    JSON.stringify({
                        entity_id: 'light.kitchen',
                        state: 'off',
                        attributes: { friendly_name: 'Kitchen light' },
                    }),
                    { status: 200 }
                );
            }
            throw new Error(`Unexpected URL: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const executor = await import('../core/tool-executor');
        const approvals = await import('../utils/approvals');
        const continuation = await import('../core/approval-continuation');
        const context = {
            chatId: 'home-resume',
            userId: '111',
            spaceId,
            allowedTools: ['home_assistant_control'],
        };
        const toolArgs = { entity_id: 'light.kitchen', action: 'turn_off' };

        const blocked = await executor.executeToolCall({
            toolName: 'home_assistant_control',
            toolArgs,
            context,
            handlers: registry.getRegisteredHandlersForContext(context),
        });
        expect(blocked).toContain('Требуется явное подтверждение');
        expect(fetchMock).not.toHaveBeenCalled();

        const approved = approvals.recordApprovalResponse(context, 'да');
        expect(approved.continuations).toHaveLength(1);
        const [result] = await continuation.executeApprovedToolContinuations(approved.continuations!, context);

        expect(result.result).toContain('"accepted": true');
        expect(result.result).toContain('"verified": true');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(approvals.recordApprovalResponse(context, 'да')).toEqual({ granted: [], denied: [] });
        expect(db.getDb().prepare('SELECT status, error FROM tool_execution_log ORDER BY id').all()).toEqual([
            { status: 'blocked', error: 'approval_required' },
            { status: 'success', error: null },
        ]);
    });

    it('revalidates the control allowlist before resuming and revokes a blocked grant', async () => {
        const { db, registry } = await loadRegistryWithDb();
        const spaceId = db.buildTelegramSpaceId('home-revalidate');
        db.upsertResident({ tg_id: '111', username: 'alice', display_name: 'Alice', role: 'owner' });
        db.upsertSpace({
            id: spaceId,
            kind: 'private',
            title: 'Home',
            channel: 'telegram',
            external_ref: 'home-revalidate',
            assistant_pack_id: 'jeeves',
            policy_json: JSON.stringify({ browser: false }),
        });
        packBySpace.set(spaceId, 'jeeves');
        db.ensureSpaceMembership(spaceId, '111', 'owner');
        process.env.HOME_ASSISTANT_TOKEN = 'test-token';
        process.env.HOME_ASSISTANT_CONTROL_ENTITIES = 'light.kitchen';
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const executor = await import('../core/tool-executor');
        const approvals = await import('../utils/approvals');
        const continuation = await import('../core/approval-continuation');
        const context = {
            chatId: 'home-revalidate',
            userId: '111',
            spaceId,
            allowedTools: ['home_assistant_control'],
        };
        const toolArgs = { entity_id: 'light.kitchen', action: 'turn_off' };
        await executor.executeToolCall({
            toolName: 'home_assistant_control',
            toolArgs,
            context,
            handlers: registry.getRegisteredHandlersForContext(context),
        });

        process.env.HOME_ASSISTANT_CONTROL_ENTITIES = '';
        const approved = approvals.recordApprovalResponse(context, 'да');
        const [blocked] = await continuation.executeApprovedToolContinuations(approved.continuations!, context);
        expect(blocked.result).toContain('not in the Home Assistant control allowlist');
        expect(fetchMock).not.toHaveBeenCalled();

        process.env.HOME_ASSISTANT_CONTROL_ENTITIES = 'light.kitchen';
        const retry = await executor.executeToolCall({
            toolName: 'home_assistant_control',
            toolArgs,
            context,
            handlers: registry.getRegisteredHandlersForContext(context),
        });
        expect(retry).toContain('Требуется явное подтверждение');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
