import { RuntimeExecutionContext } from '../core/runtime-context';
import { HOUSEHOLD_CHAT_ID } from '../config';
import { getSpace } from '../db';
import { resolveSpaceOperationalSettings } from '../core/space-preferences';
import { getChannel } from './_registry';
import type { ChannelType, FileOptions, MessageOptions, SendResult } from './_types';

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

export async function sendChannelMessage(
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
    if (channel === 'telegram') {
        const { sendFileToChat } = await getTelegramRuntime();
        return await sendFileToChat(channelRef, filePath, opts);
    }

    const outboundChannel = getChannel(channel as ChannelType);
    if (!outboundChannel?.sendFile) {
        return { success: false, error: `Channel "${channel}" does not support file attachments.` };
    }

    return outboundChannel.sendFile(channelRef, filePath, opts);
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

    return sendChannelMessage(space.channel, space.external_ref, text, opts);
}

export async function notifyPrimaryHousehold(text: string): Promise<SendResult | undefined> {
    if (!HOUSEHOLD_CHAT_ID) return undefined;
    return sendChannelMessage('telegram', HOUSEHOLD_CHAT_ID, text);
}
