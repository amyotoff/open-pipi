/**
 * The narrow waist between transports and PiPi Core.
 *
 * Everything in this file is transport-neutral by construction: no Telegram
 * update, Discord message, or HTTP request may cross this boundary. Adapters
 * translate their SDK's world into these types on the way in, and back out of
 * them on the way out. Core reasons about spaces and participants and never
 * learns which wire a message arrived on.
 *
 * The rule that keeps this honest is enforced by a test, not by convention —
 * see the allowlists in src/transports/boundary.test.ts.
 */

// ==========================================
// Inbound
// ==========================================

export type IncomingAttachmentType = 'image' | 'audio' | 'video' | 'document' | 'voice' | 'unknown';

export interface IncomingAttachment {
    id: string;
    type: IncomingAttachmentType;

    filename?: string;
    mimeType?: string;
    sizeBytes?: number;

    /** Path under DATA_DIR once the adapter has downloaded the file. */
    localPath?: string;
    remoteUrl?: string;

    metadata?: Record<string, unknown>;
}

export interface IncomingSender {
    transportUserId: string;
    displayName?: string | null;
    username?: string | null;
    isBot?: boolean;
}

export interface IncomingReplyContext {
    transportMessageId?: string | null;
    internalMessageId?: string | null;
    sender?: IncomingSender;
    text?: string | null;
}

/**
 * A message as Core sees it, whatever the transport.
 *
 * `id` is the inbound idempotency key: `${transport}:${endpoint.id}:${transportMessageId}`.
 * It deliberately does not mention the space — a binding may re-point an endpoint at a
 * different space, and a replayed event must stay deduplicated across that change.
 */
export interface IncomingMessage {
    id: string;

    transport: string;

    endpoint: {
        id: string;
        type: string;
    };

    threadId?: string;

    sender: IncomingSender;

    content: {
        text?: string;
        attachments?: IncomingAttachment[];
    };

    replyTo?: IncomingReplyContext;

    timestamp: string;

    /** Threads through the whole pipeline so one turn can be traced end to end. */
    correlationId: string;

    /**
     * Transport-specific data that must not influence Core behavior.
     * Core never reads `metadata.telegram`, `metadata.discord`, and so on.
     */
    metadata?: Record<string, unknown>;
}

// ==========================================
// Outbound
// ==========================================

export interface OutgoingAttachment {
    /**
     * Path under DATA_DIR. Outbox entries survive restarts, so payloads reference
     * durable files rather than carrying bytes; a file that has vanished by send
     * time is a permanent failure, not a retry.
     */
    localPath: string;
    filename?: string;
    caption?: string;
    mimeType?: string;
}

export interface OutgoingMessage {
    id: string;

    content: {
        text?: string;
        attachments?: OutgoingAttachment[];
    };

    replyTo?: {
        internalMessageId?: string;
        transportMessageId?: string;
    };

    formatting?: {
        mode: 'plain' | 'markdown';
    };

    delivery?: {
        allowStreaming?: boolean;
        silent?: boolean;
        /** Telegram-style pinning; adapters without pins ignore it. */
        pin?: boolean;
        unpinAfterHours?: number;
    };

    metadata?: Record<string, unknown>;
}

// ==========================================
// Destinations and capabilities
// ==========================================

export interface TransportDestination {
    endpointId: string;
    endpointType: string;
    threadId?: string;
}

export interface TransportCapabilities {
    markdown: boolean;
    attachments: boolean;
    images: boolean;
    audio: boolean;
    voice: boolean;

    streaming: boolean;
    messageEditing: boolean;

    reactions: boolean;
    threads: boolean;
    replies: boolean;

    maxTextLength?: number;
    maxAttachmentSizeBytes?: number;
}

/** A physical delivery — one OutgoingMessage may render into several of these. */
export interface RenderedDelivery {
    text?: string;
    attachment?: OutgoingAttachment;
    replyToTransportMessageId?: string;
    silent?: boolean;
    pin?: boolean;
    unpinAfterHours?: number;
}

export type DeliveryStatus = 'sent' | 'retryable_error' | 'permanent_error';

export interface DeliveryResult {
    status: DeliveryStatus;
    transportMessageId?: string;
    error?: string;
}

// ==========================================
// Adapter contract
// ==========================================

/**
 * What a transport hands to the gateway, and what the gateway hands back.
 * Adapters receive this instead of importing Core modules directly.
 */
export interface TransportRuntimeContext {
    messageGateway: {
        handleIncoming(message: IncomingMessage): Promise<void>;
    };
}

export interface TransportAdapter {
    readonly name: string;

    start(context: TransportRuntimeContext): Promise<void>;

    stop(): Promise<void>;

    send(destination: TransportDestination, message: OutgoingMessage): Promise<DeliveryResult>;

    getCapabilities(destination?: TransportDestination): Promise<TransportCapabilities>;
}

/** Capabilities for a transport that can do nothing but send plain text. */
export const MINIMAL_TRANSPORT_CAPABILITIES: TransportCapabilities = {
    markdown: false,
    attachments: false,
    images: false,
    audio: false,
    voice: false,
    streaming: false,
    messageEditing: false,
    reactions: false,
    threads: false,
    replies: false,
};

// ==========================================
// Agent output events
// ==========================================

/**
 * What a transport may learn about a run in progress.
 *
 * The union is complete on purpose: `text_delta` has no producer yet (the model
 * layer returns a final string today), but declaring it now means adding
 * streaming later changes the producer only, never this contract or its
 * consumers. Chain of thought is never exposed — `status` carries neutral
 * labels like "thinking" or "running tool".
 */
export type AgentOutputEvent =
    | { type: 'status'; label: string }
    | { type: 'text_delta'; text: string }
    | { type: 'tool_started'; toolName: string }
    | { type: 'tool_finished'; toolName: string }
    | { type: 'final'; message: OutgoingMessage }
    | { type: 'error'; error: string };

// ==========================================
// Helpers
// ==========================================

/**
 * The inbound idempotency key. Built from transport facts only, so a replayed
 * event stays deduplicated even if its endpoint is later bound to another space.
 *
 * The format matches the legacy `${spaceId}:${messageId}` ids byte for byte,
 * because a legacy space id is itself `${channel}:${externalRef}`. Existing
 * message rows therefore need no rewrite.
 */
export function buildIncomingMessageId(transport: string, endpointId: string, transportMessageId: string): string {
    return `${transport}:${endpointId}:${transportMessageId}`;
}

/**
 * SQLite treats NULLs as distinct in unique indexes, so an absent thread is
 * stored as an empty string to keep "one binding per endpoint" enforceable.
 */
export function normalizeThreadId(threadId?: string | null): string {
    return threadId ? String(threadId) : '';
}
