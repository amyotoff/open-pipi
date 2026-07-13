import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadButler(options: { task?: any; briefUrl?: string | null } = {}) {
    vi.resetModules();

    const getRecentMessagesForSpace = vi.fn(() => []);
    const storeMessage = vi.fn();
    const getResident = vi.fn(() => ({
        tg_id: '111',
        username: 'alice',
        display_name: 'Alice',
        nickname: null,
        role: 'owner',
        habits: 'likes coffee',
    }));
    const getAllResidents = vi.fn(() => [
        {
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            nickname: null,
            role: 'owner',
            habits: 'likes coffee',
        },
    ]);
    const buildTelegramSpaceId = vi.fn((chatId: string) => `telegram:${chatId}`);
    const getMemberEffectiveAuthority = vi.fn(() => 1000);
    const listGroundingOverrides = vi.fn(() => []);
    const getSpaceParticipants = vi.fn(() => [
        {
            tg_id: '111',
            username: 'alice',
            display_name: 'Alice',
            nickname: null,
            role: 'owner',
            membership_role: 'owner',
            habits: 'likes coffee',
            last_seen: null,
            joined_at: new Date().toISOString(),
            space_id: 'telegram:chat-1',
            base_authority: 1000,
            reputation_delta: 0,
            effective_authority: 1000,
            authority_note: 'space owner',
            trust_flags: {
                can_assign_tasks: true,
                can_change_policies: true,
                can_override_instructions: true,
                can_issue_high_impact_commands: true,
            },
        },
    ]);
    const logEvent = vi.fn();
    const getTask = vi.fn(() => options.task);
    const processWithLLM = vi.fn(async () => ({ text: 'Complex reply' }));
    const processWithVision = vi.fn(async () => ({ text: 'Image reply' }));
    const processWithOllama = vi.fn(async () => ({ text: 'Simple reply', fromOllama: true }));
    const sendMessageToChat = vi.fn(async () => undefined);
    const sendFileToChat = vi.fn(async () => ({ success: true, messageId: 'file-1' }));
    const getFile = vi.fn(async () => ({ file_path: 'photo.jpg' }));

    vi.doMock('../db', () => ({
        getRecentMessagesForSpace,
        storeMessage,
        getResident,
        getAllResidents,
        buildTelegramSpaceId,
        getActiveProjectForSpace: vi.fn(() => undefined),
        getSpace: vi.fn(() => ({
            id: 'telegram:chat-1',
            assistant_pack_id: 'jeeves',
            grounding_pack_id: 'jeeves_personal',
            channel: 'telegram',
            external_ref: 'chat-1',
        })),
        getSpaceByChannelRef: vi.fn(() => ({
            id: 'telegram:chat-1',
            assistant_pack_id: 'jeeves',
            grounding_pack_id: 'jeeves_personal',
            channel: 'telegram',
            external_ref: 'chat-1',
        })),
        getMemberEffectiveAuthority,
        listGroundingOverrides,
        getSpaceParticipants,
        logEvent,
        getTask,
        getLatestArtifactByKind: vi.fn(() => undefined),
    }));
    vi.doMock('../core/llm', () => ({ processWithLLM, processWithVision }));
    vi.doMock('../core/ollama', () => ({ processWithOllama }));
    vi.doMock('../core/local-triage', () => ({
        classifyMessageRoute: vi.fn(async (value: string) => ({
            route: value === 'Спасибо' ? 'simple' : 'complex',
            source: value === 'Спасибо' ? 'rule_simple' : 'rule_complex',
        })),
    }));
    vi.doMock('../channels/telegram', () => ({
        sendMessageToChat,
        sendFileToChat,
        bot: { telegram: { getFile, token: 'bot-token' } },
    }));
    vi.doMock('../core/memory-context', () => ({ getMemoryContext: vi.fn(() => '[MEMORY]') }));
    vi.doMock('../core/memory-sprint', () => ({
        ensureActiveMemorySprint: vi.fn(() => ({
            id: 'sprint:telegram:chat-1:2026-03-25',
            opened_at: '2026-03-25T00:00:00.000Z',
            closes_at: '2026-04-01T00:00:00.000Z',
            cadence_days: 7,
        })),
    }));
    vi.doMock('../core/brief-pages', () => ({
        BRIEF_PIN_HOURS: 24,
        shouldCreateDailyBriefPage: vi.fn((task: any) => task?.config_json?.includes('briefing_morning')),
        createBriefPage: vi.fn(() => ({
            fileName: 'brief.html',
            filePath: '/tmp/brief.html',
            url: options.briefUrl ?? null,
        })),
    }));

    global.fetch = vi.fn(async () => ({
        arrayBuffer: async () => new TextEncoder().encode('image-bytes').buffer,
    })) as any;

    const mod = await import('./butler');
    return {
        ...mod,
        mocks: { processWithLLM, processWithVision, processWithOllama, sendMessageToChat, storeMessage, getTask },
        fileMocks: { sendFileToChat },
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

describe('agents/butler', () => {
    it('routes simple messages through Ollama', async () => {
        const mod = await loadButler();
        await mod.handleButlerMessage(null, 'chat-1', '111', 'Спасибо');

        expect(mod.mocks.processWithOllama).toHaveBeenCalled();
        expect(mod.mocks.processWithLLM).not.toHaveBeenCalled();
        expect(mod.mocks.sendMessageToChat).toHaveBeenCalledWith('chat-1', 'Simple reply');
    });

    it('routes complex messages through Gemini flow', async () => {
        const mod = await loadButler();
        await mod.handleButlerMessage(null, 'chat-1', '111', 'Research the best option');

        expect(mod.mocks.processWithLLM).toHaveBeenCalled();
        expect(mod.mocks.sendMessageToChat).toHaveBeenCalledWith('chat-1', 'Complex reply');
    });

    it('suppresses task replies when the model returns the no-send sentinel', async () => {
        const mod = await loadButler();
        mod.mocks.processWithLLM.mockResolvedValueOnce({ text: '[NO_SEND]' });

        await mod.handleButlerMessage({
            channel: 'telegram',
            channelRef: 'chat-1',
            senderId: 'system_cron',
            text: '[SYSTEM TASK] Morning briefing.',
            spaceId: 'telegram:chat-1',
            taskId: 'task:telegram:chat-1:briefing_morning',
        });

        expect(mod.mocks.sendMessageToChat).not.toHaveBeenCalled();
        expect(mod.mocks.storeMessage).not.toHaveBeenCalled();
    });

    it('suppresses task replies when the model returns loose no-send wording', async () => {
        const mod = await loadButler();
        mod.mocks.processWithLLM.mockResolvedValueOnce({ text: 'no send' });

        await mod.handleButlerMessage({
            channel: 'telegram',
            channelRef: 'chat-1',
            senderId: 'system_cron',
            text: '[SYSTEM TASK] Morning briefing.',
            spaceId: 'telegram:chat-1',
            taskId: 'task:telegram:chat-1:briefing_morning',
        });

        expect(mod.mocks.sendMessageToChat).not.toHaveBeenCalled();
        expect(mod.mocks.storeMessage).not.toHaveBeenCalled();
    });

    it('does not suppress no-send sentinel text in direct user replies', async () => {
        const mod = await loadButler();
        mod.mocks.processWithLLM.mockResolvedValueOnce({ text: 'no send' });

        await mod.handleButlerMessage({
            channel: 'telegram',
            channelRef: 'chat-1',
            senderId: '111',
            text: 'Research the best option',
            spaceId: 'telegram:chat-1',
        });

        expect(mod.mocks.sendMessageToChat).toHaveBeenCalledWith('chat-1', 'no send');
        expect(mod.mocks.storeMessage).toHaveBeenCalled();
    });

    it('suppresses no-send sentinel text when the caller opts in', async () => {
        const mod = await loadButler();
        mod.mocks.processWithLLM.mockResolvedValueOnce({ text: '[NO_SEND]' });

        await mod.handleButlerMessage({
            channel: 'telegram',
            channelRef: 'partner-chat',
            senderId: '222',
            text: '@jeeves_bot окей, просто фиксирую',
            spaceId: 'telegram:partner-chat',
            suppressNoSend: true,
        });

        expect(mod.mocks.sendMessageToChat).not.toHaveBeenCalled();
        expect(mod.mocks.storeMessage).not.toHaveBeenCalled();
    });

    it('adds and pins the daily Brief link for morning briefing task replies', async () => {
        const mod = await loadButler({
            task: {
                id: 'task:telegram:chat-1:briefing_morning',
                kind: 'assistant_prompt',
                title: 'Morning briefing',
                config_json: JSON.stringify({ seeded: { template_id: 'briefing_morning' } }),
            },
            briefUrl: 'https://pipi.example/briefs/today.html',
        });

        await mod.handleButlerMessage({
            channel: 'telegram',
            channelRef: 'chat-1',
            senderId: 'system_cron',
            text: '[SYSTEM TASK] Morning briefing.',
            spaceId: 'telegram:chat-1',
            taskId: 'task:telegram:chat-1:briefing_morning',
        });

        expect(mod.mocks.sendMessageToChat).toHaveBeenCalledWith(
            'chat-1',
            'Complex reply\n\nBrief: https://pipi.example/briefs/today.html',
            {
                pin: true,
                unpinAfterHours: 24,
                pinDisableNotification: true,
            }
        );
        expect(mod.mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'Complex reply\n\nBrief: https://pipi.example/briefs/today.html',
            })
        );
    });

    it('attaches the daily Brief HTML file when no public URL is configured', async () => {
        const mod = await loadButler({
            task: {
                id: 'task:telegram:chat-1:briefing_morning',
                kind: 'assistant_prompt',
                title: 'Morning briefing',
                config_json: JSON.stringify({ seeded: { template_id: 'briefing_morning' } }),
            },
            briefUrl: null,
        });

        await mod.handleButlerMessage({
            channel: 'telegram',
            channelRef: 'chat-1',
            senderId: 'system_cron',
            text: '[SYSTEM TASK] Morning briefing.',
            spaceId: 'telegram:chat-1',
            taskId: 'task:telegram:chat-1:briefing_morning',
        });

        expect(mod.mocks.sendMessageToChat).toHaveBeenCalledWith(
            'chat-1',
            'Complex reply\n\nBrief: HTML-файл прикреплю отдельным сообщением.'
        );
        expect(mod.fileMocks.sendFileToChat).toHaveBeenCalledWith('chat-1', '/tmp/brief.html', {
            filename: 'brief.html',
            caption: 'Brief HTML',
            pin: true,
            unpinAfterHours: 24,
            pinDisableNotification: true,
        });
    });

    it('processes photos through the vision pipeline', async () => {
        const mod = await loadButler();
        const ctx = {
            message: { photo: [{ file_id: 'small' }, { file_id: 'large' }] },
        };

        await mod.handleButlerPhoto(ctx as any, 'chat-1', '111', 'What is this?');

        expect(mod.mocks.processWithVision).toHaveBeenCalled();
        expect(mod.mocks.sendMessageToChat).toHaveBeenCalledWith('chat-1', 'Image reply');
    });
});
