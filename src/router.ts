import { SpanKind } from '@opentelemetry/api';
import { Context } from 'telegraf';
import {
    buildSpaceId,
    ensureSpace,
    ensureSpaceMembership,
    getChat,
    getResident,
    getSpace,
    storeMessage,
    upsertChat,
    upsertResident,
} from './db';
import { handleButlerMessage, handleButlerPhoto } from './agents/butler';
import { isHouseholdChat, isOwner } from './config';
import { buildChannelPersonId, IncomingChannelMessage, sendChannelMessage } from './channels/runtime';
import { recordApprovalResponse } from './utils/approvals';
import { logInfo, logWarn, summarizeText } from './utils/logging';
import { evaluateAuthorityGuard } from './core/authority-guard';
import { addSpanAttributes, addSpanEvent, recordInboundMessage, withSpan } from './observability';
import { parseSpacePolicyRecord, resolveSpaceOperationalSettings } from './core/space-preferences';

const groupMessageCounters: Record<string, number> = {};
const GROUP_NAME_TRIGGER_PATTERN = /(скрепыш|срепи|skrepysh|screpy|srepi|jeeves|jivs|дживс|пипи|pipi)/i;
const GROUP_REQUEST_TRIGGER_PATTERN =
    /(help|помоги|подскажи|расскажи|найди|compare|сравни|search|research|plan|спланируй|remind|напомни|todo|задач|remember this|remember|запомни|schedule|расписани|organize|организуй|write|напиши|draft|черновик|summarize|резюм|summary)/i;
const EXTERNAL_GROUP_MODES = new Set(['mention_only', 'auto']);

type TelegramSender = {
    id?: number | string;
    username?: string | null;
    first_name?: string | null;
    is_bot?: boolean;
};

type TelegramReplyMessage = {
    from?: TelegramSender;
    text?: string;
    caption?: string;
};

type TelegramTextCarrier = {
    text?: string;
    caption?: string;
};

type TelegramInboundMessage = {
    message_id: number | string;
    text?: string;
    caption?: string;
    photo?: unknown[];
    reply_to_message?: TelegramReplyMessage;
};

type InboundIdentity = {
    channel: string;
    channelRef: string;
    channelTitle?: string | null;
    spaceId: string;
    personId: string;
    senderId: string;
    senderUsername?: string | null;
    senderDisplayName?: string | null;
    isDirect: boolean;
};

/** Detect messages that express emotion, mood, or personal context worth noticing */
function isEmotionalOrPersonal(text: string): boolean {
    const t = text.toLowerCase();
    // Mood / feelings / state
    if (
        /(устал|вымотал|выдохся|нет сил|задолбал|бесит|злюсь|грустн|тоскл|скучн|одинок|тревожн|стресс|паник|нервнич|расстроен|обидн|раздража|не могу больше|сил нет|хреново|плохо себя|болит|заболе|температур|простуд|голова раскал|мигрень|тошнит)/i.test(
            t
        )
    )
        return true;
    // Excitement / celebration
    if (
        /(ура!|получилось|наконец-то|вау|офигеть|круто!|победа|сдал|прошёл|прошел|повысил|приняли|оффер|предложили работу)/i.test(
            t
        )
    )
        return true;
    // Life events
    if (
        /(приехал|уехал|улетаю|вернулся|вернулась|гости придут|гости приед|день рождения|годовщин|юбилей|свадьб|новоселье)/i.test(
            t
        )
    )
        return true;
    // Asking for comfort / help
    if (/(обними|поддержи|что делать|как быть|не знаю что|посоветуй|помоги разобраться)/i.test(t)) return true;
    return false;
}

/**
 * Keep inbound chat/person bootstrapping identical for text and media so every
 * path stores the same baseline records before the assistant reasons about them.
 */
function ensureInboundIdentity(identity: InboundIdentity): void {
    if (identity.channel === 'telegram' && !getChat(identity.channelRef)) {
        upsertChat({
            jid: identity.channelRef,
            type: identity.isDirect ? 'private' : 'household_group',
            status: 'ACTIVE',
        });
    }

    const owner = isOwner(identity.senderId, identity.channel);
    let resident = getResident(identity.personId);
    if (!resident) {
        upsertResident({
            tg_id: identity.personId,
            username: identity.senderUsername || null,
            display_name: identity.senderDisplayName || null,
            role: owner ? 'owner' : 'member',
        });
        resident = getResident(identity.personId);
    }

    ensureSpace(identity.channel, identity.channelRef, {
        kind: identity.isDirect ? 'direct_chat' : 'group_chat',
        title: identity.channelTitle || identity.channelRef,
    });
    ensureSpaceMembership(identity.spaceId, identity.personId, resident?.role || (owner ? 'owner' : 'member'));
}

function readTelegramMessageText(message: TelegramTextCarrier): string {
    return message.text || message.caption || '';
}

