import { afterEach, describe, expect, it, vi } from 'vitest';

type MockContext = {
    message: any;
    chat: { id: number; type: string };
    from: { id: number; username?: string; first_name?: string };
    botInfo?: { username?: string; id?: number };
    reply: ReturnType<typeof vi.fn>;
};

async function loadRouter(options?: {
    isOwner?: boolean;
    isHouseholdChat?: boolean;
    approval?: { granted: string[]; denied: string[] };
    authorityGuard?: { allow: boolean; reason?: string };
    spacePolicyJson?: string | null;
    groupRelevant?: boolean;
}) {
    vi.resetModules();

    const storeMessage = vi.fn();
    const upsertChat = vi.fn();
    const getChat = vi.fn(() => undefined);
    const getResident = vi.fn(() => undefined);
    const getSpace = vi.fn((spaceId: string) => ({
        id: spaceId,
        policy_json: options?.spacePolicyJson ?? null,
    }));
    const upsertResident = vi.fn();
    const buildSpaceId = vi.fn((channel: string, ref: string) => `${channel}:${ref}`);
    const buildTelegramSpaceId = vi.fn((chatId: string) => `telegram:${chatId}`);
    const ensureSpace = vi.fn();
    const ensureSpaceMembership = vi.fn();
    const handleButlerMessage = vi.fn();
    const handleButlerPhoto = vi.fn();
    const buildChannelPersonId = vi.fn((channel: string, id: string) =>
        channel === 'telegram' ? id : `${channel}:${id}`
    );
    const sendChannelMessage = vi.fn();
    const evaluateAuthorityGuard = vi.fn(() => options?.authorityGuard || { allow: true });

    vi.doMock('./db', () => ({
        buildSpaceId,
        buildTelegramSpaceId,
        ensureSpace,
        ensureSpaceMembership,
        storeMessage,
        upsertChat,
        getChat,
        getResident,
        getSpace,
        upsertResident,
    }));
    vi.doMock('./agents/butler', () => ({
        handleButlerMessage,
        handleButlerPhoto,
    }));
    vi.doMock('./channels/runtime', () => ({
        buildChannelPersonId,
        sendChannelMessage,
    }));
    vi.doMock('./config', () => ({
        BOT_NAME_ALIASES: ['pipi', 'пипи', 'jeeves', 'jivs', 'дживс'],
        isHouseholdChat: vi.fn(() => options?.isHouseholdChat ?? false),
        isOwner: vi.fn(() => options?.isOwner ?? true),
    }));
    vi.doMock('./utils/approvals', () => ({
        recordApprovalResponse: vi.fn(() => options?.approval || { granted: [], denied: [] }),
    }));
    vi.doMock('./core/authority-guard', () => ({
        evaluateAuthorityGuard,
    }));
    vi.doMock('./core/local-triage', () => ({
        shouldJoinGroupConversation: vi.fn(async () => options?.groupRelevant ?? false),
    }));

    const router = await import('./router');
    return {
        handleIncomingMessage: router.handleIncomingMessage,
        handleIncomingChannelMessage: router.handleIncomingChannelMessage,
        mocks: {
            buildTelegramSpaceId,
            buildSpaceId,
            ensureSpace,
            ensureSpaceMembership,
            storeMessage,
            upsertChat,
            getChat,
            getResident,
            getSpace,
            upsertResident,
            handleButlerMessage,
            handleButlerPhoto,
            sendChannelMessage,
            evaluateAuthorityGuard,
        },
    };
}

