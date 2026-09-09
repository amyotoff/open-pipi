/** Provider-neutral JSON Schema subset shared by skills and the inference gateway. */
export enum Type {
    STRING = 'string',
    NUMBER = 'number',
    INTEGER = 'integer',
    BOOLEAN = 'boolean',
    ARRAY = 'array',
    OBJECT = 'object',
    NULL = 'null',
}

export interface Schema {
    type?: string;
    description?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
    required?: string[];
    enum?: string[];
    [key: string]: unknown;
}

export interface FunctionDeclaration {
    name?: string;
    description?: string;
    parameters?: Schema;
}

export type LLMProvider = 'openrouter' | 'openai' | 'anthropic' | 'gemini';
export interface LLMToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}
export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    images?: Array<{ data: string; mimeType: string }>;
    toolCalls?: LLMToolCall[];
    toolCallId?: string;
    toolName?: string;
    /** Opaque continuation state. Only the originating provider/model may read it. */
    providerState?: { provider: LLMProvider; model: string; value: unknown };
}
export interface LLMRequest {
    model: string;
    provider?: LLMProvider;
    messages: LLMMessage[];
    tools?: FunctionDeclaration[];
    toolChoice?: 'none';
    temperature?: number;
    reasoning?: 'minimal' | 'high';
    maxTokens?: number;
    timeoutMs?: number;
    webSearch?: boolean;
}
export interface LLMResponse {
    text: string;
    toolCalls: LLMToolCall[];
    message: LLMMessage;
    finishReason?: string;
    usage: { inputTokens: number; outputTokens: number; costUsd?: number };
    sources: Array<{ title: string; url: string }>;
}
