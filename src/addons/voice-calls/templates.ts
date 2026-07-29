/**
 * Default rules per task type.
 *
 * The orchestrating model is good at stating a goal and bad at remembering
 * every way a delegated call can go wrong. These templates carry the second
 * part so it does not have to be re-derived on every call, and the caller
 * overrides only what is specific to the situation.
 *
 * The `forbidden_actions` entries are the load-bearing ones. An agent on a
 * phone line will be asked things nobody anticipated, and its default when
 * unsure must be to decline rather than to be helpful.
 */

import type { CallTaskPayload, CallTaskType } from './types';

type TaskTemplate = Pick<
    CallTaskPayload,
    | 'decision_rights'
    | 'hard_blockers'
    | 'must_collect'
    | 'allowed_actions'
    | 'forbidden_actions'
    | 'fallbacks'
    | 'result_contract'
>;

/** Shared tail of every result contract, so callers can branch uniformly. */
const COMMON_RESULT_FIELDS = {
    next_step: 'string|null',
    next_action_owner: 'string(owner|assistant|supplier|none)|null',
    confidence: 'string(high|medium|low)',
    open_questions: 'string[]|null',
    notes: 'string|null',
} as const;

export const TASK_TEMPLATES: Record<CallTaskType, TaskTemplate> = {
    booking: {
        decision_rights: [],
        hard_blockers: [],
        must_collect: [
            'availability',
            'exact_time',
            'reservation_confirmation',
            'deposit_required',
            'cancellation_policy',
        ],
        allowed_actions: [
            'ask questions',
            'confirm provided details',
            'accept an available slot within the allowed range',
        ],
        forbidden_actions: [
            'do not share card or payment details',
            'do not agree to a deposit without explicit permission',
            'do not invent preferences that were not given to you',
        ],
        fallbacks: [
            'If the requested slot is unavailable, ask for the nearest alternative.',
            'If still unavailable, ask whether another date is possible.',
        ],
        result_contract: {
            status: 'booked | unavailable | callback_needed | failed',
            confirmed_time: 'string|null',
            reservation_name: 'string|null',
            deposit_required: 'boolean_as_string|null',
            cancellation_policy: 'string|null',
            ...COMMON_RESULT_FIELDS,
        },
    },

    appointment: {
        decision_rights: [],
        hard_blockers: [],
        must_collect: [
            'appointment_type',
            'available_date_time',
            'location_or_format',
            'preparation_requirements',
            'documents_needed',
        ],
        allowed_actions: ['ask questions', 'confirm provided details', 'accept a suitable slot'],
        forbidden_actions: [
            'do not disclose personal or medical information beyond what you were given',
            'do not guess insurance coverage',
            'do not treat an appointment as confirmed unless the other party clearly confirmed it',
        ],
        fallbacks: [
            'If no slot is available, ask for the earliest possible date.',
            'If the specific service is unavailable, ask who to contact instead.',
        ],
        result_contract: {
            status: 'scheduled | unavailable | callback_needed | failed',
            confirmed_date: 'string|null',
            confirmed_time: 'string|null',
            location: 'string|null',
            preparation_required: 'string|null',
            documents_needed: 'string|null',
            ...COMMON_RESULT_FIELDS,
        },
    },

    info_verification: {
        decision_rights: [],
        hard_blockers: [],
        must_collect: ['requested_facts', 'source_confirmation'],
        allowed_actions: [
            'ask direct factual questions',
            'request confirmation of specific details',
            'ask who else might know if the person is unsure',
        ],
        forbidden_actions: [
            'do not wander into unrelated topics',
            'do not accept a vague answer where a concrete fact was asked for',
            'do not speculate or fill gaps with your own guesses',
        ],
        fallbacks: ['If the person is unsure, ask who would know, or when to call back.'],
        result_contract: {
            status: 'verified | partially_verified | unverified | failed',
            verified_facts: 'object|null',
            unverified_items: 'string|null',
            next_source: 'string|null',
            ...COMMON_RESULT_FIELDS,
        },
    },

    follow_up: {
        decision_rights: [],
        hard_blockers: [],
        must_collect: ['status_update', 'next_step', 'timeline'],
        allowed_actions: [
            'request a status update',
            'confirm a follow-up date and time',
            'relay information you were given',
        ],
        forbidden_actions: [
            'do not threaten or escalate emotionally',
            'do not renegotiate terms unless the task allows it',
            'do not accept a vague promise without a concrete timeline',
        ],
        fallbacks: ['If no update is available, agree a concrete time to check again.'],
        result_contract: {
            status: 'updated | no_update | callback_needed | failed',
            update_received: 'string|null',
            next_action: 'string|null',
            follow_up_date: 'string|null',
            ...COMMON_RESULT_FIELDS,
        },
    },

    owner_relay: {
        decision_rights: [],
        hard_blockers: [],
        must_collect: ['message_acknowledged'],
        allowed_actions: [
            'deliver the message clearly',
            'confirm the recipient understood it',
            'answer simple clarifying questions if you were given the answer',
        ],
        forbidden_actions: ['do not improvise extra facts', 'do not turn a short relay into a long conversation'],
        fallbacks: ['If asked for details you were not given, say you will check and follow up.'],
        result_contract: {
            status: 'delivered | not_reached | failed',
            message_acknowledged: 'boolean_as_string|null',
            recipient_response: 'string|null',
            ...COMMON_RESULT_FIELDS,
        },
    },
};