function createContext(overrides: Partial<MockContext> = {}): MockContext {
    return {
        message: { message_id: 1, text: 'Привет' },
        chat: { id: 123, type: 'private' },
        from: { id: 111, username: 'alice', first_name: 'Alice' },
        botInfo: { username: 'jeeves_bot', id: 42 },
        reply: vi.fn(),
        ...overrides,
    };
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('router.handleIncomingMessage', () => {
    it('rejects non-owners in private chat', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({ isOwner: false });
        const ctx = createContext();

        await handleIncomingMessage(ctx as any);

        expect(ctx.reply).toHaveBeenCalledWith('Sorry. I only work with approved users.');
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
        expect(mocks.ensureSpaceMembership).toHaveBeenCalledWith('telegram:123', '111', 'member');
        expect(mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                space_id: 'telegram:123',
                sender_id: '111',
                content: '[ACCESS_DENIED_DIRECT_CONTACT]',
                is_bot: 0,
            })
        );
    });

    it('routes private owner messages to Butler and auto-registers resident/chat', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({ isOwner: true });
        const ctx = createContext({
            message: { message_id: 7, text: 'Need a plan' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.upsertChat).toHaveBeenCalled();
        expect(mocks.upsertResident).toHaveBeenCalled();
        expect(mocks.ensureSpaceMembership).toHaveBeenCalledWith('telegram:123', '111', 'owner');
        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerMessage).toHaveBeenCalledWith({
            channel: 'telegram',
            channelRef: '123',
            senderId: '111',
            text: 'Need a plan',
            spaceId: 'telegram:123',
        });
    });

    it('routes household trigger messages to Butler', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({ isOwner: true, isHouseholdChat: true });
        const ctx = createContext({
            chat: { id: 999, type: 'group' },
            message: { message_id: 2, text: 'Jeeves, help me with groceries?' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith({
            channel: 'telegram',
            channelRef: '999',
            senderId: '111',
            text: 'Jeeves, help me with groceries?',
            spaceId: 'telegram:999',
        });
    });

    it('stays passive in household groups when the local relevance gate says no', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({ isOwner: true, isHouseholdChat: true });

        for (let index = 1; index <= 5; index += 1) {
            const ctx = createContext({
                chat: { id: 999, type: 'group' },
                message: { message_id: index, text: 'ок' },
            });

            await handleIncomingMessage(ctx as any);
        }

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('joins a household group when the local relevance gate finds concrete value', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: true,
            isHouseholdChat: true,
            groupRelevant: true,
        });
        const ctx = createContext({
            chat: { id: 999, type: 'group' },
            message: { message_id: 8, text: 'The delivery deadline moved to tomorrow' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith({
            channel: 'telegram',
            channelRef: '999',
            senderId: '111',
            text: 'The delivery deadline moved to tomorrow',
            spaceId: 'telegram:999',
        });
    });

    it('applies a cooldown after a passive relevance-based group reply', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: true,
            isHouseholdChat: true,
            groupRelevant: true,
        });

        for (const [messageId, text] of [
            [18, 'The delivery deadline moved to tomorrow'],
            [19, 'The brief also changed'],
        ] as const) {
            await handleIncomingMessage(
                createContext({ chat: { id: 998, type: 'group' }, message: { message_id: messageId, text } }) as any
            );
        }

        expect(mocks.handleButlerMessage).toHaveBeenCalledTimes(1);
    });

    it('does not treat a generic group question as an explicit trigger', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({ isOwner: true, isHouseholdChat: true });
        const ctx = createContext({
            chat: { id: 999, type: 'group' },
            message: { message_id: 6, text: 'Что нового?' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('routes mentioned messages from non-owners in an attached external group', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: false,
            isHouseholdChat: false,
            spacePolicyJson: JSON.stringify({
                channel_mode: 'full',
                external_group_enabled: true,
                external_group_mode: 'mention_only',
            }),
        });
        const ctx = createContext({
            chat: { id: 777, type: 'group' },
            from: { id: 222, username: 'partner', first_name: 'Partner' },
            message: { message_id: 10, text: '@jeeves_bot напомни нам короткое саммари звонка' },
        });

        await handleIncomingMessage(ctx as any);

        expect(ctx.reply).not.toHaveBeenCalledWith('Sorry. I only work with approved users.');
        expect(mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                space_id: 'telegram:777',
                sender_id: '222',
                content: '@jeeves_bot напомни нам короткое саммари звонка',
            })
        );
        expect(mocks.handleButlerMessage).toHaveBeenCalledWith({
            channel: 'telegram',
            channelRef: '777',
            senderId: '222',
            text: '@jeeves_bot напомни нам короткое саммари звонка',
            spaceId: 'telegram:777',
            suppressNoSend: true,
        });
    });

    it('keeps attached external groups passive in mention-only mode without a direct mention', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: false,
            isHouseholdChat: false,
            spacePolicyJson: JSON.stringify({
                channel_mode: 'full',
                external_group_enabled: true,
                external_group_mode: 'mention_only',
            }),
        });
        const ctx = createContext({
            chat: { id: 777, type: 'group' },
            from: { id: 222, username: 'partner', first_name: 'Partner' },
            message: { message_id: 11, text: 'напомни нам короткое саммари звонка' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('lets attached external groups handle request triggers in auto mode', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: false,
            isHouseholdChat: false,
            spacePolicyJson: JSON.stringify({
                channel_mode: 'full',
                external_group_enabled: true,
                external_group_mode: 'auto',
            }),
        });
        const ctx = createContext({
            chat: { id: 777, type: 'group' },
            from: { id: 222, username: 'partner', first_name: 'Partner' },
            message: { message_id: 12, text: 'напомни нам короткое саммари звонка' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                channel: 'telegram',
                channelRef: '777',
                senderId: '222',
                spaceId: 'telegram:777',
                suppressNoSend: true,
            })
        );
    });

    it('routes photos to Butler photo handler', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({ isOwner: true });
        const ctx = createContext({
            message: {
                message_id: 3,
                caption: 'What is this?',
                photo: [{ file_id: 'small' }, { file_id: 'large' }],
            },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.handleButlerPhoto).toHaveBeenCalledWith(ctx, '123', '111', 'What is this?');
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('injects approval results into the routed text', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: true,
            approval: { granted: ['browse_web'], denied: [] },
        });
        const ctx = createContext({
            message: { message_id: 4, text: 'да' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                channel: 'telegram',
                channelRef: '123',
                senderId: '111',
                spaceId: 'telegram:123',
                text: expect.stringContaining('[SYSTEM] User approved sensitive actions: browse_web.'),
            })
        );
    });

    it('stores inbox-mode messages without auto-routing them to Butler', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: true,
            spacePolicyJson: JSON.stringify({ channel_mode: 'inbox' }),
        });
        const ctx = createContext({
            message: { message_id: 8, text: 'Need a plan' },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('stores inbox-mode photos without routing them to Butler', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: true,
            spacePolicyJson: JSON.stringify({ channel_mode: 'inbox' }),
        });
        const ctx = createContext({
            message: {
                message_id: 9,
                photo: [{ file_id: 'abc', file_unique_id: 'abc', width: 100, height: 100 }],
                caption: 'Look at this',
            },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerPhoto).not.toHaveBeenCalled();
    });

    it('blocks a household message when the authority guard rejects it', async () => {
        const { handleIncomingMessage, mocks } = await loadRouter({
            isOwner: true,
            isHouseholdChat: true,
            authorityGuard: { allow: false, reason: 'Need clarification first.' },
        });
        const ctx = createContext({
            chat: { id: 999, type: 'group' },
            message: {
                message_id: 5,
                text: 'Не надо, сделай иначе',
                reply_to_message: {
                    text: 'Restart it',
                    from: { id: 222, first_name: 'Bob' },
                },
            },
        });

        await handleIncomingMessage(ctx as any);

        expect(mocks.evaluateAuthorityGuard).toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith('Need clarification first.');
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });
});

