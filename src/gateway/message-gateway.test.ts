/**
 * Routing behavior, ported from the router tests this replaces.
 *
 * Telegram cases are driven through the real normalizer so the
 * update -> IncomingMessage -> gateway seam is covered end to end, and the
 * other channels go through the compatibility bridge in router.ts. The
 * resolvers are faked here because they have their own tests against real
 * SQLite; what this file asserts is who gets answered and who does not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

type LoadOptions = {
    isOwner?: boolean;
    isHouseholdChat?: boolean;
    approval?: { granted: string[]; denied: string[] };
    authorityGuard?: { allow: boolean; reason?: string };
    spacePolicyJson?: string | null;
    channelMode?: string;
    groupRelevant?: boolean;
    duplicate?: boolean;
    resolvedImage?: { base64: string; mimeType: string } | null;
    unknownEndpoint?: boolean;
};

async function loadGateway(options: LoadOptions = {}) {
    vi.resetModules();

    const storeMessage = vi.fn(() => ({ inserted: !options.duplicate }));
    const getSpace = vi.fn((spaceId: string) => ({
        id: spaceId,
        policy_json: options.spacePolicyJson ?? null,
    }));
    const getParticipantIdentity = vi.fn(() => undefined);
    const handleButlerMessage = vi.fn();
    const handleButlerPhoto = vi.fn();
    const sendChannelMessage = vi.fn();
    const buildChannelPersonId = vi.fn((channel: string, id: string) =>
        channel === 'telegram' ? id : `${channel}:${id}`
    );
    const evaluateAuthorityGuard = vi.fn(() => options.authorityGuard || { allow: true });
    const shouldJoinGroupConversation = vi.fn(async () => options.groupRelevant ?? false);
    const resolveAttachment = vi.fn(async () =>
        options.resolvedImage === undefined ? { base64: 'AAA', mimeType: 'image/jpeg' } : options.resolvedImage
    );

    vi.doMock('../db', () => ({ storeMessage, getSpace, getParticipantIdentity }));
    vi.doMock('../agents/butler', () => ({ handleButlerMessage, handleButlerPhoto }));
    vi.doMock('../channels/runtime', () => ({ buildChannelPersonId, sendChannelMessage }));
    vi.doMock('../config', () => ({
        BOT_NAME_ALIASES: ['pipi', 'пипи', 'jeeves', 'jivs', 'дживс'],
        isHouseholdChat: vi.fn(() => options.isHouseholdChat ?? false),
        isOwner: vi.fn(() => options.isOwner ?? true),
    }));
    vi.doMock('../utils/approvals', () => ({
        recordApprovalResponse: vi.fn(() => options.approval || { granted: [], denied: [] }),
    }));
    vi.doMock('../core/authority-guard', () => ({ evaluateAuthorityGuard }));
    vi.doMock('../core/local-triage', () => ({ shouldJoinGroupConversation }));
    vi.doMock('../core/space-preferences', () => ({
        resolveSpaceOperationalSettings: vi.fn(() => ({ channel_mode: options.channelMode ?? 'full' })),
        parseSpacePolicyRecord: vi.fn((raw: string | null) => (raw ? JSON.parse(raw) : {})),
    }));
    const resolveTransportBinding = vi.fn((message: any, resolveOptions?: { allowBootstrap?: boolean }) => {
        // Mirrors the real resolver: an unknown endpoint yields a space only
        // when the caller permits bootstrapping.
        if (options.unknownEndpoint && resolveOptions?.allowBootstrap === false) {
            return { binding: null, space: null, source: 'none' };
        }
        return {
            binding: null,
            space: { id: `${message.transport}:${message.endpoint.id}`, policy_json: options.spacePolicyJson ?? null },
            source: options.unknownEndpoint ? 'bootstrapped' : 'binding',
        };
    });
    vi.doMock('./binding-resolver', () => ({ resolveTransportBinding }));
    vi.doMock('./participant-resolver', () => ({
        resolveParticipant: vi.fn((message: any) => ({
            participantId: buildChannelPersonId(message.transport, message.sender.transportUserId),
            participant: undefined,
            identity: {},
            membership: { role: 'owner' },
            created: false,
        })),
    }));
    vi.doMock('../transports/registry', () => ({
        getTransport: vi.fn(() => ({ resolveAttachment })),
    }));

    const gateway = await import('./message-gateway');
    const participation = await import('./participation');
    const { normalizeTelegramMessage } = await import('../transports/telegram/normalizer');
    const router = await import('../router');
    participation.resetPassiveGroupCooldowns();

    return {
        handleIncoming: gateway.handleIncoming,
        handleIncomingChannelMessage: router.handleIncomingChannelMessage,
        normalizeTelegramMessage,
        mocks: {
            storeMessage,
            getSpace,
            handleButlerMessage,
            handleButlerPhoto,
            sendChannelMessage,
            evaluateAuthorityGuard,
            shouldJoinGroupConversation,
            resolveAttachment,
            resolveTransportBinding,
        },
    };
}

/**
 * Overrides replace their part wholesale. Merging would leave the default
 * `text` on a photo-only fixture, and the caption path would never be tested.
 */
