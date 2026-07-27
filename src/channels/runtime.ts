import { randomUUID } from 'node:crypto';
import { RuntimeExecutionContext } from '../core/runtime-context';
import { HOUSEHOLD_CHAT_ID } from '../config';
import { getSpace } from '../db';
import { resolveSpaceOperationalSettings } from '../core/space-preferences';
import { getChannel } from './_registry';
import { enqueueDelivery } from '../gateway/outbox';
import { getTransport } from '../transports/registry';
import type { ChannelType, FileOptions, MessageOptions, SendResult } from './_types';
import type { OutgoingMessage, TransportDestination } from '../transports/types';

export type RuntimeChannel = 'telegram' | ChannelType;

export interface IncomingChannelMessage {
    channel: string;
    channelRef: string;
    channelTitle?: string | null;
    senderId: string;
    senderUsername?: string | null;
    senderDisplayName?: string | null;
    messageId: string;
    text: string;
    isDirect: boolean;
    isPrimaryGroup?: boolean;
    groupMode?: 'household' | 'external';
    externalGroupMode?: 'mention_only' | 'auto';
    botUsername?: string | null;
    botUserId?: string | null;
    replyTo?: {
        senderId?: string | null;
        senderUsername?: string | null;
        senderDisplayName?: string | null;
        isBot?: boolean;
        text?: string | null;
    };
    respond?: (text: string) => Promise<void>;
}

export type IncomingChannelHandler = (message: IncomingChannelMessage) => Promise<void>;

let incomingChannelHandler: IncomingChannelHandler | null = null;

async function getTelegramRuntime() {
    return await import('./telegram');
}

export function setIncomingChannelHandler(handler: IncomingChannelHandler): void {
    incomingChannelHandler = handler;
}

export async function dispatchIncomingChannelMessage(message: IncomingChannelMessage): Promise<void> {
    if (!incomingChannelHandler) {
        console.warn(`[CHANNELS] Dropped inbound ${message.channel} message: no handler registered.`);
        return;
    }

    await incomingChannelHandler(message);
}

export function buildChannelPersonId(channel: string, senderId: string): string {
    return channel === 'telegram' ? senderId : `${channel}:${senderId}`;
}

/**
 * Hand a message to the outbox.
 *
 * Every caller in the system already goes through these functions, so queueing
 * here is what makes delivery survive a crash without touching any of them.
 *
 * The meaning of the result changes with it: `success` now says the message was
 * accepted for delivery, not that it arrived. That is the honest reading —
 * delivery is asynchronous — and callers that gate a "already notified" flag on
 * it are better off for it, because the outbox keeps trying.
 */
async function enqueueOutgoing(input: {
    channel: string;
    channelRef: string;
    text?: string;
    attachment?: { localPath: string; filename?: string; caption?: string };
    spaceId?: string | null;
    opts?: MessageOptions | FileOptions;
    idempotencyKey?: string;
    endpointType?: TransportDestination['endpointType'];
}): Promise<SendResult> {
    const message: OutgoingMessage = {
        id: randomUUID(),
        content: {
            ...(input.text ? { text: input.text } : {}),
            ...(input.attachment ? { attachments: [input.attachment] } : {}),
        },
        delivery: {
            pin: input.opts?.pin,
            unpinAfterHours: input.opts?.unpinAfterHours,
            silent: input.opts?.pinDisableNotification,
        },
    };

    const destination: TransportDestination = {
        endpointId: input.channelRef,
        endpointType: input.endpointType ?? 'direct',
        ...((input.opts as MessageOptions | undefined)?.threadId
            ? { threadId: (input.opts as MessageOptions).threadId }
            : {}),
    };

    // Split now, not at send time, so each piece retries alone — see
    // TransportAdapter.splitForDelivery.
    const pieces = getTransport(input.channel)?.splitForDelivery?.(message) ?? [message];
    if (pieces.length === 0) return { success: true };

    let firstId = '';
    for (const [index, piece] of pieces.entries()) {
        const entry = enqueueDelivery({
            transport: input.channel,
            destination,
            payload: piece,
            spaceId: input.spaceId ?? null,
            ...(input.idempotencyKey ? { idempotencyKey: `${input.idempotencyKey}#${index}` } : {}),
        });
        if (index === 0) firstId = entry.id;
    }

    return { success: true, messageId: `outbox:${firstId}` };
}

