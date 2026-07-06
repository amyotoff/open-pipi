import { getActiveTraceContext } from '../observability';

type LogMeta = Record<string, unknown>;

function truncate(value: string, max: number = 140): string {
    return value.length > max ? `${value.substring(0, max)}...` : value;
}

function serialize(value: unknown): string {
    if (value === undefined) return '';
    if (value === null) return 'null';
    if (typeof value === 'string') return truncate(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);

    try {
        return truncate(JSON.stringify(value));
    } catch {
        return '[unserializable]';
    }
}

function formatMeta(meta?: LogMeta): string {
    const pairs = Object.entries(meta || {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${serialize(value)}`)
        .filter(Boolean);

    const traceContext = getActiveTraceContext();
    if (traceContext.traceId) {
        pairs.push(`trace_id=${traceContext.traceId}`);
    }
    if (traceContext.spanId) {
        pairs.push(`span_id=${traceContext.spanId}`);
    }

    return pairs.length > 0 ? ` ${pairs.join(' ')}` : '';
}

export function summarizeText(text?: string | null): LogMeta {
    const value = text || '';
    const trimmed = value.trim();
    return {
        has_text: trimmed.length > 0,
        text_chars: value.length,
        text_lines: value.length === 0 ? 0 : value.split(/\r?\n/).length,
    };
}

export function summarizeError(error: unknown): LogMeta {
    if (error instanceof Error) {
        return {
            error_name: error.name,
            error_message: error.message,
        };
    }

    return {
        error_message: typeof error === 'string' ? error : String(error),
    };
}

export function logInfo(scope: string, event: string, meta?: LogMeta): void {
    console.log(`[${scope}] ${event}${formatMeta(meta)}`);
}

export function logWarn(scope: string, event: string, meta?: LogMeta): void {
    console.warn(`[${scope}] ${event}${formatMeta(meta)}`);
}

export function logError(scope: string, event: string, meta?: LogMeta): void {
    console.error(`[${scope}] ${event}${formatMeta(meta)}`);
}