function telegramUpdate(overrides: Record<string, any> = {}) {
    return {
        message: overrides.message ?? { message_id: 1, date: 1_760_000_000, text: 'Привет' },
        chat: overrides.chat ?? { id: 123, type: 'private' },
        from: overrides.from ?? { id: 111, username: 'alice', first_name: 'Alice' },
        bot: { username: 'jeeves_bot', id: 42 },
    };
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

describe('gateway: direct chats', () => {
    it('rejects non-owners in private chat', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ isOwner: false });

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
        expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
            'telegram',
            '123',
            'Sorry. I only work with approved users.'
        );
        expect(mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({ content: '[ACCESS_DENIED_DIRECT_CONTACT]' })
        );
    });

    it('routes private owner messages to the assistant', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway();

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'telegram', channelRef: '123', senderId: '111', text: 'Привет' })
        );
    });

    it('stores the message against the space it resolved to', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway();

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        expect(mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'telegram:123:1',
                space_id: 'telegram:123',
                transport: 'telegram',
                transport_message_id: '1',
                is_bot: 0,
            })
        );
    });

    it('injects approval results into the routed text', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            approval: { granted: ['shell'], denied: [] },
        });

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                text: expect.stringContaining('[SYSTEM] User approved sensitive actions: shell'),
            })
        );
    });

    it('injects reply context into the routed text', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway();

        await handleIncoming(
            normalizeTelegramMessage(
                telegramUpdate({
                    message: {
                        message_id: 1,
                        date: 1_760_000_000,
                        text: 'agreed',
                        reply_to_message: { message_id: 0, text: 'the plan', from: { id: 555, first_name: 'Sam' } },
                    },
                })
            )!
        );

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith(
            expect.objectContaining({ text: expect.stringContaining('[Replying to Sam: "the plan"]') })
        );
    });
});

describe('gateway: space creation', () => {
    it('does not let a stranger in an unknown group create a space', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isOwner: false,
            unknownEndpoint: true,
        });

        await handleIncoming(
            normalizeTelegramMessage(
                telegramUpdate({
                    message: { message_id: 1, date: 1_760_000_000, text: 'привет' },
                    chat: { id: 700, type: 'supergroup' },
                })
            )!
        );

        // Bootstrapping is a write. Looking up costs nothing; creating rows on
        // behalf of anyone who talks to the bot does.
        expect(mocks.resolveTransportBinding).toHaveBeenCalledTimes(1);
        expect(mocks.resolveTransportBinding).toHaveBeenCalledWith(expect.anything(), { allowBootstrap: false });
        expect(mocks.storeMessage).not.toHaveBeenCalled();
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('connects an unknown group when an owner speaks in it', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isHouseholdChat: true,
            unknownEndpoint: true,
        });

        await handleIncoming(
            normalizeTelegramMessage(
                telegramUpdate({
                    message: { message_id: 1, date: 1_760_000_000, text: 'Помоги найти документ' },
                    chat: { id: 700, type: 'supergroup' },
                })
            )!
        );

        expect(mocks.resolveTransportBinding).toHaveBeenCalledTimes(2);
        expect(mocks.handleButlerMessage).toHaveBeenCalled();
    });

    it('still registers a direct chat so a refusal can be recorded', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isOwner: false,
            unknownEndpoint: true,
        });

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        expect(mocks.storeMessage).toHaveBeenCalledWith(
            expect.objectContaining({ content: '[ACCESS_DENIED_DIRECT_CONTACT]' })
        );
    });
});

describe('gateway: deduplication', () => {
    it('runs the assistant once when a transport redelivers the same update', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ duplicate: true });

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        // The insert reported the id was already stored, so this is a replay:
        // answering again would say the same thing twice.
        expect(mocks.storeMessage).toHaveBeenCalledTimes(1);
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });
});

