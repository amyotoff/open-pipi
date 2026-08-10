/**
 * The one path an inbound message takes, whatever carried it.
 *
 *   normalize -> dedup pre-check -> binding -> participant -> permissions
 *   -> persist -> agent
 *
 * Adapters call handleIncoming and nothing else. They never choose a pack, load
 * grounding, touch memory, or run the model.
 */

import { SpanKind } from '@opentelemetry/api';
import { getParticipantIdentity, getSpace, logEvent, storeMessage, type Space } from '../db';
import { isOwner } from '../config';
import { buildChannelPersonId, sendChannelMessageNow } from '../channels/runtime';
import { listPendingApprovalDetails, recordApprovalResponse } from '../utils/approvals';
import { executeApprovedToolContinuations, formatApprovedToolContinuationReply } from '../core/approval-continuation';
import { logInfo, logWarn, summarizeText } from '../utils/logging';
import { evaluateAuthorityGuard } from '../core/authority-guard';
import { addSpanAttributes, addSpanEvent, recordInboundMessage, withSpan } from '../observability';
import { resolveSpaceOperationalSettings } from '../core/space-preferences';
import { handleButlerMessage, handleButlerPhoto } from '../agents/butler';
import { resolveTransportBinding } from './binding-resolver';
import { resolveParticipant } from './participant-resolver';
import { evaluateParticipation, shouldHandlePrimaryGroupMessage } from './participation';
import { getTransport } from '../transports/registry';
import type { IncomingAttachment, IncomingMessage } from '../transports/types';

const ACCESS_DENIED_REPLY = 'Sorry. I only work with approved users.';

export interface HandleIncomingOptions {
    /**
     * A transport whose "primary group" is a fixed configured endpoint says so
     * here; Telegram leaves it unset and lets space policy decide.
     */
    declaredPrimaryGroup?: boolean;
    /** Reply in place, for refusals that should never outlive the process. */
    respond?: (text: string) => Promise<void>;
}

function readImageAttachment(message: IncomingMessage): IncomingAttachment | undefined {
    return message.content.attachments?.find((attachment) => attachment.type === 'image');
}

/**
 * Answer a refusal on the spot rather than through the outbox.
 *
 * A refusal is only meaningful in the moment it is given, and queueing one
 * would spend the retry budget re-offering it to someone who is not allowed to
 * talk to the assistant in the first place.
 */
async function reply(message: IncomingMessage, text: string, options?: HandleIncomingOptions): Promise<void> {
    if (options?.respond) {
        await options.respond(text);
        return;
    }
    await sendChannelMessageNow(message.transport, message.endpoint.id, text);
}

function injectReplyContext(message: IncomingMessage, text: string): string {
    const replyText = message.replyTo?.text;
    if (!replyText) return text;

    const replyAuthor = message.replyTo?.sender?.displayName || message.replyTo?.sender?.username || 'Someone';
    const snippet = replyText.length > 150 ? `${replyText.substring(0, 150)}...` : replyText;
    logInfo('GATEWAY', 'reply_context_injected', {
        reply_author_present: Boolean(replyAuthor),
        ...summarizeText(replyText),
    });
    return `[Replying to ${replyAuthor}: "${snippet}"]\n${text}`;
}

async function resolveRoutedApproval(input: {
    message: IncomingMessage;
    spaceId: string;
    participantId: string;
    content: string;
    options?: HandleIncomingOptions;
}): Promise<{ content: string; handled: boolean }> {
    const { message, spaceId, participantId } = input;
    const rawText = message.content.text || '';
    const approvalScope = { spaceId, chatId: message.endpoint.id, userId: participantId };
    const pendingTools = new Map(
        listPendingApprovalDetails(approvalScope).map(({ actionClass, toolName }) => [actionClass, toolName])
    );
    const approval = recordApprovalResponse(approvalScope, rawText);
    for (const actionClass of approval.granted) {
        logEvent('approval_decision', {
            space_id: spaceId,
            user_id: participantId,
            channel: message.transport,
            channel_ref: message.endpoint.id,
            action_class: actionClass,
            tool_name:
                approval.continuations?.find((item) => item.actionClass === actionClass)?.toolName ||
                pendingTools.get(actionClass) ||
                null,
            decision: 'approved',
            source: 'message',
        });
    }
    for (const actionClass of approval.denied) {
        logEvent('approval_decision', {
            space_id: spaceId,
            user_id: participantId,
            channel: message.transport,
            channel_ref: message.endpoint.id,
            action_class: actionClass,
            tool_name: pendingTools.get(actionClass) || null,
            decision: 'denied',
            source: 'message',
        });
    }
    let content = input.content;
    if (approval.granted.length > 0) {
        content = `[SYSTEM] User approved sensitive actions: ${approval.granted.join(', ')}.\n${content}`;
    }
    if (approval.denied.length > 0) {
        content = `[SYSTEM] User denied sensitive actions: ${approval.denied.join(', ')}.\n${content}`;
    }

    if (!approval.continuations?.length) return { content, handled: false };

    const results = await executeApprovedToolContinuations(approval.continuations, {
        userId: participantId,
        spaceId,
        chatId: message.transport === 'telegram' ? message.endpoint.id : undefined,
        channel: message.transport,
        channelRef: message.endpoint.id,
    });
    const response = formatApprovedToolContinuationReply(results) || 'The approved action could not be completed.';
    await reply(message, response, input.options);
    return { content, handled: true };
}

