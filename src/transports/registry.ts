/**
 * Transport registry — one place that knows which transports exist, and the
 * single owner of their start/stop lifecycle.
 *
 * Bootstrap reads config, constructs the enabled adapters, registers them, and
 * starts them. Adapters are registered as instances rather than factories
 * (unlike the legacy channel registry) because bootstrap already decides what
 * to build; lazy instantiation would only hide startup failures.
 */

import type { TransportAdapter, TransportRuntimeContext } from './types';

export interface TransportRegistration {
    adapter: TransportAdapter;
    /**
     * A required transport that fails to start aborts bootstrap. An optional one
     * logs and is skipped, so a broken Discord token cannot take Telegram down.
     */
    required?: boolean;
}

export interface TransportStartFailure {
    name: string;
    error: Error;
}

export interface TransportStartReport {
    started: string[];
    failed: TransportStartFailure[];
}

const registrations = new Map<string, TransportRegistration>();
const started = new Set<string>();

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function registerTransport(adapter: TransportAdapter, options?: { required?: boolean }): void {
    if (registrations.has(adapter.name)) {
        throw new Error(`Transport "${adapter.name}" is already registered.`);
    }

    registrations.set(adapter.name, { adapter, required: options?.required ?? false });
}

export function getTransport(name: string): TransportAdapter | undefined {
    return registrations.get(name)?.adapter;
}

export function listTransports(): TransportAdapter[] {
    return Array.from(registrations.values(), (registration) => registration.adapter);
}

export function isTransportStarted(name: string): boolean {
    return started.has(name);
}

/**
 * Start every registered transport. A required transport that throws aborts the
 * whole start and stops whatever already came up, so the runtime never lingers
 * half-alive; optional failures are collected and reported.
 */
export async function startAllTransports(context: TransportRuntimeContext): Promise<TransportStartReport> {
    const report: TransportStartReport = { started: [], failed: [] };

    for (const [name, registration] of registrations) {
        if (started.has(name)) continue;

        try {
            await registration.adapter.start(context);
            started.add(name);
            report.started.push(name);
            console.log(`[TRANSPORTS] ${name}: started`);
        } catch (error) {
            const failure = toError(error);

            if (registration.required) {
                console.error(`[TRANSPORTS] ${name}: required transport failed to start — ${failure.message}`);
                await stopAllTransports();
                throw failure;
            }

            report.failed.push({ name, error: failure });
            console.warn(`[TRANSPORTS] ${name}: failed to start — ${failure.message}`);
        }
    }

    return report;
}

/** Stop every started transport. Never throws: shutdown must always finish. */
export async function stopAllTransports(): Promise<void> {
    for (const name of Array.from(started)) {
        const registration = registrations.get(name);
        started.delete(name);
        if (!registration) continue;

        try {
            await registration.adapter.stop();
            console.log(`[TRANSPORTS] ${name}: stopped`);
        } catch (error) {
            console.warn(`[TRANSPORTS] ${name}: stop error — ${toError(error).message}`);
        }
    }
}

/** Test seam: drop all registrations and started state. */
export function resetTransportRegistry(): void {
    registrations.clear();
    started.clear();
}
