import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadComposer(options?: { spacePolicyJson?: string; recentMessages?: any[]; searchMessages?: any[] }) {
    vi.resetModules();

    const defaultRecentMessages = [
        {
            id: 'm1',
            chat_jid: 'chat-1',
            space_id: 'telegram:chat-1',
            sender_tg_id: '111',
            content: 'Need a shortlist for tomorrow',
            timestamp: '2026-03-25T09:00:00.000Z',
            is_bot: 0,
        },
        {
            id: 'm2',
            chat_jid: 'chat-1',
            space_id: 'telegram:chat-1',
            sender_tg_id: 'jivs',
            content: 'I will prepare one.',
            timestamp: '2026-03-25T09:01:00.000Z',
            is_bot: 1,
        },
    ];
    const getRecentMessagesForSpace = vi.fn(() => options?.recentMessages || defaultRecentMessages);
    const getRecentDirectMessagesForPerson = vi.fn((): any[] => []);
    const getDirectContactStatuses = vi.fn((): any[] => []);
    const getMemoryEntries = vi.fn((): any[] => []);
    const getResident = vi.fn(() => ({
        tg_id: '111',
        username: 'alice',
        display_name: 'Alice',
        nickname: null,
        role: 'owner',
        habits: 'prefers concise updates',
    }));
    const getMemberEffectiveAuthority = vi.fn(() => 1000);
    const getSpaceParticipants = vi.fn(() => [
        {
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            nickname: null,
            role: 'owner',
            last_seen: null,
            joined_at: '2026-03-20T10:00:00.000Z',
            habits: 'prefers concise updates',
            space_id: 'telegram:chat-1',
            membership_role: 'owner',
            base_authority: 1000,
            reputation_delta: 0,
            effective_authority: 1000,
            authority_note: 'team lead',
            trust_flags: {
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            },
        },
        {
            tg_id: '222',
            username: 'bob',
            display_name: 'Bob',
            nickname: null,
            role: 'member',
            last_seen: null,
            joined_at: '2026-03-21T10:00:00.000Z',
            habits: '',
            space_id: 'telegram:chat-1',
            membership_role: 'member',
            base_authority: 100,
            reputation_delta: 15,
            effective_authority: 115,
            authority_note: 'analyst',
            trust_flags: {
                can_assign_tasks: true,
                can_change_policies: false,
                can_override_instructions: false,
                can_issue_high_impact_commands: false,
            },
        },
    ]);
    const getAllResidents = vi.fn(() => []);
    const searchMessages = vi.fn(() => options?.searchMessages || []);
    const materializeAgentForSpace = vi.fn(() => ({
        id: 'office',
        persona_id: 'facilitator',
        system_prompt: 'You are an office facilitator.',
        enabled_capabilities: ['todos', 'reminders', 'memory'],
        memory_rules: ['person', 'space', 'work'],
        seeded_tasks: [],
        default_policies: {
            browser: true,
            tasks: true,
        },
        authority_presets: {},
        skills_doc: '',
        tools_doc: '',
        core_toolbox: {
            primitives: [
                {
                    id: 'web',
                    description: 'Internet access',
                    backing_capabilities: ['browsing'],
                    backing_tools: ['web_search'],
                },
                {
                    id: 'file_search',
                    description: 'Workspace search',
                    backing_capabilities: ['workspace'],
                    backing_tools: ['workspace_find_text'],
                },
                { id: 'user_info', description: 'Current local context', backing_capabilities: [], backing_tools: [] },
                {
                    id: 'personal_context',
                    description: 'Memory and history',
                    backing_capabilities: ['memory'],
                    backing_tools: ['memory_recall'],
                },
                {
                    id: 'automations',
                    description: 'Tasks and reminders',
                    backing_capabilities: ['reminders'],
                    backing_tools: ['reminder_add'],
                },
                { id: 'api_tool', description: 'Integrations', backing_capabilities: [], backing_tools: [] },
            ],
            system_capabilities: [
                {
                    id: 'bio',
                    description: 'Memory writes',
                    backing_capabilities: ['memory'],
                    backing_tools: ['memory_remember'],
                },
                {
                    id: 'execution_runtime',
                    description: 'Internal runtime',
                    backing_capabilities: [],
                    backing_tools: [],
                },
            ],
        },
        pack_tools: [
            {
                id: 'office_focus_note',
                title: 'Office focus note',
                description: 'Focus note',
                script_path: '/tmp/tool.js',
                script_relative_path: 'packs/office/tools/tool.js',
                declaration: {
                    name: 'office_focus_note',
                    description: 'Focus note',
                    parameters: { type: 'object', properties: {} },
                },
                run: vi.fn(async () => 'Office focus note'),
            },
        ],
        source: 'installable',
        pack_root: '/tmp/office-pack',
    }));
    const getMemoryContext = vi.fn(() => '[MEMORY]\nAlice is preparing a board update.');
    const getActiveProjectForSpace = vi.fn(() => ({
        id: 'project:firebreak',
        slug: 'firebreak',
        title: 'Firebreak',
        state: 'active',
        goal: 'Stabilize the board update and decision memo.',
        next_step: 'Draft the shortlist note.',
        active_pack_id: 'office',
        created_at: '2026-03-24T09:00:00.000Z',
        updated_at: '2026-03-25T09:05:00.000Z',
        linked_spaces: ['telegram:chat-1'],
        linked_tasks: ['task:telegram:chat-1:shortlist'],
        linked_artifacts: ['.pipi/office/2026-03-25-shortlist.md'],
    }));
    const getWorkspaceSnapshot = vi.fn(() => ({
        root: '/tmp/project',
        exists: true,
        entries: ['briefs/', 'notes.md'],
    }));
    const getGroundingContext = vi.fn(() =>
        [
            '[GROUNDING]',
            'Pack: jeeves_personal',
            'Title: Office Coordination',
            'Memory focus: commitments, preferences',
            '',
            '[GROUNDING_OVERRIDES]',
            '- person / Alice: Alice is on leave this week.',
        ].join('\n')
    );
    const ensureActiveMemorySprint = vi.fn(() => ({
        id: 'sprint:telegram:chat-1:2026-03-25',
        opened_at: '2026-03-25T00:00:00.000Z',
        closes_at: '2026-04-01T00:00:00.000Z',
        cadence_days: 7,
    }));
    const listWorkflowTemplatesForPack = vi.fn(() => [
        { id: 'office_followup', title: 'Team follow-up', description: 'follow-up', folder: 'office' },
    ]);

    const spacePolicyJson = options?.spacePolicyJson || JSON.stringify({ workspace_path: '/tmp/project' });
    const mockedSpace = {
        id: 'telegram:chat-1',
        kind: 'group_chat',
        assistant_pack_id: 'office',
        grounding_pack_id: 'jeeves_personal',
        policy_json: spacePolicyJson,
        channel: 'telegram',
        external_ref: 'chat-1',
        created_at: '2026-04-29T09:00:00.000Z',
    };

    vi.doMock('../db', () => ({
        getRecentMessagesForSpace,
        getRecentDirectMessagesForPerson,
        getDirectContactStatuses,
        getMemoryEntries,
        searchMessages,
        buildTelegramSpaceId: vi.fn((chatId: string) => `telegram:${chatId}`),
        getSpace: vi.fn(() => mockedSpace),
        getSpaceByChannelRef: vi.fn(() => mockedSpace),
        getActiveProjectForSpace,
        getResident,
        getMemberEffectiveAuthority,
        getSpaceParticipants,
        getAllResidents,
        getLatestArtifactByKind: vi.fn(() => undefined),
    }));
    vi.doMock('./agent-kernel', () => ({
        materializeAgentForSpace,
    }));
    vi.doMock('./memory-context', () => ({ getMemoryContext }));
    vi.doMock('./grounding-context', () => ({ getGroundingContext }));
    vi.doMock('./workspace', () => ({ getWorkspaceSnapshot }));
    vi.doMock('./workflows', () => ({ listWorkflowTemplatesForPack }));
    vi.doMock('./memory-sprint', () => ({ ensureActiveMemorySprint }));

    const mod = await import('./context-composer');
    return {
        ...mod,
        mocks: {
            getRecentMessagesForSpace,
            getRecentDirectMessagesForPerson,
            getDirectContactStatuses,
            searchMessages,
            materializeAgentForSpace,
            getMemoryContext,
        },
    };
}

