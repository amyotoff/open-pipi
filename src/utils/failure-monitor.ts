import { notifyPrimaryHousehold } from '../channels/runtime';
import { logEvent } from '../db';

const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const ALERT_THRESHOLD = 3;
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

type FailureState = {
    count: number;
    firstSeenAt: number;
    lastSeenAt: number;
    lastMessage: string;
    alertedAt: number;
};

const failures = new Map<string, FailureState>();

export function reportOperationalFailure(source: string, message: string): void {
    const now = Date.now();
    const existing = failures.get(source);
    const state =
        !existing || now - existing.firstSeenAt > FAILURE_WINDOW_MS
            ? {
                  count: 0,
                  firstSeenAt: now,
                  lastSeenAt: now,
                  lastMessage: '',
                  alertedAt: 0,
              }
            : existing;

    state.count += 1;
    state.lastSeenAt = now;
    state.lastMessage = message;
    failures.set(source, state);

    logEvent('operational_failure', {
        source,
        count: state.count,
        message,
    });

    const shouldAlert =
        state.count >= ALERT_THRESHOLD && (state.alertedAt === 0 || now - state.alertedAt > ALERT_COOLDOWN_MS);

    if (!shouldAlert) return;

    state.alertedAt = now;
    void notifyPrimaryHousehold(
        `⚠️ Повторяющиеся ошибки в ${source}: ${state.count} сбоев за последние ${Math.round(FAILURE_WINDOW_MS / 60000)} минут. Последняя ошибка: ${message}`
    ).catch((error) => {
        console.error('[FAILURE_MONITOR] Failed to notify household:', error);
    });
}

export function reportOperationalRecovery(source: string): void {
    if (!failures.has(source)) return;
    failures.delete(source);
    logEvent('operational_recovery', { source });
}
