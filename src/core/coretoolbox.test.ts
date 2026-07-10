import { afterEach, describe, expect, it, vi } from 'vitest';

function mockCoreContext() {
    vi.doMock('../db', () => ({
        getMemberEffectiveAuthority: vi.fn(() => 1000),
        getResident: vi.fn(() => ({
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            nickname: null,
            role: 'owner',
        })),
        getSpace: vi.fn(() => ({
            id: 'telegram:chat-1',
            assistant_pack_id: 'office',
            title: 'Office',
            channel: 'telegram',
            external_ref: 'chat-1',
        })),
        getSpaceParticipants: vi.fn(() => [
            {
                tg_id: '111',
                username: 'alice',
                display_name: 'Alice',
                nickname: null,
                membership_role: 'owner',
            },
            {
                tg_id: '222',
                username: 'bob',
                display_name: 'Bob',
                nickname: null,
                membership_role: 'member',
            },
        ]),
    }));
    vi.doMock('../config', () => ({
        LOCATION_LAT: '41.9028',
        LOCATION_LON: '12.4964',
    }));
    vi.doMock('./policy', () => ({
        resolveSpacePolicy: vi.fn(() => ({
            browser: true,
            tasks: true,
            memory_sprint_days: 7,
            sandbox_enabled: false,
            audit_trail: 'errors',
            allowed_capabilities: null,
            workspace_path: '/tmp/project',
        })),
        resolveAllowedCapabilities: vi.fn(() => [
            'shell_none',
            'workspace_read',
            'artifact_write',
            'external_http',
            'web_browse',
        ]),
    }));
    vi.doMock('./agent-kernel', () => ({
        materializeAgentForSpace: vi.fn(() => ({
            id: 'office',
            persona_id: 'facilitator',
        })),
    }));
    vi.doMock('./pack-tool-runtime', () => ({
        executePackTool: vi.fn(
            async (toolId: string, payload: Record<string, unknown>) =>
                `[TOOL_RESULT] pack:${toolId}:${JSON.stringify(payload)}`
        ),
        getPackToolsForContext: vi.fn(() => [{ id: 'office_focus_note' }]),
    }));
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/coretoolbox', () => {
    it('materializes the six core primitives and two system capabilities', async () => {
        const mod = await import('./coretoolbox');

        const toolbox = mod.materializeCoreToolbox([
            'memory',
            'shopping',
            'history',
            'browsing',
            'webrun',
            'workspace',
            'reminders',
            'tasks',
        ]);

        expect(toolbox.primitives.map((entry) => entry.id)).toEqual([
            'web',
            'file_search',
            'user_info',
            'personal_context',
            'automations',
            'api_tool',
        ]);
        expect(toolbox.system_capabilities.map((entry) => entry.id)).toEqual(['bio', 'execution_runtime']);
        expect(toolbox.primitives.find((entry) => entry.id === 'web')?.backing_capabilities).toEqual(
            expect.arrayContaining(['browsing', 'webrun'])
        );
        expect(toolbox.primitives.find((entry) => entry.id === 'file_search')?.backing_capabilities).toEqual([
            'workspace',
        ]);
        expect(toolbox.primitives.find((entry) => entry.id === 'automations')?.backing_capabilities).toEqual(
            expect.arrayContaining(['shopping', 'reminders', 'tasks'])
        );
        expect(toolbox.system_capabilities.find((entry) => entry.id === 'bio')?.backing_capabilities).toEqual([
            'memory',
        ]);
        expect(mod.CORE_PRIMITIVE_BACKING_TOOL_NAMES).toContain('web_search');
        expect(mod.CORE_PRIMITIVE_BACKING_TOOL_NAMES).toContain('workspace_save_artifact');
        expect(mod.CORE_PRIMITIVE_BACKING_TOOL_NAMES).not.toContain('memory_remember');
        expect(mod.isCorePrimitiveBackingTool('task_create')).toBe(true);
        expect(mod.isCorePrimitiveBackingTool('project_create')).toBe(false);
    });

    it('routes the unified web primitive to the existing web_search handler', async () => {
        mockCoreContext();
        const mod = await import('./coretoolbox');
        const webSearch = vi.fn(async ({ query }: { query: string }) => `[TOOL_RESULT] Search results for ${query}`);

        const result = await mod.handleCoreToolboxTool(
            'web',
            { operation: 'search', query: 'rome news' },
            { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1', channel: 'telegram', channelRef: 'chat-1' },
            { web_search: webSearch }
        );

        expect(webSearch).toHaveBeenCalledWith(
            { query: 'rome news' },
            expect.objectContaining({ userId: '111', chatId: 'chat-1' })
        );
        expect(result).toContain('rome news');
    });

    it('formats user_info from the active runtime context', async () => {
        mockCoreContext();
        const mod = await import('./coretoolbox');

        const result = await mod.handleCoreToolboxTool(
            'user_info',
            { detail: 'summary' },
            { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1', channel: 'telegram', channelRef: 'chat-1' },
            {}
        );

        expect(result).toContain('Speaker: Alice');
        expect(result).toContain('Pack: office');
        expect(result).toContain('Approximate location: 41.9028, 12.4964');
    });

    it('routes api_tool pack calls through the pack tool runtime', async () => {
        mockCoreContext();
        const mod = await import('./coretoolbox');

        const result = await mod.handleCoreToolboxTool(
            'api_tool',
            { operation: 'run_pack_tool', tool_id: 'office_focus_note', payload_json: '{"topic":"board"}' },
            { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1', channel: 'telegram', channelRef: 'chat-1' },
            {}
        );

        expect(result).toContain('pack:office_focus_note');
        expect(result).toContain('"topic":"board"');
    });

    it('passes recurring reminder args through the automations primitive', async () => {
        mockCoreContext();
        const mod = await import('./coretoolbox');
        const reminderSet = vi.fn(
            async ({ content, frequency, time_local }: { content: string; frequency: string; time_local: string }) =>
                `[TOOL_RESULT] ${content}:${frequency}:${time_local}`
        );

        const result = await mod.handleCoreToolboxTool(
            'automations',
            { operation: 'set_reminder', content: 'Standup', frequency: 'weekdays', time_local: '09:00' },
            { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1', channel: 'telegram', channelRef: 'chat-1' },
            { reminder_set: reminderSet }
        );

        expect(reminderSet).toHaveBeenCalledWith(
            { content: 'Standup', frequency: 'weekdays', time_local: '09:00' },
            expect.objectContaining({ userId: '111', chatId: 'chat-1' })
        );
        expect(result).toContain('Standup:weekdays:09:00');
    });

    it('routes shopping actions through the automations primitive', async () => {
        mockCoreContext();
        const mod = await import('./coretoolbox');
        const shoppingAdd = vi.fn(
            async ({ item, quantity }: { item: string; quantity?: string }) =>
                `[TOOL_RESULT] shopping:${item}:${quantity || '1'}`
        );

        const result = await mod.handleCoreToolboxTool(
            'automations',
            { operation: 'add_shopping_item', item: 'Olive oil', quantity: '1 bottle' },
            { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1', channel: 'telegram', channelRef: 'chat-1' },
            { shopping_add: shoppingAdd }
        );

        expect(shoppingAdd).toHaveBeenCalledWith(
            { item: 'Olive oil', quantity: '1 bottle' },
            expect.objectContaining({ userId: '111', chatId: 'chat-1' })
        );
        expect(result).toContain('shopping:Olive oil:1 bottle');
    });

    it('passes optional task deadlines through the automations primitive', async () => {
        mockCoreContext();
        const mod = await import('./coretoolbox');
        const taskCreate = vi.fn(
            async ({
                title,
                frequency,
                time_local,
                deadline_at,
            }: {
                title: string;
                frequency: string;
                time_local: string;
                deadline_at: string;
            }) => `[TOOL_RESULT] ${title}:${frequency}:${time_local}:${deadline_at}`
        );

        const result = await mod.handleCoreToolboxTool(
            'automations',
            {
                operation: 'create_task',
                title: 'Weekly digest',
                prompt: 'Write it.',
                frequency: 'weekdays',
                time_local: '08:00',
                deadline_at: '2026-04-01T10:00:00.000Z',
            },
            { chatId: 'chat-1', userId: '111', spaceId: 'telegram:chat-1', channel: 'telegram', channelRef: 'chat-1' },
            { task_create: taskCreate }
        );

        expect(taskCreate).toHaveBeenCalledWith(
            {
                title: 'Weekly digest',
                prompt: 'Write it.',
                frequency: 'weekdays',
                time_local: '08:00',
                deadline_at: '2026-04-01T10:00:00.000Z',
            },
            expect.objectContaining({ userId: '111', chatId: 'chat-1' })
        );
        expect(result).toContain('Weekly digest:weekdays:08:00:2026-04-01T10:00:00.000Z');
    });
});