describe('gateway: household groups', () => {
    const householdUpdate = (text: string) =>
        telegramUpdate({
            message: { message_id: 1, date: 1_760_000_000, text },
            chat: { id: 123, type: 'supergroup' },
        });

    it('routes trigger messages to the assistant', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ isHouseholdChat: true });

        await handleIncoming(normalizeTelegramMessage(householdUpdate('Помоги найти документ'))!);

        expect(mocks.handleButlerMessage).toHaveBeenCalled();
    });

    it('stays passive when the local relevance gate says no', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isHouseholdChat: true,
            groupRelevant: false,
        });

        await handleIncoming(normalizeTelegramMessage(householdUpdate('обычная болтовня'))!);

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
        // It still remembers what was said, it just does not speak.
        expect(mocks.storeMessage).toHaveBeenCalled();
    });

    it('joins when the local relevance gate finds concrete value', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isHouseholdChat: true,
            groupRelevant: true,
        });

        await handleIncoming(normalizeTelegramMessage(householdUpdate('обычная болтовня'))!);

        expect(mocks.handleButlerMessage).toHaveBeenCalled();
    });

    it('applies a cooldown after a passive relevance-based reply', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isHouseholdChat: true,
            groupRelevant: true,
        });

        await handleIncoming(normalizeTelegramMessage(householdUpdate('первая болтовня'))!);
        await handleIncoming(
            normalizeTelegramMessage(
                telegramUpdate({
                    message: { message_id: 2, date: 1_760_000_000, text: 'вторая болтовня' },
                    chat: { id: 123, type: 'supergroup' },
                })
            )!
        );

        expect(mocks.handleButlerMessage).toHaveBeenCalledTimes(1);
    });

    it('answers when addressed even while the relevance gate is cold', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isHouseholdChat: true,
            groupRelevant: false,
        });

        await handleIncoming(normalizeTelegramMessage(householdUpdate('@jeeves_bot что там'))!);

        expect(mocks.handleButlerMessage).toHaveBeenCalled();
    });

    it('blocks a message the authority guard rejects', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isHouseholdChat: true,
            authorityGuard: { allow: false, reason: 'Not your call.' },
        });

        await handleIncoming(normalizeTelegramMessage(householdUpdate('Помоги'))!);

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
        expect(mocks.sendChannelMessage).toHaveBeenCalledWith('telegram', '123', 'Not your call.');
    });
});

describe('gateway: external groups', () => {
    const externalPolicy = JSON.stringify({ external_group_enabled: true, external_group_mode: 'mention_only' });
    const autoPolicy = JSON.stringify({ external_group_enabled: true, external_group_mode: 'auto' });

    const externalUpdate = (text: string) =>
        telegramUpdate({
            message: { message_id: 1, date: 1_760_000_000, text },
            chat: { id: 500, type: 'supergroup' },
        });

    it('answers a mention from a non-owner', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isOwner: false,
            spacePolicyJson: externalPolicy,
        });

        await handleIncoming(normalizeTelegramMessage(externalUpdate('@jeeves_bot помоги'))!);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith(expect.objectContaining({ suppressNoSend: true }));
    });

    it('stays quiet in mention-only mode without a mention', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isOwner: false,
            spacePolicyJson: externalPolicy,
            groupRelevant: true,
        });

        await handleIncoming(normalizeTelegramMessage(externalUpdate('помоги найти документ'))!);

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('handles request triggers in auto mode', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isOwner: false,
            spacePolicyJson: autoPolicy,
        });

        await handleIncoming(normalizeTelegramMessage(externalUpdate('помоги найти документ'))!);

        expect(mocks.handleButlerMessage).toHaveBeenCalled();
    });

    it('still refuses a non-owner in a group that was never attached', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ isOwner: false });

        await handleIncoming(normalizeTelegramMessage(externalUpdate('@jeeves_bot помоги'))!);

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });
});