describe('router.handleIncomingChannelMessage', () => {
    it('routes direct WhatsApp owner messages to Butler through the generic path', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadRouter({ isOwner: true });

        await handleIncomingChannelMessage({
            channel: 'whatsapp',
            channelRef: '+393331234567',
            senderId: '+393331234567',
            senderDisplayName: 'Alice',
            messageId: 'wamid-1',
            text: 'Need a plan',
            isDirect: true,
        });

        expect(mocks.upsertChat).not.toHaveBeenCalled();
        expect(mocks.upsertResident).toHaveBeenCalled();
        expect(mocks.ensureSpaceMembership).toHaveBeenCalledWith(
            'whatsapp:+393331234567',
            'whatsapp:+393331234567',
            'owner'
        );
        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerMessage).toHaveBeenCalledWith({
            channel: 'whatsapp',
            channelRef: '+393331234567',
            senderId: 'whatsapp:+393331234567',
            text: 'Need a plan',
            spaceId: 'whatsapp:+393331234567',
        });
    });

    it('routes primary WhatsApp group trigger messages to Butler', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadRouter({ isOwner: true });

        await handleIncomingChannelMessage({
            channel: 'whatsapp',
            channelRef: '120363022222222222@g.us',
            senderId: '+393331234567',
            senderDisplayName: 'Alice',
            messageId: 'wamid-2',
            text: 'Pipi help me with groceries',
            isDirect: false,
            isPrimaryGroup: true,
        });

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith({
            channel: 'whatsapp',
            channelRef: '120363022222222222@g.us',
            senderId: 'whatsapp:+393331234567',
            text: 'Pipi help me with groceries',
            spaceId: 'whatsapp:120363022222222222@g.us',
        });
    });

    it('stores direct channel messages in notify-only mode without routing them', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadRouter({
            isOwner: true,
            spacePolicyJson: JSON.stringify({ channel_mode: 'notify_only' }),
        });

        await handleIncomingChannelMessage({
            channel: 'whatsapp',
            channelRef: '+393331234567',
            senderId: '+393331234567',
            senderDisplayName: 'Alice',
            messageId: 'wamid-4',
            text: 'Need a plan',
            isDirect: true,
        });

        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('rejects non-owner direct WhatsApp messages via the shared channel sender', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadRouter({ isOwner: false });

        await handleIncomingChannelMessage({
            channel: 'whatsapp',
            channelRef: '+393331234567',
            senderId: '+393331234567',
            senderDisplayName: 'Alice',
            messageId: 'wamid-3',
            text: 'Hi there',
            isDirect: true,
        });

        expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
            'whatsapp',
            '+393331234567',
            'Sorry. I only work with approved users.'
        );
        expect(mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                space_id: 'whatsapp:+393331234567',
                sender_id: 'whatsapp:+393331234567',
                content: '[ACCESS_DENIED_DIRECT_CONTACT]',
                is_bot: 0,
            })
        );
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });
});