function buildTelegramReplyContext(message: TelegramInboundMessage): IncomingChannelMessage['replyTo'] | undefined {
    const replyTo = message.reply_to_message;
    if (!replyTo) return undefined;

    return {
        senderId: replyTo.from?.id?.toString(),
        senderUsername: replyTo.from?.username || null,
        senderDisplayName: replyTo.from?.first_name || replyTo.from?.username || null,
        isBot: !!replyTo.from?.is_bot,
        text: readTelegramMessageText(replyTo),
    };
}

function hasPrimaryGroupTrigger(text: string): boolean {
    return GROUP_NAME_TRIGGER_PATTERN.test(text) || GROUP_REQUEST_TRIGGER_PATTERN.test(text);
}

function isExternalGroupEnabled(rawPolicy: string | null | undefined): boolean {
    return parseSpacePolicyRecord(rawPolicy).external_group_enabled === true;
}

function resolveExternalGroupMode(rawPolicy: string | null | undefined): 'mention_only' | 'auto' {
    const value = parseSpacePolicyRecord(rawPolicy).external_group_mode;
    return typeof value === 'string' && EXTERNAL_GROUP_MODES.has(value)
        ? (value as 'mention_only' | 'auto')
        : 'mention_only';
}

function injectReplyContext(text: string, replyTo?: IncomingChannelMessage['replyTo']): string {
    if (!replyTo?.text) return text;

    const replyAuthor = replyTo.senderDisplayName || replyTo.senderUsername || 'Someone';
    const snippet = replyTo.text.length > 150 ? `${replyTo.text.substring(0, 150)}...` : replyTo.text;
    logInfo('ROUTER', 'reply_context_injected', {
        reply_author_present: Boolean(replyAuthor),
        ...summarizeText(replyTo.text),
    });
    return `[Replying to ${replyAuthor}: "${snippet}"]\n${text}`;
}

/**
 * Persist approval decisions as transcript context, so later turns can see the
 * user intent without re-checking ephemeral approval state.
 */
function injectApprovalContext(spaceId: string, channelRef: string, personId: string, text: string): string {
    const approval = recordApprovalResponse({ spaceId, chatId: channelRef, userId: personId }, text);
    if (approval.granted.length > 0) {
        return `[SYSTEM] User approved sensitive actions: ${approval.granted.join(', ')}.\n${text}`;
    }
    if (approval.denied.length > 0) {
        return `[SYSTEM] User denied sensitive actions: ${approval.denied.join(', ')}.\n${text}`;
    }
    return text;
}

function consumePassiveGroupTurn(channelRef: string): boolean {
    groupMessageCounters[channelRef] = (groupMessageCounters[channelRef] || 0) + 1;
    const isPassiveTurn = groupMessageCounters[channelRef] >= 5;
    if (isPassiveTurn) {
        groupMessageCounters[channelRef] = 0;
    }
    return isPassiveTurn;
}

/**
 * Group chats stay mostly passive: answer on explicit invitations, obvious
 * requests, emotionally salient messages, or every few turns to stay present.
 */
function shouldHandlePrimaryGroupMessage(
    message: IncomingChannelMessage,
    options?: { allowRequestTriggers?: boolean; allowPassiveTurns?: boolean }
): boolean {
    const lowerText = message.text.toLowerCase();
    const isMentioned = message.botUsername ? lowerText.includes(`@${message.botUsername.toLowerCase()}`) : false;
    const isReplyToBot = !!(
        message.replyTo &&
        (message.replyTo.senderUsername === message.botUsername ||
            message.replyTo.senderId === message.botUserId ||
            message.replyTo.isBot)
    );
    const hasTrigger = options?.allowRequestTriggers === false ? false : hasPrimaryGroupTrigger(message.text);
    const isEmotional = isEmotionalOrPersonal(message.text);
    const isPassiveTurn = options?.allowPassiveTurns === false ? false : consumePassiveGroupTurn(message.channelRef);

    return isMentioned || isReplyToBot || hasTrigger || isEmotional || isPassiveTurn;
}

