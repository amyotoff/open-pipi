/**
 * Legacy outbound channels, seen through the transport contract.
 *
 * Discord, WhatsApp, and Gmail still implement OutboundChannel. Rewriting all
 * three at once would put the most risk on the adapters with the least test
 * coverage and the fewest users, so instead they are wrapped: the delivery
 * worker talks to one interface and does not care which side of the migration
 * a channel is on.
 *
 * These wrappers are deliberately thin. A channel that grows real capabilities
 * should become a proper adapter rather than accumulate special cases here.
 */

import { getChannel } from '../channels/_registry';
import { MINIMAL_TRANSPORT_CAPABILITIES } from './types';
import type { ChannelType } from '../channels/_types';
import type { DeliveryResult, OutgoingMessage, TransportCapabilities, TransportDestination } from './types';

/** The half of a transport the delivery worker needs: how to put a message out. */
export interface TransportSender {
    readonly name: string;
    send(destination: TransportDestination, message: OutgoingMessage): Promise<DeliveryResult>;
    getCapabilities(destination?: TransportDestination): Promise<TransportCapabilities>;
    splitForDelivery?(message: OutgoingMessage): OutgoingMessage[];
}

const LEGACY_CAPABILITIES: TransportCapabilities = {
    ...MINIMAL_TRANSPORT_CAPABILITIES,
    attachments: true,
};

export function wrapOutboundChannel(name: string): TransportSender | null {
    const channel = getChannel(name as ChannelType);
    if (!channel) return null;

    return {
        name,

        async send(destination: TransportDestination, message: OutgoingMessage): Promise<DeliveryResult> {
            const attachment = message.content.attachments?.[0];

            if (attachment) {
                if (!channel.sendFile) {
                    // No amount of retrying teaches a channel to send files.
                    return { status: 'permanent_error', error: `Channel "${name}" does not support attachments.` };
                }

                const fileResult = await channel.sendFile(destination.endpointId, attachment.localPath, {
                    filename: attachment.filename,
                    caption: attachment.caption ?? message.content.text,
                });
                return fileResult.success
                    ? { status: 'sent', transportMessageId: fileResult.messageId }
                    : { status: 'retryable_error', error: fileResult.error };
            }

            const result = await channel.sendMessage(destination.endpointId, message.content.text || '', {
                threadId: destination.threadId,
            });
            return result.success
                ? { status: 'sent', transportMessageId: result.messageId }
                : { status: 'retryable_error', error: result.error };
        },

        async getCapabilities(): Promise<TransportCapabilities> {
            return LEGACY_CAPABILITIES;
        },
    };
}
