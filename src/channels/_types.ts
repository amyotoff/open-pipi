/**
 * Channel abstraction for optional non-Telegram adapters.
 *
 * Channels are self-registering modules that allow the runtime to send
 * messages via WhatsApp, Discord, and Gmail without direct coupling.
 */

export type ChannelType = 'whatsapp' | 'discord' | 'gmail';

export interface MessageOptions {
    subject?: string; // email subject
    threadId?: string; // for threading replies
    references?: string[]; // email references chain
    requestId?: number; // concierge service_request.id for audit logging
    pin?: boolean; // Telegram-only: pin the sent message
    unpinAfterHours?: number; // Telegram-only: best-effort auto-unpin delay
    pinDisableNotification?: boolean; // Telegram-only: pin quietly
}

export interface FileOptions {
    caption?: string;
    filename?: string;
    pin?: boolean; // Telegram-only: pin the sent file message
    unpinAfterHours?: number; // Telegram-only: best-effort auto-unpin delay
    pinDisableNotification?: boolean; // Telegram-only: pin quietly
}

export interface SendResult {
    success: boolean;
    messageId?: string;
    error?: string;
    fallbackUrl?: string; // e.g. wa.me deep-link when WhatsApp not connected
}

export interface OutboundChannel {
    readonly type: ChannelType;

    /** Connect to the service (authenticate, open socket, etc.) */
    connect(): Promise<void>;

    /** Gracefully disconnect */
    disconnect(): Promise<void>;

    /** Whether the channel is currently connected and ready to send */
    isConnected(): boolean;

    /** Send a message to a recipient (phone number, email, channel ID) */
    sendMessage(to: string, text: string, opts?: MessageOptions): Promise<SendResult>;

    /** Optionally send a local file as an attachment/document. */
    sendFile?(to: string, filePath: string, opts?: FileOptions): Promise<SendResult>;
}

/** Factory function that creates a channel instance, or null if not configured */
export type ChannelFactory = () => OutboundChannel | null;
