/**
 * How the Brain Layer talks to a model, and what happens when the budget runs out.
 *
 * The import is deliberately lazy. `llm.ts` reaches the skill registry through the tool
 * executor, and the registry loads `brain.skill.ts`, so a static import here would close
 * the cycle llm → tool-executor → skills → brain-ingest → llm. Resolving the module at
 * call time keeps the graph acyclic at load time and makes the model easy to stub in tests.
 */

export type BrainModelMode = 'executor' | 'advisor';

export interface BrainModelRequest {
    system: string;
    prompt: string;
    mode: BrainModelMode;
    spaceId?: string;
    temperature?: number;
}

/**
 * Raised when the daily model budget is gone or no model is configured.
 * Callers leave the work queued rather than dropping it: a source with no page is a lint
 * finding, which is the correct visible end state (D13 in docs/brain-wiki-plan.md).
 */
export class BrainBudgetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrainBudgetError';
    }
}

/** A provider/network failure that should be tried again without consuming a model-output attempt. */
export class BrainTransientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrainTransientError';
    }
}

const TRANSIENT_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ERR_NETWORK',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
]);
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_MESSAGE_RE =
    /(?:fetch failed|network error|socket hang up|timed?\s*out|timeout|temporar(?:y|ily) unavailable|too many requests|rate[ -]?limit|service unavailable|connection (?:reset|refused)|\b(?:408|425|429|500|502|503|504)\b)/i;

/** Classify provider errors defensively: SDKs expose status/code in several different shapes. */
export function isTransientBrainModelError(error: unknown): boolean {
    if (error instanceof BrainTransientError) return true;
    if (!error || typeof error !== 'object') return TRANSIENT_MESSAGE_RE.test(String(error || ''));

    const record = error as Record<string, any>;
    const code = String(record.code || record.cause?.code || '').toUpperCase();
    const status = Number(record.status ?? record.statusCode ?? record.response?.status ?? record.cause?.status);
    const name = String(record.name || '');
    const message = [record.message, record.cause?.message].filter(Boolean).join(' ');

    return (
        TRANSIENT_ERROR_CODES.has(code) ||
        TRANSIENT_STATUS_CODES.has(status) ||
        name === 'AbortError' ||
        TRANSIENT_MESSAGE_RE.test(message)
    );
}

export async function generateBrainText(request: BrainModelRequest): Promise<string> {
    const { GEMINI_API_KEY } = await import('../config');
    if (!GEMINI_API_KEY?.trim()) {
        throw new BrainBudgetError('no model is configured for this install');
    }

    const { generateOneShotText } = await import('./llm');
    try {
        const { text, blocked } = await generateOneShotText(request);
        if (blocked) {
            if (isTransientBrainModelError(blocked)) throw new BrainTransientError(blocked);
            throw new BrainBudgetError(blocked);
        }
        return text;
    } catch (error: any) {
        if (error instanceof BrainBudgetError || error instanceof BrainTransientError) throw error;
        if (isTransientBrainModelError(error)) {
            throw new BrainTransientError(String(error?.message || error));
        }
        throw error;
    }
}

/** Models wrap JSON in code fences more often than not. */
export function parseModelJson<T>(text: string): T | null {
    const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;

    try {
        return JSON.parse(cleaned.substring(start, end + 1)) as T;
    } catch {
        return null;
    }
}
