/**
 * The Telegram transport.
 *
 * Owns the connection, translates updates through the normalizer, and hands the
 * result to the gateway. Downloading a photo happens here too: an attachment
 * reaches Core already resolved, so nothing downstream needs a Telegram file id
 * or a bot token.
 */

import {
    bot,
    isTelegramBotLaunched,
    markTelegramBotStopped,
    registerTelegramFallbackHandlers,
    startTelegramBot,
} from '../../channels/telegram';
import { sendMessageToChat, sendFileToChat } from '../../channels/telegram-send';
import { logError, logWarn, summarizeError } from '../../utils/logging';
import { normalizeTelegramMessage } from './normalizer';
import { renderForTelegram } from './renderer';
import { TELEGRAM_CAPABILITIES } from './capabilities';
import type {
    DeliveryResult,
    IncomingAttachment,
    OutgoingMessage,
    ResolvedAttachment,
    TransportAdapter,
    TransportCapabilities,
    TransportDestination,
    TransportRuntimeContext,
} from '../types';

export class TelegramTransportAdapter implements TransportAdapter {
    readonly name = 'telegram';

    async start(context: TransportRuntimeContext): Promise<void> {
        registerTelegramFallbackHandlers({
            onMessage: async (update) => {
                const message = normalizeTelegramMessage({
                    message: update.message,
                    chat: update.chat,
                    from: update.from,
                    bot: update.bot,
                });

                if (!message) {
                    // A sticker, a poll, a service notice. Not an error.
                    logWarn('TELEGRAM', 'unsupported_update_ignored', {
                        chat: update.chat?.id === undefined ? undefined : String(update.chat.id),
                    });
                    return;
                }

                await context.messageGateway.handleIncoming(message);
            },
        });

        startTelegramBot();
    }

    async stop(): Promise<void> {
        // A bot that never launched — no token, a dry run — has nothing to stop,
        // and telegraf throws rather than shrugging if asked anyway.
        if (!isTelegramBotLaunched()) return;

        try {
            bot.stop('shutdown');
        } catch (error) {
            logError('TELEGRAM', 'stop_failed', summarizeError(error));
        } finally {
            markTelegramBotStopped();
        }
    }

    /**
     * One outgoing message becomes one send per rendered piece: the text split
     * across Telegram's ceiling, then each attachment.
     */
    splitForDelivery(message: OutgoingMessage): OutgoingMessage[] {
        return renderForTelegram(message, TELEGRAM_CAPABILITIES).map((delivery, index) => ({
            id: `${message.id}#${index}`,
            content: {
                ...(delivery.text ? { text: delivery.text } : {}),
                ...(delivery.attachment ? { attachments: [delivery.attachment] } : {}),
            },
            ...(delivery.replyToTransportMessageId
                ? { replyTo: { transportMessageId: delivery.replyToTransportMessageId } }
                : {}),
            formatting: message.formatting,
            delivery: {
                silent: delivery.silent,
                pin: delivery.pin,
                unpinAfterHours: delivery.unpinAfterHours,
            },
            metadata: message.metadata,
        }));
    }

    /** Receives a single already-split piece; splitForDelivery did the shaping. */
    async send(destination: TransportDestination, message: OutgoingMessage): Promise<DeliveryResult> {
        const attachment = message.content.attachments?.[0];

        const result = attachment
            ? await sendFileToChat(destination.endpointId, attachment.localPath, {
                  filename: attachment.filename,
                  caption: attachment.caption ?? message.content.text,
                  pin: message.delivery?.pin,
                  unpinAfterHours: message.delivery?.unpinAfterHours,
                  pinDisableNotification: message.delivery?.silent,
              })
            : await sendMessageToChat(destination.endpointId, message.content.text || '', {
                  pin: message.delivery?.pin,
                  unpinAfterHours: message.delivery?.unpinAfterHours,
                  pinDisableNotification: message.delivery?.silent,
              });

        if (result.success) {
            return { status: 'sent', transportMessageId: result.messageId };
        }

        return { status: 'retryable_error', error: result.error };
    }

    async getCapabilities(): Promise<TransportCapabilities> {
        return TELEGRAM_CAPABILITIES;
    }

    /** Telegram hands out file ids; the bytes take a second, authenticated request. */
    async resolveAttachment(attachment: IncomingAttachment): Promise<ResolvedAttachment | null> {
        const fileId = (attachment.metadata as { fileId?: string } | undefined)?.fileId;
        if (!fileId) return null;

        const file = await bot.telegram.getFile(fileId);
        if (!file.file_path) return null;

        const response = await fetch(`https://api.telegram.org/file/bot${bot.telegram.token}/${file.file_path}`);
        const buffer = Buffer.from(await response.arrayBuffer());

        return {
            base64: buffer.toString('base64'),
            mimeType: file.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg',
        };
    }
}