export async function handleIncomingMessage(ctx: Context) {
    const message = ctx.message;
    if (!message) return;
    const inboundMessage = message as unknown as TelegramInboundMessage;

    await withSpan(
        'router.telegram.message',
        {
            kind: SpanKind.CONSUMER,
            attributes: {
                'messaging.system': 'telegram',
                'messaging.message.id': String(inboundMessage.message_id),
            },
        },
        async () => {
            const chatId = ctx.chat?.id.toString();
            const senderId = ctx.from?.id.toString();
            const chatType = ctx.chat?.type;
            const chatTitle =
                ctx.chat && 'title' in ctx.chat && typeof ctx.chat.title === 'string' ? ctx.chat.title : undefined;
            const botUsername = ctx.botInfo?.username;
            const text = readTelegramMessageText(inboundMessage);

            addSpanAttributes({
                'messaging.destination.name': chatId,
                'enduser.id': senderId,
                'app.channel_type': chatType,
                'app.has_photo': Array.isArray(inboundMessage.photo) && inboundMessage.photo.length > 0,
                ...summarizeText(text),
            });

            logInfo('ROUTER', 'incoming_telegram', {
                chat: chatId,
                chat_type: chatType,
                sender: senderId,
                ...summarizeText(text),
            });

            if (!chatId || !senderId || !chatType) return;

            const isPrivate = chatType === 'private';
            const isHousehold = !isPrivate && isHouseholdChat(chatId);
            const existingSpace = getSpace(buildSpaceId('telegram', chatId));
            const isExternalGroup = !isPrivate && !isHousehold && isExternalGroupEnabled(existingSpace?.policy_json);
            const externalGroupMode = isExternalGroup
                ? resolveExternalGroupMode(existingSpace?.policy_json)
                : undefined;
            const isRoutableGroup = isHousehold || isExternalGroup;
            const hasText = typeof inboundMessage.text === 'string';
            const hasPhoto = Array.isArray(inboundMessage.photo) && inboundMessage.photo.length > 0;

            if (hasPhoto) {
                addSpanEvent('router.photo_message', { 'app.is_private': isPrivate, 'app.is_household': isHousehold });

                if (!isOwner(senderId, 'telegram')) {
                    addSpanAttributes({ 'app.access': 'denied' });
                    logWarn('ROUTER', 'ignored_photo_non_owner', {
                        sender: senderId,
                        chat: chatId,
                    });
                    if (isPrivate) {
                        await ctx.reply('Sorry. I only work with approved users.');
                    }
                    return;
                }

                const personId = buildChannelPersonId('telegram', senderId);
                const spaceId = buildSpaceId('telegram', chatId);
                ensureInboundIdentity({
                    channel: 'telegram',
                    channelRef: chatId,
                    channelTitle: chatTitle,
                    spaceId,
                    personId,
                    senderId,
                    senderUsername: ctx.from?.username || null,
                    senderDisplayName: ctx.from?.first_name || null,
                    isDirect: isPrivate,
                });

                storeMessage({
                    id: `${spaceId}:${inboundMessage.message_id}`,
                    space_id: spaceId,
                    channel_ref: chatId,
                    sender_id: personId,
                    content: `[PHOTO] ${text}`,
                    timestamp: new Date().toISOString(),
                    is_bot: 0,
                });

                const settings = resolveSpaceOperationalSettings(getSpace(spaceId)?.policy_json);
                addSpanAttributes({ 'app.channel_mode': settings.channel_mode });
                if (settings.channel_mode === 'full' && (isPrivate || isRoutableGroup)) {
                    await handleButlerPhoto(ctx, chatId, personId, text);
                }
                return;
            }

            if (!hasText) {
                if (!hasPhoto) {
                    addSpanAttributes({ 'app.message_status': 'unsupported_media' });
                    logWarn('ROUTER', 'unsupported_media_ignored', {
                        chat: chatId,
                        sender: senderId,
                        message_id: inboundMessage.message_id,
                    });
                }
                return;
            }

            await handleIncomingChannelMessage({
                channel: 'telegram',
                channelRef: chatId,
                channelTitle: chatTitle,
                senderId,
                senderUsername: ctx.from?.username || null,
                senderDisplayName: ctx.from?.first_name || null,
                messageId: String(inboundMessage.message_id),
                text,
                isDirect: isPrivate,
                isPrimaryGroup: isRoutableGroup,
                groupMode: isExternalGroup ? 'external' : isHousehold ? 'household' : undefined,
                externalGroupMode,
                botUsername,
                botUserId: ctx.botInfo?.id?.toString(),
                replyTo: buildTelegramReplyContext(inboundMessage),
                respond: async (responseText: string) => {
                    await ctx.reply(responseText);
                },
            });
        }
    );
}

