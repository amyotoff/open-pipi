/**
 * What stops a call before it is placed.
 *
 * Model spend has a daily ceiling that trips the killswitch. Calls bill on a
 * different meter that the runtime cannot see, reach real people, and cannot be
 * taken back once someone picks up — so they need their own ceiling, and it
 * must be a count rather than a cost, because the cost is not knowable here.
 *
 * Both guards fail closed on a bad value: a typo in the limit must not remove
 * the limit.
 */

import { getDb, logEvent } from '../../db';

export const CALL_PLACED_EVENT = 'voice_call_placed';

const DEFAULT_DAILY_CALL_LIMIT = 10;

/** How many calls may go out in one day. `0` switches calling off entirely. */
export function dailyCallLimit(): number {
    const raw = process.env.PIPI_DAILY_CALL_LIMIT;
    if (raw === undefined || raw.trim() === '') return DEFAULT_DAILY_CALL_LIMIT;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DAILY_CALL_LIMIT;

    return Math.floor(parsed);
}

/**
 * Country codes calls may go to, as E.164 prefixes without the plus.
 *
 * Empty means no restriction, which is the default — a household calling one
 * country should say so, but the runtime cannot guess which. Carriers offer the
 * same control; having it here too means a misconfigured carrier is not the
 * only thing standing between a loop and an expensive destination.
 */
export function allowedCountryPrefixes(): string[] {
    return (process.env.PIPI_CALL_ALLOWED_COUNTRIES || '')
        .split(',')
        .map((entry) => entry.trim().replace(/^\+/, ''))
        .filter(Boolean);
}

export function countCallsPlacedToday(): number {
    const today = new Date().toISOString().split('T')[0];
    const row = getDb()
        .prepare(`SELECT COUNT(*) AS count FROM event_log WHERE event_type = ? AND timestamp >= ?`)
        .get(CALL_PLACED_EVENT, `${today}T00:00:00.000Z`) as { count: number } | undefined;

    return row?.count ?? 0;
}

export interface GuardRefusal {
    reason: string;
}

/**
 * Decide whether this call may go out.
 *
 * Returns a refusal to show the model, or null to proceed. Checked immediately
 * before dialling rather than at tool-registration time, because both limits
 * are about the moment.
 */
export function checkCallAllowed(toNumber: string): GuardRefusal | null {
    const limit = dailyCallLimit();

    if (limit === 0) {
        return { reason: 'Calling is switched off here (PIPI_DAILY_CALL_LIMIT is 0).' };
    }

    const placed = countCallsPlacedToday();
    if (placed >= limit) {
        return {
            reason:
                `The daily limit of ${limit} call${limit === 1 ? '' : 's'} is already used up (${placed} placed today). ` +
                'Raise PIPI_DAILY_CALL_LIMIT if that is too low, or try again tomorrow.',
        };
    }

    const allowed = allowedCountryPrefixes();
    if (allowed.length > 0) {
        const digits = toNumber.replace(/^\+/, '');
        if (!allowed.some((prefix) => digits.startsWith(prefix))) {
            return {
                reason:
                    `Calls to ${toNumber} are not allowed — this install only calls +${allowed.join(', +')}. ` +
                    'Change PIPI_CALL_ALLOWED_COUNTRIES if that is wrong.',
            };
        }
    }

    return null;
}

/**
 * Record that a call went out.
 *
 * Written before the call rather than after, so a call that hangs or crashes
 * mid-flight still counts against the daily limit. Undercounting here would let
 * a crash loop dial without bound, which is exactly the case the limit exists
 * for.
 */
export function recordCallPlaced(toNumber: string, taskType: string, spaceId?: string | null): void {
    logEvent(CALL_PLACED_EVENT, {
        // Enough to audit and to spot a loop, without writing a full number
        // into the event log on every call.
        to: `${toNumber.slice(0, 4)}…${toNumber.slice(-2)}`,
        task_type: taskType,
        space_id: spaceId ?? null,
    });
}
