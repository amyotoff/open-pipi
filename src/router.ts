/**
 * Compatibility shim over the gateway.
 *
 * Routing moved to src/gateway/*: the pipeline lives in message-gateway.ts and
 * the group-participation rules in participation.ts. Telegram normalization
 * moved further out still, into src/transports/telegram/normalizer.ts.
 *
 * This module remains for one release so the channels that still speak
 * IncomingChannelMessage — Discord, WhatsApp, Gmail — keep working unchanged.
 * It translates their message shape into the transport-neutral one and calls
 * the same gateway Telegram uses. There is only one pipeline now.
 */

import { randomUUID } from 'node:crypto';
import { buildIncomingMessageId, type IncomingMessage, type TransportEndpointType } from './transports/types';
import { handleIncoming } from './gateway/message-gateway';
import type { IncomingChannelMessage } from './channels/runtime';

function endpointTypeForChannelMessage(message: IncomingChannelMessage): TransportEndpointType {
    return message.isDirect ? 'direct' : 'group';
}

/**
 * These channels resolve "was this aimed at the assistant" the way the router
 * always did for them: an @mention of the bot's username, or a reply to one of
 * its own messages.
 */
function isAddressedToAssistant(message: IncomingChannelMessage): boolean {
    const mentioned = message.botUsername
        ? message.text.toLowerCase().includes(`@${message.botUsername.toLowerCase()}`)
        : false;

    const repliedTo = Boolean(
        message.replyTo &&
        (message.replyTo.senderUsername === message.botUsername ||
            message.replyTo.senderId === message.botUserId ||
            message.replyTo.isBot)
    );

    return mentioned || repliedTo;
}

export function toIncomingMessage(message: IncomingChannelMessage): IncomingMessage {
    return {
        id: buildIncomingMessageId(message.channel, message.channelRef, message.messageId),
        transportMessageId: message.messageId,
        transport: message.channel,
        endpoint: {
            id: message.channelRef,
            type: endpointTypeForChannelMessage(message),
            title: message.channelTitle ?? null,
        },
        sender: {
            transportUserId: message.senderId,
            displayName: message.senderDisplayName ?? null,
            username: message.senderUsername ?? null,
        },
        content: { text: message.text },
        replyTo: message.replyTo
            ? {
                  sender: message.replyTo.senderId
                      ? {
                            transportUserId: message.replyTo.senderId,
                            displayName: message.replyTo.senderDisplayName ?? null,
                            username: message.replyTo.senderUsername ?? null,
                            isBot: message.replyTo.isBot,
                        }
                      : undefined,
                  text: message.replyTo.text ?? null,
              }
            : undefined,
        timestamp: new Date().toISOString(),
        correlationId: randomUUID(),
        addressedToAssistant: isAddressedToAssistant(message),
    };
}

export async function handleIncomingChannelMessage(message: IncomingChannelMessage): Promise<void> {
    await handleIncoming(toIncomingMessage(message), {
        // Discord and WhatsApp pin their primary group to a configured
        // endpoint, so they state the answer rather than letting space policy
        // derive it the way Telegram does.
        declaredPrimaryGroup: message.isDirect ? undefined : Boolean(message.isPrimaryGroup),
        respond: message.respond,
    });
}

export { handleIncoming } from './gateway/message-gateway';
