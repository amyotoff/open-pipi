/**
 * A stand-in for src/channels/runtime.
 *
 * Since the outbox landed, every send goes to a queue and a worker delivers it
 * later. Tests about reminders, tasks, or the assistant's replies are not about
 * that machinery — the outbox and the delivery worker have their own tests —
 * so they intercept at the runtime boundary and assert what was sent, without
 * needing a queue or a transport.
 */

import { resolveSpaceOperationalSettings } from '../core/space-preferences';

type SendResult = { success: boolean; messageId?: string; error?: string };
type SpaceRow = { id: string; channel: string; external_ref: string; policy_json?: string | null };

export interface ChannelRuntimeMockDeps {
    /** Receives (endpointRef, text, opts) — the same shape the old transport spy saw. */
    sendMessageToChat: (ref: string, text: string, opts?: unknown) => Promise<unknown>;
    sendFileToChat?: (ref: string, filePath: string, opts?: unknown) => Promise<SendResult>;
    /** Needed only by callers that address a space rather than an endpoint. */
    getSpace?: (spaceId: string) => SpaceRow | undefined;
}

export function makeChannelRuntimeMock(deps: ChannelRuntimeMockDeps) {
    async function sendChannelMessage(
        _channel: string,
        channelRef: string,
        text: string,
        opts?: unknown
    ): Promise<SendResult> {
        // Passing an explicit undefined would show up as a third argument in
        // call assertions, which the real runtime never produced.
        const result = (await (opts === undefined
            ? deps.sendMessageToChat(channelRef, text)
            : deps.sendMessageToChat(channelRef, text, opts))) as SendResult | undefined;
        return result || { success: true };
    }

    return {
        buildChannelPersonId: (channel: string, senderId: string): string =>
            channel === 'telegram' ? senderId : `${channel}:${senderId}`,

        sendChannelMessage,
        sendChannelMessageNow: sendChannelMessage,

        sendChannelFile: async (
            _channel: string,
            channelRef: string,
            filePath: string,
            opts?: unknown
        ): Promise<SendResult> =>
            deps.sendFileToChat
                ? await deps.sendFileToChat(channelRef, filePath, opts)
                : { success: false, error: 'Channel does not support file attachments.' },

        sendChannelTyping: async (): Promise<void> => {},

        // Mirrors the real function's contract, including the quiet-mode
        // sentinel some callers assert on.
        sendSpaceMessage: async (spaceId: string, text: string, opts?: unknown): Promise<SendResult> => {
            const space = deps.getSpace?.(spaceId);
            if (!space) return { success: false, error: `Space "${spaceId}" not found.` };

            const settings = resolveSpaceOperationalSettings(space.policy_json ?? null);
            if (settings.channel_mode === 'off') {
                return { success: true, messageId: `suppressed:${spaceId}` };
            }

            return sendChannelMessage(space.channel, space.external_ref, text, opts);
        },

        sendSpaceFile: async (spaceId: string, filePath: string, opts?: unknown): Promise<SendResult> => {
            const space = deps.getSpace?.(spaceId);
            if (!space) return { success: false, error: `Space "${spaceId}" not found.` };
            return deps.sendFileToChat
                ? await deps.sendFileToChat(space.external_ref, filePath, opts)
                : { success: false, error: 'Channel does not support file attachments.' };
        },

        sendContextMessage: async (
            context: { channel?: string; chatId?: string; channelRef?: string },
            text: string,
            opts?: unknown
        ): Promise<SendResult> => {
            const channel = context.channel || (context.chatId ? 'telegram' : undefined);
            const channelRef = context.channelRef || context.chatId;
            if (!channel || !channelRef) return { success: false, error: 'Missing channel context.' };
            return sendChannelMessage(channel, channelRef, text, opts);
        },

        sendContextTyping: async (): Promise<void> => {},

        notifyPrimaryHousehold: async (): Promise<SendResult | undefined> => undefined,

        setIncomingChannelHandler: () => {},
        dispatchIncomingChannelMessage: async (): Promise<void> => {},
    };
}
