import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';
export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 5;

type FetchLike = typeof fetch;
type RandomBytes = (size: number) => Uint8Array;

export type SetupProviderErrorCode =
    | 'invalid_input'
    | 'oauth_expired'
    | 'oauth_rejected'
    | 'provider_auth'
    | 'provider_payment'
    | 'provider_unavailable'
    | 'provider_response'
    | 'telegram_auth'
    | 'telegram_webhook_active'
    | 'telegram_poll_conflict'
    | 'telegram_unavailable';

export class SetupProviderError extends Error {
    constructor(
        readonly code: SetupProviderErrorCode,
        message: string,
        readonly action: string,
        readonly retryable = true
    ) {
        super(message);
        this.name = 'SetupProviderError';
    }
}

export type OpenRouterOAuthAttempt = {
    state: string;
    verifier: string;
    callbackUrl: string;
    authorizationUrl: string;
    expiresAt: number;
};

export type OpenRouterValidation = {
    model: string;
    textReady: true;
    toolRoundTripReady: true;
};

export type TelegramBotIdentity = {
    id: string;
    username: string;
    firstName: string;
};

export type TelegramConnection = {
    bot: TelegramBotIdentity;
    webhookActive: boolean;
    pendingUpdateCount: number;
};

export type TelegramOwnerCandidate = {
    id: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
};

export type ProviderRequestOptions = {
    fetch?: FetchLike;
    timeoutMs?: number;
};

function base64Url(value: Uint8Array): string {
    return Buffer.from(value).toString('base64url');
}

function readObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new SetupProviderError(
            'provider_response',
            'The provider returned an unexpectedly large response.',
            'Try the connection again.'
        );
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    if (response.body) {
        const reader = response.body.getReader();
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > MAX_PROVIDER_RESPONSE_BYTES) {
                await reader.cancel();
                throw new SetupProviderError(
                    'provider_response',
                    'The provider returned an unexpectedly large response.',
                    'Try the connection again.'
                );
            }
            chunks.push(chunk.value);
        }
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');

    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new SetupProviderError(
            'provider_response',
            'The provider returned an unreadable response.',
            'Try the connection again.'
        );
    }
}

async function requestJson(
    url: string,
    init: RequestInit,
    options: ProviderRequestOptions,
    unavailable: SetupProviderError
): Promise<{ response: Response; data: unknown }> {
    const requestFetch = options.fetch || fetch;
    try {
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
        const response = await requestFetch(url, {
            ...init,
            signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
        });
        return { response, data: await readBoundedJson(response) };
    } catch (error) {
        if (error instanceof SetupProviderError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
            throw new SetupProviderError(unavailable.code, 'The connection check timed out.', unavailable.action);
        }
        throw unavailable;
    }
}

function openRouterHttpError(status: number): SetupProviderError {
    if (status === 401 || status === 403) {
        return new SetupProviderError(
            'provider_auth',
            'OpenRouter did not accept this connection.',
            'Reconnect OpenRouter or enter a different API key.'
        );
    }
    if (status === 402) {
        return new SetupProviderError(
            'provider_payment',
            'OpenRouter needs available credit before PiPi can answer.',
            'Add credit in OpenRouter, then retry the connection check.'
        );
    }
    return new SetupProviderError(
        'provider_unavailable',
        'OpenRouter could not complete the connection check.',
        'Try again in a moment.'
    );
}

export function createOpenRouterOAuthAttempt(input: {
    callbackBaseUrl: string;
    now?: number;
    randomBytes?: RandomBytes;
}): OpenRouterOAuthAttempt {
    const callbackBase = new URL(input.callbackBaseUrl);
    if (callbackBase.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callbackBase.hostname)) {
        throw new SetupProviderError(
            'invalid_input',
            'OpenRouter setup requires a localhost callback.',
            'Open setup on this computer and try again.',
            false
        );
    }

    const makeBytes = input.randomBytes || nodeRandomBytes;
    const state = base64Url(makeBytes(24));
    const verifier = base64Url(makeBytes(48));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const callbackUrl = new URL(`./api/setup/openrouter/callback/${state}`, callbackBase).toString();
    const authorizationUrl = new URL(OPENROUTER_AUTH_URL);
    authorizationUrl.searchParams.set('callback_url', callbackUrl);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');

    return {
        state,
        verifier,
        callbackUrl,
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: (input.now ?? Date.now()) + OAUTH_ATTEMPT_TTL_MS,
    };
}

export async function exchangeOpenRouterCode(
    code: string,
    attempt: OpenRouterOAuthAttempt,
    options: ProviderRequestOptions = {}
): Promise<string> {
    const normalizedCode = code.trim();
    if (!normalizedCode || normalizedCode.length > 4096) {
        throw new SetupProviderError(
            'oauth_rejected',
            'OpenRouter did not return a valid code.',
            'Start sign-in again.'
        );
    }

    const { response, data } = await requestJson(
        OPENROUTER_KEY_EXCHANGE_URL,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                code: normalizedCode,
                code_verifier: attempt.verifier,
                code_challenge_method: 'S256',
            }),
        },
        options,
        new SetupProviderError(
            'provider_unavailable',
            'OpenRouter sign-in could not be completed.',
            'Start sign-in again.'
        )
    );
    if (!response.ok) throw openRouterHttpError(response.status);

    const key = readObject(data)?.key;
    if (typeof key !== 'string' || !key.trim() || key.length > 4096) {
        throw new SetupProviderError(
            'provider_response',
            'OpenRouter sign-in completed without a usable key.',
            'Start sign-in again.'
        );
    }
    return key.trim();
}