export async function sendChannelMessage(
    channel: string,
    channelRef: string,
    text: string,
    opts?: MessageOptions
): Promise<SendResult> {
    return enqueueOutgoing({ channel, channelRef, text, opts });
}

/**
 * Send without queueing, for replies that must not outlive the process —
 * a command's own answer, or a refusal. Queueing those would mean a message
 * arriving long after the moment it made sense.
 */
export async function sendChannelMessageNow(
    channel: string,
    channelRef: string,
    text: string,
    opts?: MessageOptions
): Promise<SendResult> {
    if (channel === 'telegram') {
        const { sendMessageToChat } = await getTelegramRuntime();
        const result =
            opts === undefined
                ? await sendMessageToChat(channelRef, text)
                : await sendMessageToChat(channelRef, text, opts);
        return result || { success: true };
    }

    const outboundChannel = getChannel(channel as ChannelType);
    if (!outboundChannel) {
        return { success: false, error: `Channel "${channel}" is not connected.` };
    }

    return outboundChannel.sendMessage(channelRef, text, opts);
}

export async function sendChannelTyping(channel: string, channelRef: string): Promise<void> {
    if (channel !== 'telegram') return;
    const { sendTypingAction } = await getTelegramRuntime();
    await sendTypingAction(channelRef);
}

export async function sendChannelFile(
    channel: string,
    channelRef: string,
    filePath: string,
    opts?: FileOptions
): Promise<SendResult> {
    return enqueueOutgoing({
        channel,
        channelRef,
        attachment: { localPath: filePath, filename: opts?.filename, caption: opts?.caption },
        opts,
    });
}

export async function sendContextMessage(
    context: Partial<RuntimeExecutionContext>,
    text: string,
    opts?: MessageOptions
): Promise<SendResult> {
    const channel = context.channel || (context.chatId ? 'telegram' : undefined);
    const channelRef = context.channelRef || context.chatId;
    if (!channel || !channelRef) {
        return { success: false, error: 'Missing channel context.' };
    }

    return sendChannelMessage(channel, channelRef, text, opts);
}

export async function sendContextTyping(context: Partial<RuntimeExecutionContext>): Promise<void> {
    const channel = context.channel || (context.chatId ? 'telegram' : undefined);
    const channelRef = context.channelRef || context.chatId;
    if (!channel || !channelRef) return;
    await sendChannelTyping(channel, channelRef);
}

export async function sendSpaceMessage(spaceId: string, text: string, opts?: MessageOptions): Promise<SendResult> {
    const space = getSpace(spaceId);
    if (!space) {
        return { success: false, error: `Space "${spaceId}" not found.` };
    }

    const settings = resolveSpaceOperationalSettings(space.policy_json);
    if (settings.channel_mode === 'off') {
        return {
            success: true,
            messageId: `suppressed:${spaceId}`,
        };
    }

    return enqueueOutgoing({
        channel: space.channel,
        channelRef: space.external_ref,
        text,
        spaceId: space.id,
        endpointType: space.kind === 'group_chat' ? 'group' : 'direct',
        opts,
        idempotencyKey: opts?.idempotencyKey,
    });
}

export async function notifyPrimaryHousehold(text: string): Promise<SendResult | undefined> {
    if (!HOUSEHOLD_CHAT_ID) return undefined;
    return sendChannelMessage('telegram', HOUSEHOLD_CHAT_ID, text);
}
