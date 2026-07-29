/**
 * Reduces a finished call to something another agent can act on.
 *
 * Two paths, because providers differ in how much they hand back. If the
 * provider extracted named fields, use them. If all that came back is a
 * summary, say so honestly and lower the confidence rather than inventing
 * structure that was never in the call.
 *
 * No model is run here. Re-reading a transcript with an LLM to guess what was
 * agreed adds a second place for the answer to be wrong, and the provider was
 * closer to the conversation than we are.
 */

import type { CallAnalysis, CallResultContract, CallTaskType } from './types';

/** Fields every task type reports, so anything else is task-specific. */
const UNIVERSAL_FIELDS = new Set(['call_status', 'goal_achieved', 'outcome_summary', 'next_step', 'follow_up_needed']);

/** Which collected facts count as something the other party actually committed to. */
const AGREEMENT_FIELDS: Record<CallTaskType, string[]> = {
    booking: ['confirmed_time', 'reservation_name', 'deposit_required'],
    appointment: ['confirmed_date', 'confirmed_time', 'location'],
    info_verification: [],
    follow_up: ['follow_up_date'],
    owner_relay: ['message_acknowledged'],
};

export function extractCallResult(
    transcript: string,
    analysis: CallAnalysis | undefined,
    taskType: CallTaskType,
    disconnectionReason?: string
): CallResultContract {
    const custom = analysis?.custom_analysis_data;

    if (!transcript && !analysis?.call_summary) {
        return notConnected(taskType, disconnectionReason);
    }

    if (custom && Object.keys(custom).length > 0) {
        return fromExtractedFields(custom, analysis!, taskType);
    }

    return fromSummaryOnly(analysis, taskType, disconnectionReason);
}

/** Nothing came back at all — the call never really happened. */
function notConnected(taskType: CallTaskType, reason?: string): CallResultContract {
    return {
        status: statusFromDisconnection(reason),
        task_type: taskType,
        goal_achieved: false,
        summary: reason ? `Call did not complete: ${reason}` : 'Call did not complete: no transcript or analysis.',
        facts_collected: {},
        agreements: {},
        blockers: [reason || 'no_connection'],
        next_step: 'Retry the call, or reach the contact another way.',
        follow_up_needed: true,
        confidence: 0.1,
    };
}

/** The provider extracted named fields. Preferred path. */
function fromExtractedFields(
    custom: Record<string, unknown>,
    analysis: CallAnalysis,
    taskType: CallTaskType
): CallResultContract {
    const goalAchieved = isTrue(custom.goal_achieved);
    const facts: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(custom)) {
        if (UNIVERSAL_FIELDS.has(key)) continue;
        if (value == null || value === '') continue;
        facts[key] = value;
    }

    return {
        status: normalizeStatus(String(custom.call_status || 'partial')),
        task_type: taskType,
        goal_achieved: goalAchieved,
        summary: String(custom.outcome_summary || analysis.call_summary || ''),
        facts_collected: facts,
        agreements: Object.fromEntries(
            AGREEMENT_FIELDS[taskType]
                .filter((key) => facts[key] != null && facts[key] !== '')
                .map((key) => [key, facts[key]])
        ),
        blockers: goalAchieved ? [] : ['Goal was not fully achieved — see the summary.'],
        next_step: normalizeNextStep(custom.next_step),
        follow_up_needed: isTrue(custom.follow_up_needed),
        confidence: goalAchieved ? 0.9 : 0.6,
    };
}

/** Only a summary came back. Report it as thin rather than dressing it up. */
function fromSummaryOnly(
    analysis: CallAnalysis | undefined,
    taskType: CallTaskType,
    reason?: string
): CallResultContract {
    const successful = analysis?.call_successful ?? false;
    let status: CallResultContract['status'] = successful ? 'completed' : 'partial';

    if (analysis?.in_voicemail) status = 'no_answer';
    if (reason === 'dial_no_answer' || reason === 'dial_busy') status = 'no_answer';
    if (reason === 'error_unknown' || reason?.startsWith('error_')) status = 'failed';

    return {
        status,
        task_type: taskType,
        goal_achieved: successful,
        summary: analysis?.call_summary || '(No summary available — read the transcript.)',
        facts_collected: {},
        agreements: {},
        blockers: successful ? [] : [reason || 'unknown'],
        next_step: successful ? null : 'Read the transcript and decide what to do next.',
        follow_up_needed: !successful,
        confidence: successful ? 0.7 : 0.3,
    };
}

/** Providers report booleans as real booleans or as the strings the model emitted. */
function isTrue(value: unknown): boolean {
    return value === true || value === 'true';
}

/**
 * Extraction models emit the literal "None" or "N/A" where a null was wanted.
 * Taking those at face value puts the word "None" in front of a person as the
 * next thing to do.
 */
function normalizeNextStep(value: unknown): string | null {
    if (value == null) return null;

    const text = String(value).trim();
    if (!text || /^(none|null|n\/a|nothing)$/i.test(text)) return null;

    return text;
}

/**
 * Task-specific vocabularies collapse into the shared status set.
 *
 * A booking says "booked" and a relay says "delivered"; a caller branching on
 * the result should not have to know which word this task type uses.
 */
function normalizeStatus(raw: string): CallResultContract['status'] {
    const known: Record<string, CallResultContract['status']> = {
        completed: 'completed',
        partial: 'partial',
        blocked: 'blocked',
        no_answer: 'no_answer',
        failed: 'failed',
        booked: 'completed',
        scheduled: 'completed',
        verified: 'completed',
        updated: 'completed',
        delivered: 'completed',
        unavailable: 'blocked',
        unverified: 'blocked',
        partially_verified: 'partial',
        callback_needed: 'partial',
        no_update: 'partial',
        not_reached: 'no_answer',
    };

    return known[raw] || 'partial';
}

/**
 * How the line dropped, translated into what it means for the task.
 *
 * A normal hangup with nothing extracted is `partial`, not `failed` — the
 * conversation did happen, we simply cannot say what came of it, and calling
 * that a failure would send someone to redial a call that already went through.
 */
function statusFromDisconnection(reason?: string): CallResultContract['status'] {
    if (!reason) return 'failed';
    if (reason.includes('no_answer') || reason.includes('busy') || reason.includes('voicemail')) return 'no_answer';
    if (reason.includes('error')) return 'failed';
    if (
        reason.includes('hangup') ||
        reason.includes('transfer') ||
        reason === 'inactivity' ||
        reason === 'max_duration_reached'
    ) {
        return 'partial';
    }

    return 'failed';
}
