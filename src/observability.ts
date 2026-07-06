import os from 'os';
import {
    Attributes,
    context,
    diag,
    DiagConsoleLogger,
    DiagLogLevel,
    metrics,
    Span,
    SpanOptions,
    SpanStatusCode,
    trace,
} from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

type TelemetryInitOptions = {
    serviceName: string;
    serviceNamespace?: string;
    serviceVersion?: string;
};

type TraceContext = {
    traceId?: string;
    spanId?: string;
};

const tracer = trace.getTracer('open-pipi');
const meter = metrics.getMeter('open-pipi');

const inboundMessagesCounter = meter.createCounter('pipi.inbound_messages', {
    description: 'Inbound normalized messages seen by the shared router.',
    unit: '{message}',
});

const inboundMessageCharsHistogram = meter.createHistogram('pipi.inbound_message_chars', {
    description: 'Inbound normalized message size in characters.',
    unit: '{character}',
});

const llmRequestsCounter = meter.createCounter('pipi.llm_requests', {
    description: 'LLM and vision requests issued by the assistant runtime.',
    unit: '{request}',
});

const llmDurationHistogram = meter.createHistogram('pipi.llm_duration', {
    description: 'End-to-end LLM request duration.',
    unit: 'ms',
});

const toolCallsCounter = meter.createCounter('pipi.tool_calls', {
    description: 'Tool calls executed by the runtime.',
    unit: '{call}',
});

const toolDurationHistogram = meter.createHistogram('pipi.tool_duration', {
    description: 'End-to-end tool execution duration.',
    unit: 'ms',
});

let sdk: NodeSDK | null = null;
let startupPromise: Promise<void> | null = null;
let telemetryStarted = false;

/** Tracks spans where recordSpanException was called, so withSpan won't override ERROR with OK. */
const spansWithRecordedErrors = new WeakSet<Span>();

function readFlag(name: string): boolean | undefined {
    const raw = process.env[name];
    if (!raw) return undefined;

    const value = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return undefined;
}

function readPositiveInt(name: string, fallback: number): number {
    const raw = Number(process.env[name] || '');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function parseOtelHeaders(value?: string): Record<string, string> | undefined {
    if (!value) return undefined;

    const headers = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .reduce<Record<string, string>>((acc, entry) => {
            const separator = entry.indexOf('=');
            if (separator <= 0) return acc;

            const key = entry.slice(0, separator).trim();
            const headerValue = entry.slice(separator + 1).trim();
            if (!key || !headerValue) return acc;

            acc[key] = headerValue;
            return acc;
        }, {});

    return Object.keys(headers).length > 0 ? headers : undefined;
}

export function resolveOtlpEndpoint(endpoint: string | undefined, signal: 'traces' | 'metrics'): string | undefined {
    if (!endpoint) return undefined;

    const normalized = endpoint.trim().replace(/\/+$/, '');
    if (!normalized) return undefined;

    if (/\/v1\/(traces|metrics)$/.test(normalized)) {
        return normalized;
    }

    return `${normalized}/v1/${signal}`;
}

export function sanitizeAttributes(attributes?: Attributes): Attributes | undefined {
    if (!attributes) return undefined;

    const sanitized: Attributes = {};

    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined || value === null) continue;

        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            sanitized[key] = value;
            continue;
        }

        if (Array.isArray(value)) {
            const filtered = value.filter((item) => item !== null && item !== undefined);
            if (filtered.every((item) => typeof item === 'string')) {
                sanitized[key] = filtered as string[];
                continue;
            }
            if (filtered.every((item) => typeof item === 'number')) {
                sanitized[key] = filtered as number[];
                continue;
            }
            if (filtered.every((item) => typeof item === 'boolean')) {
                sanitized[key] = filtered as boolean[];
                continue;
            }

            sanitized[key] = String(value);
            continue;
        }

        sanitized[key] = String(value);
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function configureDiagnostics(): void {
    const level = (process.env.OTEL_DIAGNOSTIC_LOG_LEVEL || '').trim().toLowerCase();
    if (!level) return;

    const mapping: Record<string, DiagLogLevel> = {
        all: DiagLogLevel.ALL,
        verbose: DiagLogLevel.VERBOSE,
        debug: DiagLogLevel.DEBUG,
        info: DiagLogLevel.INFO,
        warn: DiagLogLevel.WARN,
        error: DiagLogLevel.ERROR,
        none: DiagLogLevel.NONE,
    };

    const diagLevel = mapping[level];
    if (diagLevel !== undefined) {
        diag.setLogger(new DiagConsoleLogger(), diagLevel);
    }
}

function createResource(options: TelemetryInitOptions) {
    return resourceFromAttributes(
        sanitizeAttributes({
            'service.name': options.serviceName,
            'service.namespace': options.serviceNamespace,
            'service.version': options.serviceVersion,
            'service.instance.id': `${os.hostname()}-${process.pid}`,
            'deployment.environment.name': process.env.NODE_ENV,
        }) || {}
    );
}