describe('gateway: photos', () => {
    const photoUpdate = (chat: Record<string, unknown> = { id: 123, type: 'private' }) =>
        telegramUpdate({
            message: {
                message_id: 1,
                date: 1_760_000_000,
                caption: 'What is this?',
                photo: [
                    { file_id: 'small', file_unique_id: 'u1' },
                    { file_id: 'large', file_unique_id: 'u2' },
                ],
            },
            chat,
        });

    it('routes a photo to the vision path with bytes the transport resolved', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway();

        await handleIncoming(normalizeTelegramMessage(photoUpdate())!);

        expect(mocks.handleButlerPhoto).toHaveBeenCalledWith(
            expect.objectContaining({
                channel: 'telegram',
                channelRef: '123',
                caption: 'What is this?',
                image: { base64: 'AAA', mimeType: 'image/jpeg' },
            })
        );
        expect(mocks.storeMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '[PHOTO] What is this?' }));
    });

    it('does not download an attachment for a sender it refuses', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ isOwner: false });

        await handleIncoming(normalizeTelegramMessage(photoUpdate())!);

        // Fetching first would let anyone make the assistant pull files.
        expect(mocks.resolveAttachment).not.toHaveBeenCalled();
        expect(mocks.handleButlerPhoto).not.toHaveBeenCalled();
    });

    it('gives up quietly when the transport cannot resolve the attachment', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ resolvedImage: null });

        await handleIncoming(normalizeTelegramMessage(photoUpdate())!);

        expect(mocks.handleButlerPhoto).not.toHaveBeenCalled();
    });

    it('refuses a photo from a non-owner even in an attached external group', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({
            isOwner: false,
            spacePolicyJson: JSON.stringify({ external_group_enabled: true, external_group_mode: 'auto' }),
        });

        await handleIncoming(normalizeTelegramMessage(photoUpdate({ id: 500, type: 'supergroup' }))!);

        // Text from strangers is fine in a group the operator attached on
        // purpose. Vision is the priciest call the assistant makes, and has
        // always needed an owner on every surface.
        expect(mocks.resolveAttachment).not.toHaveBeenCalled();
        expect(mocks.handleButlerPhoto).not.toHaveBeenCalled();
    });

    it('ignores a photo in a group the assistant does not take part in', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ isHouseholdChat: false });

        await handleIncoming(normalizeTelegramMessage(photoUpdate({ id: 500, type: 'supergroup' }))!);

        expect(mocks.handleButlerPhoto).not.toHaveBeenCalled();
    });
});

describe('gateway: channel modes', () => {
    it('stores inbox-mode messages without answering them', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ channelMode: 'inbox' });

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('stores inbox-mode photos without running vision', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ channelMode: 'inbox' });

        await handleIncoming(
            normalizeTelegramMessage(
                telegramUpdate({
                    message: {
                        message_id: 1,
                        date: 1_760_000_000,
                        caption: 'look',
                        photo: [{ file_id: 'large', file_unique_id: 'u2' }],
                    },
                })
            )!
        );

        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerPhoto).not.toHaveBeenCalled();
    });

    it('stores notify-only messages without answering them', async () => {
        const { handleIncoming, normalizeTelegramMessage, mocks } = await loadGateway({ channelMode: 'notify_only' });

        await handleIncoming(normalizeTelegramMessage(telegramUpdate())!);

        expect(mocks.storeMessage).toHaveBeenCalled();
        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });
});

describe('gateway: other channels through the compatibility bridge', () => {
    const whatsappMessage = (overrides: Record<string, unknown> = {}) => ({
        channel: 'whatsapp',
        channelRef: '3931234@s.whatsapp.net',
        senderId: '3931234',
        senderUsername: null,
        senderDisplayName: 'Alex',
        messageId: 'wa-1',
        text: 'Привет',
        isDirect: true,
        ...overrides,
    });

    it('routes direct owner messages to the assistant', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadGateway();

        await handleIncomingChannelMessage(whatsappMessage() as any);

        expect(mocks.handleButlerMessage).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'whatsapp', senderId: 'whatsapp:3931234' })
        );
    });

    it('refuses a non-owner through the shared sender', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadGateway({ isOwner: false });

        await handleIncomingChannelMessage(whatsappMessage() as any);

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
        expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
            'whatsapp',
            '3931234@s.whatsapp.net',
            'Sorry. I only work with approved users.'
        );
    });

    it('answers a trigger in the channel it declares as its primary group', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadGateway();

        await handleIncomingChannelMessage(
            whatsappMessage({
                channelRef: '12036@g.us',
                isDirect: false,
                isPrimaryGroup: true,
                text: 'Помоги найти документ',
            }) as any
        );

        expect(mocks.handleButlerMessage).toHaveBeenCalled();
    });

    it('ignores a group the channel does not declare as primary', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadGateway();

        await handleIncomingChannelMessage(
            whatsappMessage({
                channelRef: '999@g.us',
                isDirect: false,
                isPrimaryGroup: false,
                text: 'Помоги найти документ',
            }) as any
        );

        expect(mocks.handleButlerMessage).not.toHaveBeenCalled();
    });

    it('prefers an in-place reply for a refusal when the channel offers one', async () => {
        const { handleIncomingChannelMessage, mocks } = await loadGateway({ isOwner: false });
        const respond = vi.fn();

        await handleIncomingChannelMessage(whatsappMessage({ respond }) as any);

        expect(respond).toHaveBeenCalledWith('Sorry. I only work with approved users.');
        expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
    });
});