function assertManualOpenRouterKey(key: string): string {
    const normalized = key.trim();
    if (!normalized || normalized.length > 4096 || /\s/.test(normalized)) {
        throw new SetupProviderError(
            'invalid_input',
            'Enter a valid OpenRouter API key.',
            'Copy the key from OpenRouter and paste it into the private field.',
            false
        );
    }
    return normalized;
}

function parseToolCall(data: unknown): { message: Record<string, unknown>; id: string } {
    const choice = Array.isArray(readObject(data)?.choices) ? (readObject(data)?.choices as unknown[])[0] : null;
    const message = readObject(readObject(choice)?.message);
    const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const call = readObject(calls[0]);
    const fn = readObject(call?.function);
    let args: unknown;
    try {
        args = typeof fn?.arguments === 'string' ? JSON.parse(fn.arguments) : fn?.arguments;
    } catch {
        args = null;
    }
    if (
        !message ||
        calls.length !== 1 ||
        typeof call?.id !== 'string' ||
        fn?.name !== 'pipi_setup_probe' ||
        readObject(args)?.value !== 'ready'
    ) {
        throw new SetupProviderError(
            'provider_response',
            'The selected model did not complete the tool-call check.',
            'Retry, or choose a model that supports tool calls.'
        );
    }
    return { message, id: call.id };
}

function parseAssistantText(data: unknown): string {
    const choice = Array.isArray(readObject(data)?.choices) ? (readObject(data)?.choices as unknown[])[0] : null;
    const content = readObject(readObject(choice)?.message)?.content;
    return typeof content === 'string' ? content.trim() : '';
}

export async function validateOpenRouterConnection(
    input: { apiKey: string; model?: string },
    options: ProviderRequestOptions = {}
): Promise<OpenRouterValidation> {
    const apiKey = assertManualOpenRouterKey(input.apiKey);
    const model = input.model?.trim() || DEFAULT_OPENROUTER_MODEL;
    const headers = {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
    };
    const initialMessages = [
        {
            role: 'user',
            content: 'Call pipi_setup_probe exactly once with value "ready". Do not answer before calling it.',
        },
    ];
    const tool = {
        type: 'function',
        function: {
            name: 'pipi_setup_probe',
            description: 'A harmless local setup connectivity probe.',
            parameters: {
                type: 'object',
                properties: { value: { type: 'string', enum: ['ready'] } },
                required: ['value'],
                additionalProperties: false,
            },
        },
    };

    const first = await requestJson(
        OPENROUTER_CHAT_URL,
        {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: initialMessages,
                tools: [tool],
                tool_choice: { type: 'function', function: { name: 'pipi_setup_probe' } },
                max_tokens: 96,
                temperature: 0,
            }),
        },
        options,
        openRouterHttpError(503)
    );
    if (!first.response.ok) throw openRouterHttpError(first.response.status);
    const toolCall = parseToolCall(first.data);

    const second = await requestJson(
        OPENROUTER_CHAT_URL,
        {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: [
                    ...initialMessages,
                    toolCall.message,
                    {
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify({ ok: true, value: 'ready' }),
                    },
                ],
                tools: [tool],
                tool_choice: 'none',
                max_tokens: 64,
                temperature: 0,
            }),
        },
        options,
        openRouterHttpError(503)
    );
    if (!second.response.ok) throw openRouterHttpError(second.response.status);
    if (!parseAssistantText(second.data)) {
        throw new SetupProviderError(
            'provider_response',
            'The selected model did not return text after the tool check.',
            'Retry, or choose a model that supports text and tool calls.'
        );
    }

    return { model, textReady: true, toolRoundTripReady: true };
}

function telegramHttpError(status: number): SetupProviderError {
    if (status === 401 || status === 404) {
        return new SetupProviderError(
            'telegram_auth',
            'Telegram did not accept this bot token.',
            'Copy a fresh token from BotFather and try again.'
        );
    }
    if (status === 409) {
        return new SetupProviderError(
            'telegram_poll_conflict',
            'Another process is already receiving updates for this bot.',
            'Stop the other bot process, then retry.'
        );
    }
    return new SetupProviderError(
        'telegram_unavailable',
        'Telegram could not complete the connection check.',
        'Check the connection and try again.'
    );
}

function telegramToken(value: string): string {
    const normalized = value.trim();
    if (!/^\d{4,}:[A-Za-z0-9_-]{20,}$/.test(normalized) || normalized.length > 256) {
        throw new SetupProviderError(
            'invalid_input',
            'Enter a valid Telegram bot token.',
            'Copy the complete token from BotFather and paste it into the private field.',
            false
        );
    }
    return normalized;
}