function persist(input: { message: IncomingMessage; space: Space; participantId: string; content: string }): {
    inserted: boolean;
} {
    return storeMessage({
        id: input.message.id,
        space_id: input.space.id,
        channel: input.message.transport,
        channel_ref: input.message.endpoint.id,
        sender_id: input.participantId,
        content: input.content,
        timestamp: input.message.timestamp,
        is_bot: 0,
        transport: input.message.transport,
        transport_message_id: input.message.transportMessageId,
    });
}

/**
 * The authority guard compares against internal participant ids, so a reply
 * target has to be translated the same way its author was.
 */
function resolveReplyTargetParticipantId(message: IncomingMessage): string | undefined {
    const targetId = message.replyTo?.sender?.transportUserId;
    if (!targetId) return undefined;

    const identity = getParticipantIdentity(message.transport, targetId);
    return identity?.participant_id ?? buildChannelPersonId(message.transport, targetId);
}

/**
 * Route one inbound message.
 *
 * Deduplication happens twice on purpose. The cheap pre-check drops an obvious
 * replay before any resolution work; the insert is the authoritative guard,
 * because it needs the resolved space and it always runs before the agent. Two
 * racing deliveries of the same event therefore still produce one run.
 */
export async function handleIncoming(message: IncomingMessage, options?: HandleIncomingOptions): Promise<void> {
    await withSpan(
        'gateway.message',
        {
            kind: SpanKind.CONSUMER,
            attributes: {
                'messaging.system': message.transport,
                'messaging.destination.name': message.endpoint.id,
                'messaging.message.id': message.id,
                'app.correlation_id': message.correlationId,
            },
        },
        async () => {
            const text = message.content.text || '';
            const image = readImageAttachment(message);

            addSpanAttributes({
                'enduser.id': message.sender.transportUserId,
                'app.endpoint_type': message.endpoint.type,
                'app.has_image': Boolean(image),
                ...summarizeText(text),
            });
            logInfo('GATEWAY', 'incoming', {
                transport: message.transport,
                endpoint: message.endpoint.id,
                sender: message.sender.transportUserId,
                endpoint_type: message.endpoint.type,
                correlation_id: message.correlationId,
                ...summarizeText(text),
            });

            // May this person talk to the assistant here at all?
            //
            // Two ways to qualify, and they are not the same thing: a transport
            // that authenticated its sender has proven who they are and checked
            // their membership, while the owner allowlist is the trust anchor
            // where the transport cannot prove anything.
            //
            // Deliberately not called "is owner" — an authenticated web member
            // passes this and is not one. Anything that must be owner-only
            // should ask the participant's role, not reuse this.
            const senderIsAuthorized =
                message.senderAuthenticated === true || isOwner(message.sender.transportUserId, message.transport);
            const isDirect = message.endpoint.type === 'direct';

            // Look up without creating anything first. Only an owner — or a
            // direct chat, which has always registered its sender so a refusal
            // can be recorded — may cause a space to come into existence.
            let binding = resolveTransportBinding(message, { allowBootstrap: false });
            if (!binding.space && (senderIsAuthorized || isDirect)) {
                binding = resolveTransportBinding(message);
            }

            const space = binding.space;
            if (!space) {
                addSpanAttributes({ 'app.binding': 'unresolved' });
                logWarn('GATEWAY', 'binding_unresolved', {
                    transport: message.transport,
                    endpoint: message.endpoint.id,
                    sender_authorized: senderIsAuthorized,
                });
                return;
            }

            addSpanAttributes({ 'app.space_id': space.id, 'app.binding_source': binding.source });

            const participation = evaluateParticipation({
                message,
                space,
                declaredPrimaryGroup: options?.declaredPrimaryGroup,
            });
            recordInboundMessage(
                {
                    channel: message.transport,
                    is_direct: participation.isDirect,
                    is_primary_group: participation.isPrimaryGroup,
                },
                text.length
            );

            // An external group is answerable by people who are not owners; every
            // other surface stays owner-only, exactly as before.
            //
            // Attachments are the exception to the exception: they have always
            // required an owner, on every surface. Vision is the most expensive
            // call the assistant makes, and an attached client group is full of
            // people the operator did not vouch for.
            const isExternalTelegramGroup =
                message.transport === 'telegram' &&
                !participation.isDirect &&
                participation.groupMode === 'external' &&
                !image;

            if (!senderIsAuthorized && !isExternalTelegramGroup) {
                addSpanAttributes({ 'app.access': 'denied' });
                logWarn('GATEWAY', 'ignored_non_owner', {
                    transport: message.transport,
                    endpoint: message.endpoint.id,
                    sender: message.sender.transportUserId,
                });

                if (participation.isDirect) {
                    const participant = resolveParticipant(message, space.id);
                    persist({
                        message,
                        space,
                        participantId: participant.participantId,
                        content: '[ACCESS_DENIED_DIRECT_CONTACT]',
                    });
                    await reply(message, ACCESS_DENIED_REPLY, options);
                }
                return;
            }

            const participant = resolveParticipant(message, space.id);
            addSpanAttributes({ 'app.participant_id': participant.participantId });

            let content = image ? `[PHOTO] ${text}` : injectReplyContext(message, text);

            const stored = persist({ message, space, participantId: participant.participantId, content });
            if (!stored.inserted) {
                // The transport delivered this event before. Running the agent
                // again would answer the same question twice.
                addSpanEvent('gateway.duplicate_dropped');
                logInfo('GATEWAY', 'duplicate_dropped', {
                    transport: message.transport,
                    message_id: message.id,
                });
                return;
            }

            const settings = resolveSpaceOperationalSettings(getSpace(space.id)?.policy_json);
            addSpanAttributes({ 'app.channel_mode': settings.channel_mode });
            if (settings.channel_mode !== 'full') return;

            if (image) {
                if (!participation.isDirect && !participation.isPrimaryGroup) return;

                // Fetched only now, past the permission checks, so an
                // unapproved sender cannot make the assistant download files.
                const resolved = await getTransport(message.transport)?.resolveAttachment?.(image);
                if (!resolved) {
                    logWarn('GATEWAY', 'attachment_unresolved', {
                        transport: message.transport,
                        attachment_id: image.id,
                    });
                    return;
                }

                await handleButlerPhoto({
                    channel: message.transport,
                    channelRef: message.endpoint.id,
                    spaceId: space.id,
                    senderId: participant.participantId,
                    caption: text,
                    image: resolved,
                    correlationId: message.correlationId,
                });
                return;
            }

            if (participation.isPrimaryGroup) {
                const authorityGuard = evaluateAuthorityGuard({
                    spaceId: space.id,
                    senderId: participant.participantId,
                    text,
                    replyTarget: message.replyTo
                        ? {
                              personId: resolveReplyTargetParticipantId(message),
                              displayName:
                                  message.replyTo.sender?.displayName || message.replyTo.sender?.username || undefined,
                              isBot: message.replyTo.sender?.isBot,
                          }
                        : undefined,
                });

                addSpanAttributes({ 'app.authority_guard_allowed': authorityGuard.allow });
                if (!authorityGuard.allow) {
                    addSpanEvent('gateway.authority_blocked');
                    await reply(message, authorityGuard.reason, options);
                    return;
                }
            }

            if (participation.isDirect) {
                const approval = await resolveRoutedApproval({
                    message,
                    spaceId: space.id,
                    participantId: participant.participantId,
                    content,
                    options,
                });
                if (approval.handled) return;
                content = approval.content;
                addSpanAttributes({ 'app.route': 'direct_butler' });
                await handleButlerMessage({
                    channel: message.transport,
                    channelRef: message.endpoint.id,
                    senderId: participant.participantId,
                    text: content,
                    spaceId: space.id,
                    correlationId: message.correlationId,
                });
                return;
            }

            if (!participation.isPrimaryGroup) return;

            const shouldHandle = await shouldHandlePrimaryGroupMessage(
                {
                    endpointId: message.endpoint.id,
                    text,
                    addressedToAssistant: message.addressedToAssistant,
                },
                {
                    allowPassiveTurns: participation.groupMode !== 'external',
                    allowRequestTriggers:
                        participation.groupMode !== 'external' || participation.externalGroupMode === 'auto',
                }
            );
            addSpanAttributes({ 'app.primary_group_handled': shouldHandle });
            if (!shouldHandle) return;

            if (message.addressedToAssistant) {
                const approval = await resolveRoutedApproval({
                    message,
                    spaceId: space.id,
                    participantId: participant.participantId,
                    content,
                    options,
                });
                if (approval.handled) return;
                content = approval.content;
            }

            await handleButlerMessage({
                channel: message.transport,
                channelRef: message.endpoint.id,
                senderId: participant.participantId,
                text: content,
                spaceId: space.id,
                correlationId: message.correlationId,
                ...(participation.groupMode === 'external' ? { suppressNoSend: true } : {}),
            });
        }
    );
}
