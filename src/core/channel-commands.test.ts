import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadChannelCommands(options?: {
    isOwner?: boolean;
    recentMessages?: any[];
    spacePolicyJson?: string | null;
}) {
    vi.resetModules();

    const ensureSpace = vi.fn();
    const ensureSpaceMembership = vi.fn();
    const getSpace = vi.fn((spaceId: string) => ({
        id: spaceId,
        policy_json: options?.spacePolicyJson ?? null,
    }));
    const getSpaceGroundingLevel = vi.fn(() => 1);
    const getResident = vi.fn(() => undefined);
    const upsertResident = vi.fn();
    const updateSpacePolicy = vi.fn();
    const getDailyTokenCost = vi.fn(() => ({
        input_tokens: 1234,
        output_tokens: 567,
        cost_usd: 0.42,
        calls: 3,
    }));
    const getRecentMessagesForSpace = vi.fn(() => options?.recentMessages || []);
    const clearMessagesForSpace = vi.fn();
    const storeMessage = vi.fn();
    const rememberWorkMemory = vi.fn();
    const runJeevesMvpActionForSpace = vi.fn(async () => 'A compact Jeeves note.');
    const runWorkLensForSpace = vi.fn(async ({ lens }: { lens: string }) => `${lens} lens output`);
    const createHandoffArtifactForSpace = vi.fn(() => ({ ref: '# Handoff\n\nGenerated now.' }));
    const resumeFromHandoffForSpace = vi.fn(() => ({ ref: '# Handoff\n\nFrom latest artifact.' }));
    const applyJeevesDefaultsForSpace = vi.fn(async () => 'Jeeves defaults are active.');
    const getJeevesMvpStatusForSpace = vi.fn(() => 'PA Jeeves MVP');
    const processWithOllama = vi.fn(async () => ({ text: 'A short archived summary.' }));
    const getHealthState = vi.fn(() => ({
        gemini: true,
        ollama: true,
        internet: true,
        killswitch: false,
        throttle_ok: true,
        sdcard_ok: true,
    }));
    const getSystemMetrics = vi.fn(() => ({
        tempC: 51.2,
        ramUsedMB: 512,
        ramTotalMB: 2048,
        ramPercent: 25,
        swapUsedMB: 0,
        swapTotalMB: 0,
        diskPercent: 31,
        uptime: '2h',
    }));
    const journalView = vi.fn(async ({ range }: { range: string }) => `[TOOL_RESULT] Journal ${range}`);
    const onboardingStatus = vi.fn(async () => '[TOOL_RESULT] Onboarding status summary');
    const onboardingFinish = vi.fn(async () => '[TOOL_RESULT] Onboarding finished');

    vi.doMock('../db', () => ({
        buildSpaceId: vi.fn((channel: string, ref: string) => `${channel}:${ref}`),
        ensureSpace,
        ensureSpaceMembership,
        getSpace,
        getSpaceGroundingLevel,
        getResident,
        upsertResident,
        updateSpacePolicy,
        getDailyTokenCost,
        getRecentMessagesForSpace,
        clearMessagesForSpace,
        storeMessage,
    }));
    vi.doMock('../config', () => ({
        BOT_DISPLAY_NAME: 'PiPi',
        RUNTIME_PLATFORM: 'generic',
        isOwner: vi.fn(() => options?.isOwner ?? true),
    }));
    vi.doMock('./memory-write', () => ({
        rememberWorkMemory,
    }));
    vi.doMock('./jeeves-mvp', () => ({
        runJeevesMvpActionForSpace,
        applyJeevesDefaultsForSpace,
        getJeevesMvpStatusForSpace,
    }));
    vi.doMock('./work-lenses', () => ({
        runWorkLensForSpace,
    }));
    vi.doMock('./handoff', () => ({
        createHandoffArtifactForSpace,
        resumeFromHandoffForSpace,
    }));
    vi.doMock('./ollama', () => ({
        processWithOllama,
    }));
    vi.doMock('./healthcheck', () => ({
        getHealthState,
        getSystemMetrics,
    }));
    vi.doMock('../channels/runtime', () => ({
        buildChannelPersonId: vi.fn((channel: string, senderId: string) =>
            channel === 'telegram' ? senderId : `${channel}:${senderId}`
        ),
    }));
    vi.doMock('../skills/_registry', () => ({
        getRegisteredHandlers: () => ({
            journal_view: journalView,
            onboarding_status: onboardingStatus,
            onboarding_finish: onboardingFinish,
        }),
    }));

    const mod = await import('./channel-commands');
    return {
        executeChannelCommand: mod.executeChannelCommand,
        parseChannelCommand: mod.parseChannelCommand,
        mocks: {
            ensureSpace,
            ensureSpaceMembership,
            getSpace,
            getSpaceGroundingLevel,
            getResident,
            upsertResident,
            updateSpacePolicy,
            getDailyTokenCost,
            getRecentMessagesForSpace,
            clearMessagesForSpace,
            storeMessage,
            rememberWorkMemory,
            runJeevesMvpActionForSpace,
            runWorkLensForSpace,
            createHandoffArtifactForSpace,
            resumeFromHandoffForSpace,
            applyJeevesDefaultsForSpace,
            getJeevesMvpStatusForSpace,
            processWithOllama,
            getHealthState,
            getSystemMetrics,
            journalView,
            onboardingStatus,
            onboardingFinish,
        },
    };
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('core/channel-commands', () => {
    it('parses slash commands and strips bot suffixes', async () => {
        const { parseChannelCommand } = await loadChannelCommands();

        expect(parseChannelCommand('/brief')).toEqual({ name: 'brief', argsText: '' });
        expect(parseChannelCommand('/jeeves@pipi_bot setup')).toEqual({ name: 'jeeves', argsText: 'setup' });
        expect(parseChannelCommand('hello')).toBeNull();
    });

    it('runs /brief against the generic Jeeves action path', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const reply = vi.fn(async () => undefined);
        const sendTyping = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/brief',
            reply,
            sendTyping,
        });

        expect(handled).toBe(true);
        expect(sendTyping).toHaveBeenCalledTimes(1);
        expect(mocks.ensureSpaceMembership).toHaveBeenCalledWith('discord:chan-1', 'discord:user-1', 'owner');
        expect(mocks.runJeevesMvpActionForSpace).toHaveBeenCalledWith({
            spaceId: 'discord:chan-1',
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'discord:user-1',
            action: 'brief',
        });
        expect(reply).toHaveBeenCalledWith('A compact Jeeves note.');
    });

    it('returns a short help reply for unknown slash commands', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const reply = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            isDirect: true,
            rawText: '/foo',
            reply,
        });

        expect(handled).toBe(true);
        expect(reply).toHaveBeenCalledWith(expect.stringContaining('/help'));
        expect(mocks.runJeevesMvpActionForSpace).not.toHaveBeenCalled();
    });

    it('records denied direct command contacts without storing the private command text', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands({ isOwner: false });
        const reply = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'telegram',
            channelRef: '222',
            senderId: '222',
            senderUsername: 'kristina',
            senderDisplayName: 'Kristina',
            isDirect: true,
            rawText: '/start',
            reply,
        });

        expect(handled).toBe(true);
        expect(mocks.ensureSpaceMembership).toHaveBeenCalledWith('telegram:222', '222', 'member');
        expect(mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                space_id: 'telegram:222',
                sender_id: '222',
                content: '[ACCESS_DENIED_DIRECT_CONTACT]',
                is_bot: 0,
            })
        );
        expect(reply).toHaveBeenCalledWith('Sorry. I only work with approved users.');
    });

    it('archives and clears the current space on /clear', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands({
            recentMessages: [
                { is_bot: 0, content: 'One' },
                { is_bot: 0, content: 'Two' },
                { is_bot: 1, content: 'Three' },
                { is_bot: 0, content: 'Four' },
                { is_bot: 1, content: 'Five' },
            ],
        });
        const reply = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            isDirect: true,
            rawText: '/clear',
            reply,
        });

        expect(handled).toBe(true);
        expect(mocks.processWithOllama).toHaveBeenCalledTimes(1);
        expect(mocks.rememberWorkMemory).toHaveBeenCalledWith(
            'discord:chan-1',
            'recollection',
            expect.stringContaining('Conversation archive before clear'),
            { salience: 0.55, source: 'chat_clear' }
        );
        expect(mocks.clearMessagesForSpace).toHaveBeenCalledWith('discord:chan-1');
        expect(reply).toHaveBeenCalledWith('Saving a short summary of the conversation...');
        expect(reply).toHaveBeenCalledWith('Context cleared. We begin again with a clean slate.');
    });

    it('routes /today into the journal view path', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const reply = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/today',
            reply,
        });

        expect(handled).toBe(true);
        expect(mocks.journalView).toHaveBeenCalledWith(
            { range: 'today' },
            expect.objectContaining({
                spaceId: 'discord:chan-1',
                userId: 'discord:user-1',
                channel: 'discord',
                channelRef: 'chan-1',
            })
        );
        expect(reply).toHaveBeenCalledWith('Journal today');
    });

    it('shows the setup prompt on /start for new spaces', async () => {
        const { executeChannelCommand } = await loadChannelCommands({
            spacePolicyJson: JSON.stringify({ onboarding_state: 'new' }),
        });
        const reply = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'telegram',
            channelRef: 'chat-1',
            senderId: 'user-1',
            isDirect: true,
            rawText: '/start',
            reply,
        });

        expect(handled).toBe(true);
        expect(reply).toHaveBeenCalledWith(expect.stringContaining('/setup'));
        expect(reply).toHaveBeenCalledWith(expect.stringContaining('/help'));
        expect(reply).toHaveBeenCalledWith(expect.stringContaining('Tell me what this chat is for'));
    });

    it('treats /jeeves setup as a backward-compatible setup alias', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const reply = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/jeeves setup',
            reply,
        });

        expect(handled).toBe(true);
        expect(mocks.applyJeevesDefaultsForSpace).toHaveBeenCalledWith('discord:chan-1');
        expect(mocks.updateSpacePolicy).toHaveBeenCalledWith('discord:chan-1', {
            onboarding_state: 'active',
            setup_version: 1,
        });
    });

    it('routes /review into the Jeeves action path', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const reply = vi.fn(async () => undefined);
        const sendTyping = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/review check the recent work',
            reply,
            sendTyping,
        });

        expect(handled).toBe(true);
        expect(sendTyping).toHaveBeenCalledTimes(1);
        expect(mocks.runJeevesMvpActionForSpace).toHaveBeenCalledWith({
            spaceId: 'discord:chan-1',
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'discord:user-1',
            action: 'review',
        });
        expect(reply).toHaveBeenCalledWith('A compact Jeeves note.');
    });

    it('routes /audit into the one-shot structured review lens path', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const reply = vi.fn(async () => undefined);
        const sendTyping = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/audit check the recent work',
            reply,
            sendTyping,
        });

        expect(handled).toBe(true);
        expect(sendTyping).toHaveBeenCalledTimes(1);
        expect(mocks.runWorkLensForSpace).toHaveBeenCalledWith({
            spaceId: 'discord:chan-1',
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'discord:user-1',
            lens: 'review',
            requestText: 'check the recent work',
        });
        expect(reply).toHaveBeenCalledWith('review lens output');
    });

    it('routes /handoff and /resume into the handoff path', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const handoffReply = vi.fn(async () => undefined);
        const resumeReply = vi.fn(async () => undefined);

        await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/handoff',
            reply: handoffReply,
        });
        await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/resume',
            reply: resumeReply,
        });

        expect(mocks.createHandoffArtifactForSpace).toHaveBeenCalledWith('discord:chan-1');
        expect(mocks.resumeFromHandoffForSpace).toHaveBeenCalledWith('discord:chan-1');
        expect(handoffReply).toHaveBeenCalledWith('# Handoff\n\nGenerated now.');
        expect(resumeReply).toHaveBeenCalledWith('# Handoff\n\nFrom latest artifact.');
    });

    it('routes /onboarding_status into the onboarding skill handler', async () => {
        const { executeChannelCommand, mocks } = await loadChannelCommands();
        const reply = vi.fn(async () => undefined);

        const handled = await executeChannelCommand({
            channel: 'discord',
            channelRef: 'chan-1',
            senderId: 'user-1',
            senderUsername: 'alice',
            senderDisplayName: 'Alice',
            isDirect: true,
            rawText: '/onboarding_status',
            reply,
        });

        expect(handled).toBe(true);
        expect(mocks.onboardingStatus).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                spaceId: 'discord:chan-1',
                userId: 'discord:user-1',
                channel: 'discord',
                channelRef: 'chan-1',
            })
        );
        expect(reply).toHaveBeenCalledWith('Onboarding status summary');
    });
});