function isTelemetryConfigured(): boolean {
    const enabled = readFlag('OTEL_ENABLED');
    if (enabled === false) return false;

    return Boolean(
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
        process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    );
}

export async function initializeOpenTelemetry(options: TelemetryInitOptions): Promise<void> {
    if (telemetryStarted) return;
    if (startupPromise) {
        await startupPromise;
        return;
    }

    startupPromise = (async () => {
        if (!isTelemetryConfigured()) {
            startupPromise = null;
            return;
        }

        configureDiagnostics();

        const headers = parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
        const tracesUrl =
            process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
            resolveOtlpEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'traces');
        const metricsUrl =
            process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
            resolveOtlpEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'metrics');

        const traceExporter = tracesUrl ? new OTLPTraceExporter({ url: tracesUrl, headers }) : undefined;
        const metricReader = metricsUrl
            ? new PeriodicExportingMetricReader({
                  exporter: new OTLPMetricExporter({ url: metricsUrl, headers }),
                  exportIntervalMillis: readPositiveInt('OTEL_METRIC_EXPORT_INTERVAL', 15000),
              })
            : undefined;

        if (!traceExporter && !metricReader) {
            startupPromise = null;
            return;
        }

        sdk = new NodeSDK({
            resource: createResource(options),
            traceExporter,
            metricReader,
            instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
        });

        await Promise.resolve(sdk.start());
        telemetryStarted = true;
        console.log(
            `[OTEL] Enabled for ${options.serviceName} traces=${traceExporter ? 'on' : 'off'} metrics=${metricReader ? 'on' : 'off'}`
        );
        startupPromise = null;
    })();

    await startupPromise;
}

const SHUTDOWN_TIMEOUT_MS = 5000;

export async function shutdownOpenTelemetry(): Promise<void> {
    if (!sdk) return;

    const activeSdk = sdk;
    sdk = null;
    telemetryStarted = false;
    startupPromise = null;
    await Promise.race([
        activeSdk.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
}

export async function withSpan<T>(
    name: string,
    options: (SpanOptions & { attributes?: Attributes }) | undefined,
    fn: (span: Span) => Promise<T> | T
): Promise<T> {
    const spanOptions: SpanOptions = options
        ? {
              ...options,
              attributes: sanitizeAttributes(options.attributes),
          }
        : {};

    return await tracer.startActiveSpan(name, spanOptions, async (span) => {
        try {
            const result = await fn(span);
            if (!spansWithRecordedErrors.has(span)) {
                span.setStatus({ code: SpanStatusCode.OK });
            }
            return result;
        } catch (error) {
            recordSpanException(span, error);
            throw error;
        } finally {
            span.end();
        }
    });
}

export function addSpanAttributes(attributes?: Attributes): void {
    const span = trace.getSpan(context.active());
    if (!span || !attributes) return;
    span.setAttributes(sanitizeAttributes(attributes) || {});
}

export function addSpanEvent(name: string, attributes?: Attributes): void {
    const span = trace.getSpan(context.active());
    if (!span) return;
    span.addEvent(name, sanitizeAttributes(attributes));
}

export function recordSpanException(span: Span, error: unknown, attributes?: Attributes): void {
    const err = error instanceof Error ? error : new Error(String(error));
    span.recordException(err);
    span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err.message,
    });
    spansWithRecordedErrors.add(span);

    const extraAttributes = sanitizeAttributes(attributes);
    if (extraAttributes) {
        span.setAttributes(extraAttributes);
    }
}

export function recordActiveSpanException(error: unknown, attributes?: Attributes): void {
    const span = trace.getSpan(context.active());
    if (!span) return;
    recordSpanException(span, error, attributes);
}

export function getActiveTraceContext(): TraceContext {
    const span = trace.getSpan(context.active());
    if (!span) return {};

    const spanContext = span.spanContext();
    if (!spanContext.traceId || /^0+$/.test(spanContext.traceId)) {
        return {};
    }

    return {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
    };
}

export function recordInboundMessage(attributes: Attributes, textLength: number): void {
    const sanitized = sanitizeAttributes(attributes);
    inboundMessagesCounter.add(1, sanitized);
    inboundMessageCharsHistogram.record(textLength, sanitized);
}

export function recordLlmRequest(durationMs: number, attributes: Attributes): void {
    const sanitized = sanitizeAttributes(attributes);
    llmRequestsCounter.add(1, sanitized);
    llmDurationHistogram.record(durationMs, sanitized);
}

export function recordToolCallTelemetry(durationMs: number, attributes: Attributes): void {
    const sanitized = sanitizeAttributes(attributes);
    toolCallsCounter.add(1, sanitized);
    toolDurationHistogram.record(durationMs, sanitized);
}