async function telegramRequest(
    token: string,
    method: 'getMe' | 'getWebhookInfo' | 'getUpdates',
    body: Record<string, unknown> | undefined,
    options: ProviderRequestOptions & { signal?: AbortSignal }
): Promise<Record<string, unknown>> {
    const { response, data } = await requestJson(
        `https://api.telegram.org/bot${telegramToken(token)}/${method}`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
        },
        options,
        telegramHttpError(503)
    );
    if (!response.ok) throw telegramHttpError(response.status);
    const envelope = readObject(data);
    if (envelope?.ok !== true || envelope.result === undefined || envelope.result === null) {
        throw new SetupProviderError(
            'provider_response',
            'Telegram returned an unreadable response.',
            'Try the Telegram connection again.'
        );
    }
    return envelope;
}

export async function validateTelegramConnection(
    token: string,
    options: ProviderRequestOptions = {}
): Promise<TelegramConnection> {
    const meEnvelope = await telegramRequest(token, 'getMe', undefined, options);
    const me = readObject(meEnvelope.result);
    if (!me || typeof me.id !== 'number' || me.is_bot !== true || typeof me.username !== 'string') {
        throw new SetupProviderError(
            'provider_response',
            'Telegram did not return a valid bot identity.',
            'Try the Telegram connection again.'
        );
    }

    const webhookEnvelope = await telegramRequest(token, 'getWebhookInfo', undefined, options);
    const webhook = readObject(webhookEnvelope.result);
    if (!webhook) {
        throw new SetupProviderError(
            'provider_response',
            'Telegram did not return webhook status.',
            'Try the Telegram connection again.'
        );
    }
    const webhookActive = typeof webhook.url === 'string' && webhook.url.length > 0;

    return {
        bot: {
            id: String(me.id),
            username: me.username,
            firstName: typeof me.first_name === 'string' ? me.first_name : me.username,
        },
        webhookActive,
        pendingUpdateCount:
            typeof webhook.pending_update_count === 'number' && webhook.pending_update_count >= 0
                ? webhook.pending_update_count
                : 0,
    };
}

function parsePairingCandidate(update: unknown, nonce: string, botUsername: string): TelegramOwnerCandidate | null {
    const message = readObject(readObject(update)?.message);
    const chat = readObject(message?.chat);
    const from = readObject(message?.from);
    if (!message || !chat || !from || chat.type !== 'private') return null;
    if ((typeof from.id !== 'number' && typeof from.id !== 'string') || String(chat.id) !== String(from.id))
        return null;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const match = text.match(/^\/start(?:@([A-Za-z0-9_]{3,}))?\s+([A-Za-z0-9_-]{16,64})$/);
    if (!match || match[2] !== nonce) return null;
    if (match[1] && match[1].toLowerCase() !== botUsername.toLowerCase()) return null;

    return {
        id: String(from.id),
        ...(typeof from.username === 'string' ? { username: from.username } : {}),
        ...(typeof from.first_name === 'string' ? { firstName: from.first_name } : {}),
        ...(typeof from.last_name === 'string' ? { lastName: from.last_name } : {}),
        ...(typeof from.language_code === 'string' ? { languageCode: from.language_code } : {}),
    };
}

export function createTelegramPairingNonce(randomBytes: RandomBytes = nodeRandomBytes): string {
    return base64Url(randomBytes(24));
}

export function buildTelegramPairingLink(botUsername: string, nonce: string): string {
    if (!/^[A-Za-z0-9_]{3,}$/.test(botUsername) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        throw new SetupProviderError(
            'invalid_input',
            'Could not create the Telegram pairing link.',
            'Reconnect Telegram.'
        );
    }
    return `https://t.me/${botUsername}?start=${nonce}`;
}

export async function pollTelegramOwnerCandidate(input: {
    token: string;
    botUsername: string;
    nonce: string;
    expiresAt: number;
    signal: AbortSignal;
    onCandidate: (candidate: TelegramOwnerCandidate) => void | Promise<void>;
    fetch?: FetchLike;
    now?: () => number;
}): Promise<void> {
    const now = input.now || Date.now;
    let offset: number | undefined;

    while (!input.signal.aborted && now() < input.expiresAt) {
        const envelope = await telegramRequest(
            input.token,
            'getUpdates',
            {
                timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
                allowed_updates: ['message'],
                ...(offset === undefined ? {} : { offset }),
            },
            {
                fetch: input.fetch,
                signal: input.signal,
                timeoutMs: (TELEGRAM_POLL_TIMEOUT_SECONDS + 3) * 1000,
            }
        );
        const updates = Array.isArray(envelope.result) ? envelope.result : [];
        for (const update of updates) {
            const updateId = readObject(update)?.update_id;
            if (typeof updateId === 'number') offset = Math.max(offset ?? 0, updateId + 1);
            const candidate = parsePairingCandidate(update, input.nonce, input.botUsername);
            if (candidate) {
                await input.onCandidate(candidate);
                return;
            }
        }
    }
}
