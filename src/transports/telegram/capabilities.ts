import type { TransportCapabilities } from '../types';

/**
 * What Telegram can carry.
 *
 * `maxTextLength` is Telegram's hard per-message limit. Nothing enforces it yet
 * — the renderer that splits long replies arrives with the outbox in phase 4 —
 * but the number lives here so the renderer reads it from the transport rather
 * than hardcoding it.
 */
export const TELEGRAM_CAPABILITIES: TransportCapabilities = {
    markdown: true,
    attachments: true,
    images: true,
    audio: true,
    voice: true,

    // Telegram supports editing a sent message, which is how a future streaming
    // reply would work here. Nothing streams today.
    streaming: false,
    messageEditing: true,

    reactions: true,
    threads: true,
    replies: true,

    maxTextLength: 4096,
    maxAttachmentSizeBytes: 50 * 1024 * 1024,
};
