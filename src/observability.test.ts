import { describe, expect, it } from 'vitest';
import {
    addSpanAttributes,
    addSpanEvent,
    getActiveTraceContext,
    initializeOpenTelemetry,
    parseOtelHeaders,
    recordActiveSpanException,
    recordInboundMessage,
    recordLlmRequest,
    recordToolCallTelemetry,
    resolveOtlpEndpoint,
    sanitizeAttributes,
    shutdownOpenTelemetry,
    withSpan,
} from './observability';

describe('observability helpers', () => {
    it('parses OTLP headers from env syntax', () => {
        expect(parseOtelHeaders('authorization=Bearer abc,x-tenant=demo')).toEqual({
            authorization: 'Bearer abc',
            'x-tenant': 'demo',
        });
    });

    it('ignores malformed header entries', () => {
        expect(parseOtelHeaders('missing-separator,good=value,empty=')).toEqual({
            good: 'value',
        });
    });

    it('returns undefined for empty or missing header values', () => {
        expect(parseOtelHeaders(undefined)).toBeUndefined();
        expect(parseOtelHeaders('')).toBeUndefined();
    });

    it('resolves signal-specific OTLP endpoints from a base collector URL', () => {
        expect(resolveOtlpEndpoint('http://collector:4318', 'traces')).toBe('http://collector:4318/v1/traces');
        expect(resolveOtlpEndpoint('http://collector:4318/', 'metrics')).toBe('http://collector:4318/v1/metrics');
    });

    it('preserves already signal-specific OTLP endpoints', () => {
        expect(resolveOtlpEndpoint('http://collector:4318/v1/traces', 'traces')).toBe(
            'http://collector:4318/v1/traces'
        );
    });

    it('returns undefined for empty or missing endpoints', () => {
        expect(resolveOtlpEndpoint(undefined, 'traces')).toBeUndefined();
        expect(resolveOtlpEndpoint('', 'traces')).toBeUndefined();
        expect(resolveOtlpEndpoint('   ', 'traces')).toBeUndefined();
    });

    it('sanitizes span attributes into OpenTelemetry-safe values', () => {
        expect(
            sanitizeAttributes({
                ok: true,
                count: 3,
                text: 'hello',
                missing: undefined,
                nested: { nope: true } as any,
                list: ['a', 'b'],
            })
        ).toEqual({
            ok: true,
            count: 3,
            text: 'hello',
            nested: '[object Object]',
            list: ['a', 'b'],
        });
    });

    it('returns undefined when all attributes are null/undefined', () => {
        expect(sanitizeAttributes({ a: undefined, b: null as any })).toBeUndefined();
        expect(sanitizeAttributes(undefined)).toBeUndefined();
    });

    it('sanitizes homogeneous number and boolean arrays', () => {
        expect(sanitizeAttributes({ nums: [1, 2, 3], bools: [true, false] })).toEqual({
            nums: [1, 2, 3],
            bools: [true, false],
        });
    });

    it('stringifies mixed-type arrays', () => {
        expect(sanitizeAttributes({ mixed: [1, 'a', true] as any })).toEqual({
            mixed: '1,a,true',
        });
    });
});

describe('withSpan', () => {
    it('returns the callback result on success', async () => {
        const result = await withSpan('test.success', undefined, async () => 42);
        expect(result).toBe(42);
    });

    it('propagates errors from the callback', async () => {
        await expect(
            withSpan('test.error', undefined, async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
    });

    it('works with synchronous callbacks', async () => {
        const result = await withSpan('test.sync', undefined, () => 'sync-value');
        expect(result).toBe('sync-value');
    });

    it('passes span options through', async () => {
        const result = await withSpan('test.with-attrs', { attributes: { key: 'value', count: 5 } }, async () => 'ok');
        expect(result).toBe('ok');
    });
});

describe('span context helpers (no active span)', () => {
    it('getActiveTraceContext returns empty object without an active span', () => {
        expect(getActiveTraceContext()).toEqual({});
    });

    it('addSpanAttributes does not throw without an active span', () => {
        expect(() => addSpanAttributes({ key: 'value' })).not.toThrow();
    });

    it('addSpanEvent does not throw without an active span', () => {
        expect(() => addSpanEvent('test.event', { key: 'value' })).not.toThrow();
    });

    it('recordActiveSpanException does not throw without an active span', () => {
        expect(() => recordActiveSpanException(new Error('test'))).not.toThrow();
    });
});

describe('metric recording functions', () => {
    it('recordInboundMessage does not throw', () => {
        expect(() => recordInboundMessage({ channel: 'test' }, 42)).not.toThrow();
    });

    it('recordLlmRequest does not throw', () => {
        expect(() => recordLlmRequest(100, { provider: 'gemini', model: 'flash', status: 'ok' })).not.toThrow();
    });

    it('recordToolCallTelemetry does not throw', () => {
        expect(() => recordToolCallTelemetry(50, { tool_name: 'test_tool', status: 'ok' })).not.toThrow();
    });
});

describe('telemetry lifecycle', () => {
    it('initializeOpenTelemetry is a no-op when OTEL env vars are not set', async () => {
        await expect(initializeOpenTelemetry({ serviceName: 'test-service' })).resolves.toBeUndefined();
    });

    it('shutdownOpenTelemetry is a no-op when SDK was never started', async () => {
        await expect(shutdownOpenTelemetry()).resolves.toBeUndefined();
    });
});