beforeEach(() => {
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('Wednesday, 25 March 2026');
    vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('10:00');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/context-composer', () => {
    it('builds pack-aware system context with authority and memory', async () => {
        const mod = await loadComposer();
        const result = mod.composeConversationContext({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            channelRef: 'chat-1',
        });

        expect(result.spaceId).toBe('telegram:chat-1');
        expect(result.assistantPackId).toBe('office');
        expect(result.groundingPackId).toBe('jeeves_personal');
        expect(result.systemPrompt).toContain('Pack: office');
        expect(result.systemPrompt).toContain('Persona: facilitator');
        expect(result.systemPrompt).toContain('[GROUNDING]');
        expect(result.systemPrompt).toContain('Office Coordination');
        expect(result.systemPrompt).toContain('Alice is on leave this week');
        expect(result.systemPrompt).toContain('[CORE_TOOLBOX]');
        expect(result.systemPrompt).toContain('web: Internet access');
        expect(result.systemPrompt).toContain('bio: Memory writes');
        expect(result.systemPrompt).toContain('[POLICY]');
        expect(result.systemPrompt).toContain('browser: true');
        expect(result.systemPrompt).toContain('memory_sprint_days: 7');
        expect(result.systemPrompt).toContain('[PROJECT]');
        expect(result.systemPrompt).toContain('Title: Firebreak');
        expect(result.systemPrompt).toContain('Next step: Draft the shortlist note.');
        expect(result.systemPrompt).toContain('[MEMORY_SPRINT]');
        expect(result.systemPrompt).toContain('Channel ref: chat-1');
        expect(result.systemPrompt).toContain('Current speaker: Alice');
        expect(result.systemPrompt).toContain('authority: 1000');
        expect(result.systemPrompt).toContain('[HTML_ARTIFACTS]');
        expect(result.systemPrompt).toContain('prefer html_artifact_create');
        expect(result.systemPrompt).not.toContain('knowledge density:');
        expect(result.systemPrompt).not.toContain('/15');
        expect(result.systemPrompt).toContain('Bob');
        expect(result.systemPrompt).toContain('trust: assign_tasks');
        expect(result.systemPrompt).toContain('[WORKSPACE]');
        expect(result.systemPrompt).toContain('/tmp/project');
        expect(result.systemPrompt).toContain('briefs/');
        expect(result.systemPrompt).toContain('[WORKFLOWS]');
        expect(result.systemPrompt).toContain('office_followup');
        expect(result.systemPrompt).toContain('[PACK_TOOLS]');
        expect(result.systemPrompt).toContain('office_focus_note');
        expect(result.systemPrompt).toContain('[MEMORY]');
        expect(mod.mocks.getMemoryContext).toHaveBeenCalledWith(
            expect.objectContaining({
                residentId: '111',
                spaceId: 'telegram:chat-1',
                projectId: 'project:firebreak',
            })
        );
        expect(result.llmMessages).toEqual([
            expect.objectContaining({ role: 'system' }),
            { role: 'user', content: '[Alice]: Need a shortlist for tomorrow' },
            { role: 'assistant', content: 'I will prepare one.' },
        ]);
    });

    it('adds privacy-limited DM continuity in group contexts', async () => {
        const mod = await loadComposer();
        mod.mocks.getRecentDirectMessagesForPerson.mockReturnValueOnce([
            {
                id: 'dm1',
                chat_jid: '111',
                space_id: 'telegram:111',
                sender_tg_id: '111',
                sender_id: '111',
                content: 'I wrote in DM yesterday',
                timestamp: '2026-03-25T08:00:00.000Z',
                is_bot: 0,
            },
        ]);
        mod.mocks.getDirectContactStatuses.mockReturnValueOnce([
            {
                person_id: '111',
                last_inbound_at: '2026-03-25T08:00:00.000Z',
                inbound_count: 1,
            },
            {
                person_id: '222',
                last_inbound_at: '2026-03-25T08:30:00.000Z',
                inbound_count: 1,
            },
        ]);

        const result = mod.composeConversationContext({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            channelRef: 'chat-1',
        });

        expect(result.systemPrompt).toContain('[PRIVATE_CONTINUITY]');
        expect(result.systemPrompt).toContain('I wrote in DM yesterday');
        expect(result.systemPrompt).toContain('Bob last contacted the assistant in DM');
        expect(mod.mocks.getRecentDirectMessagesForPerson).toHaveBeenCalledWith('telegram', '111', 8);
        expect(mod.mocks.getDirectContactStatuses).toHaveBeenCalledWith('telegram', ['111', '222']);
    });

    it('adds external group self-regulation guidance for attached partner spaces', async () => {
        const mod = await loadComposer({
            spacePolicyJson: JSON.stringify({
                workspace_path: '/tmp/project',
                external_group_enabled: true,
                external_group_mode: 'auto',
            }),
        });

        const result = mod.composeConversationContext({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            channelRef: 'chat-1',
        });

        expect(result.systemPrompt).toContain('[EXTERNAL_GROUP_SELF_REGULATION]');
        expect(result.systemPrompt).toContain('Context sensitivity');
        expect(result.systemPrompt).toContain('Strategy repertoire');
        expect(result.systemPrompt).toContain('Strategy switching');
        expect(result.systemPrompt).toContain('Current routing mode: auto');
        expect(result.systemPrompt).toContain('reply exactly [NO_SEND]');
    });

    it('adds cross-space lookup hints when an owner asks about another topic chat', async () => {
        const mod = await loadComposer({
            recentMessages: [
                {
                    id: 'm1',
                    chat_jid: 'chat-1',
                    space_id: 'telegram:chat-1',
                    sender_tg_id: '111',
                    content: 'пипи че там в чате по рекламе?',
                    timestamp: '2026-03-25T09:00:00.000Z',
                    is_bot: 0,
                },
            ],
            searchMessages: [
                {
                    space_id: 'telegram:partner-chat',
                    channel_ref: 'partner-chat',
                    sender_id: '222',
                    sender_name: 'Partner',
                    space_title: 'Ads partner',
                    content: 'По рекламе договорились подготовить медиаплан к пятнице.',
                    timestamp: '2026-03-25T08:55:00.000Z',
                    is_bot: 0,
                },
            ],
        });

        const result = mod.composeConversationContext({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            channelRef: 'chat-1',
        });

        expect(result.systemPrompt).toContain('[CROSS_SPACE_LOOKUP]');
        expect(result.systemPrompt).toContain('Candidate search terms: реклам');
        expect(result.systemPrompt).toContain('Ads partner / Partner');
        expect(result.systemPrompt).toContain('call chat_search with scope="all_spaces"');
        expect(mod.mocks.searchMessages).toHaveBeenCalledWith('реклам', { limit: 8 });
    });

    it('keeps the cross-space request when the owner triggers the bot in a follow-up message', async () => {
        const mod = await loadComposer({
            recentMessages: [
                {
                    id: 'm1',
                    chat_jid: 'chat-1',
                    space_id: 'telegram:chat-1',
                    sender_tg_id: '111',
                    content: 'так че там в чате про рекламу у нас сейчас интересного?',
                    timestamp: '2026-03-25T09:00:00.000Z',
                    is_bot: 0,
                },
                {
                    id: 'm2',
                    chat_jid: 'chat-1',
                    space_id: 'telegram:chat-1',
                    sender_tg_id: '111',
                    content: 'пипи',
                    timestamp: '2026-03-25T09:00:05.000Z',
                    is_bot: 0,
                },
            ],
            searchMessages: [
                {
                    space_id: 'telegram:partner-chat',
                    channel_ref: 'partner-chat',
                    sender_id: '222',
                    sender_name: 'Partner',
                    space_title: 'AI-Duck Advertising',
                    content: 'Реклама в Meta: стартовый бюджет 20 евро в день, потом 50 евро.',
                    timestamp: '2026-03-25T08:55:00.000Z',
                    is_bot: 0,
                },
            ],
        });

        const result = mod.composeConversationContext({
            spaceId: 'telegram:chat-1',
            senderId: '111',
            channelRef: 'chat-1',
        });

        expect(result.systemPrompt).toContain('[CROSS_SPACE_LOOKUP]');
        expect(result.systemPrompt).toContain('AI-Duck Advertising / Partner');
        expect(result.systemPrompt).toContain('стартовый бюджет 20 евро');
        expect(mod.mocks.searchMessages).toHaveBeenCalledWith('реклам', { limit: 8 });
    });
});