export async function handleIncomingChannelMessage(message: IncomingChannelMessage) {
    await withSpan(
        'router.channel.message',
        {
            kind: SpanKind.CONSUMER,
            attributes: {
                'messaging.system': message.channel,
                'messaging.destination.name': message.channelRef,
                'messaging.message.id': message.messageId,
                'app.is_direct': message.isDirect,
                'app.is_primary_group': Boolean(message.isPrimaryGroup),
            },
        },
        async () => {
            const channel = message.channel;
            const channelRef = message.channelRef;
            const personId = buildChannelPersonId(channel, message.senderId);
            const spaceId = buildSpaceId(channel, channelRef);
            const existingSpace = getSpace(spaceId);
            const isExternalTelegramGroup =
                channel === 'telegram' && !message.isDirect && isExternalGroupEnabled(existingSpace?.policy_json);

            addSpanAttributes({
                'enduser.id': personId,
                'app.space_id': spaceId,
                ...summarizeText(message.text),
            });
            recordInboundMessage(
                {
                    channel,
                    is_direct: message.isDirect,
                    is_primary_group: Boolean(message.isPrimaryGroup),
                },
                message.text.length
            );

            logInfo('ROUTER', 'incoming_channel', {
                channel,
                ref: channelRef,
                sender: personId,
                is_direct: message.isDirect,
                is_primary_group: message.isPrimaryGroup,
                ...summarizeText(message.text),
            });

            if (message.isDirect) {
                ensureInboundIdentity({
                    channel,
                    channelRef,
                    channelTitle: message.channelTitle,
                    spaceId,
                    personId,
                    senderId: message.senderId,
                    senderUsername: message.senderUsername || null,
                    senderDisplayName: message.senderDisplayName || null,
                    isDirect: true,
                });
            }

            if (!isOwner(message.senderId, channel) && !isExternalTelegramGroup) {
                addSpanAttributes({ 'app.access': 'denied' });
                logWarn('ROUTER', 'ignored_non_owner', {
                    channel,
                    ref: channelRef,
                    sender: message.senderId,
                });
                if (message.isDirect) {
                    storeMessage({
                        id: `${spaceId}:${message.messageId}`,
                        space_id: spaceId,
                        channel_ref: channelRef,
                        sender_id: personId,
                        content: '[ACCESS_DENIED_DIRECT_CONTACT]',
                        timestamp: new Date().toISOString(),
                        is_bot: 0,
                    });
                    if (message.respond) {
                        await message.respond('Sorry. I only work with approved users.');
                    } else {
                        await sendChannelMessage(channel, channelRef, 'Sorry. I only work with approved users.');
                    }
                }
                return;
            }

            if (!message.isDirect) {
                ensureInboundIdentity({
                    channel,
                    channelRef,
                    channelTitle: message.channelTitle,
                    spaceId,
                    personId,
                    senderId: message.senderId,
                    senderUsername: message.senderUsername || null,
                    senderDisplayName: message.senderDisplayName || null,
                    isDirect: false,
                });
            }

            const finalContent = injectApprovalContext(
                spaceId,
                channelRef,
                personId,
                injectReplyContext(message.text, message.replyTo)
            );
            const space = existingSpace || getSpace(spaceId);
            const settings = resolveSpaceOperationalSettings(space?.policy_json);

            storeMessage({
                id: `${spaceId}:${message.messageId}`,
                space_id: spaceId,
                channel_ref: channelRef,
                sender_id: personId,
                content: finalContent,
                timestamp: new Date().toISOString(),
                is_bot: 0,
            });

            addSpanAttributes({ 'app.channel_mode': settings.channel_mode });
            if (settings.channel_mode !== 'full') {
                return;
            }

            if (message.isPrimaryGroup) {
                const replyTargetPersonId = message.replyTo?.senderId
                    ? buildChannelPersonId(channel, message.replyTo.senderId)
                    : undefined;
                const authorityGuard = evaluateAuthorityGuard({
                    spaceId,
                    senderId: personId,
                    text: message.text,
                    replyTarget: message.replyTo
                        ? {
                              personId: replyTargetPersonId,
                              displayName:
                                  message.replyTo.senderDisplayName || message.replyTo.senderUsername || undefined,
                              isBot: message.replyTo.isBot,
                          }
                        : undefined,
                });

                addSpanAttributes({ 'app.authority_guard_allowed': authorityGuard.allow });
                if (!authorityGuard.allow) {
                    addSpanEvent('router.authority_blocked');
                    if (message.respond) {
                        await message.respond(authorityGuard.reason);
                    } else {
                        await sendChannelMessage(channel, channelRef, authorityGuard.reason);
                    }
                    return;
                }
            }

            if (message.isDirect) {
                addSpanAttributes({ 'app.route': 'direct_butler' });
                await handleButlerMessage({
                    channel,
                    channelRef,
                    senderId: personId,
                    text: finalContent,
                    spaceId,
                });
                return;
            }

            if (!message.isPrimaryGroup) return;
            const shouldHandle = shouldHandlePrimaryGroupMessage(message, {
                allowPassiveTurns: message.groupMode !== 'external',
                allowRequestTriggers: message.groupMode !== 'external' || message.externalGroupMode === 'auto',
            });
            addSpanAttributes({ 'app.primary_group_handled': shouldHandle });
            if (shouldHandle) {
                await handleButlerMessage({
                    channel,
                    channelRef,
                    senderId: personId,
                    text: finalContent,
                    spaceId,
                    ...(message.groupMode === 'external' ? { suppressNoSend: true } : {}),
                });
            }
        }
    );
}
