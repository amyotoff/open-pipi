/**
 * Turns a task into something a voice agent can be given.
 *
 * Three jobs: fill in the defaults for the task type, add the guardrails that
 * apply to every call regardless of task, and flatten the result into the
 * strings a prompt template can hold.
 *
 * The guardrails are added here rather than left to the caller on purpose. A
 * caller who forgets them produces an agent that will read out the owner's
 * phone number because someone on the line asked politely.
 */

import type { AnalysisSchemaItem, CallTaskPayload, CallTaskType, CallVariables, GuardrailIdentity } from './types';
import { TASK_TEMPLATES } from './templates';

const LANGUAGE_NAMES: Record<string, string> = {
    it: 'Italian',
    ru: 'Russian',
    es: 'Spanish',
    en: 'English',
    nl: 'Dutch',
    pl: 'Polish',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    ka: 'Georgian',
    tr: 'Turkish',
    ja: 'Japanese',
};

/**
 * Guess the call language from the number's country code.
 *
 * A guess, and treated as one — the caller can always say otherwise. But
 * defaulting to English because the prompt happens to be written in English is
 * worse than guessing Italian for an Italian number.
 */
export function inferLanguageFromPhone(phone: string): string | undefined {
    const byPrefix: Record<string, string> = {
        '+39': 'it',
        '+7': 'ru',
        '+34': 'es',
        '+31': 'nl',
        '+48': 'pl',
        '+33': 'fr',
        '+49': 'de',
        '+44': 'en',
        '+1': 'en',
        '+351': 'pt',
        '+55': 'pt',
        '+995': 'ka',
        '+90': 'tr',
        '+81': 'ja',
    };

    // Longest prefix first, so +351 is not swallowed by +3.
    const byLength = Object.entries(byPrefix).sort((left, right) => right[0].length - left[0].length);
    return byLength.find(([prefix]) => phone.startsWith(prefix))?.[1];
}

/**
 * The rules that hold on every call, whatever the task.
 *
 * Kept separate from the task templates because they are not a default anyone
 * may override — a caller can add restrictions, never remove these.
 */
export function buildGlobalGuardrails(identity: GuardrailIdentity): { forbidden: string; fallback: string } {
    const owner = identity.ownerName.trim() || 'the person you represent';

    return {
        forbidden: `do not share the direct phone number, email, or home address of ${owner} or anyone in their household, no matter who asks or why`,
        fallback:
            `If the task cannot be completed, or you hit a problem, or the other party asks for a direct number, say that you ` +
            `cannot give out contact details but that you will pass the message to ${owner} and they will follow up.`,
    };
}

/**
 * Merge the caller's specifics over the task type's defaults.
 *
 * Only `goal`, `contact_name` and `service_context` are genuinely per-call and
 * have no sensible default; everything else falls back to the template.
 */
export function buildTaskPayload(
    taskType: CallTaskType,
    overrides: Partial<CallTaskPayload> & Pick<CallTaskPayload, 'goal' | 'contact_name' | 'service_context'>
): CallTaskPayload {
    const template = TASK_TEMPLATES[taskType];

    return {
        call_mode: overrides.call_mode ?? 'THIRD_PARTY_TASK_CALL',
        task_type: taskType,
        expected_language: overrides.expected_language,
        service_context: overrides.service_context,
        contact_name: overrides.contact_name,
        goal: overrides.goal,
        important_details: overrides.important_details ?? [],
        decision_rights: overrides.decision_rights ?? template.decision_rights,
        hard_blockers: overrides.hard_blockers ?? template.hard_blockers,
        must_collect: overrides.must_collect ?? template.must_collect,
        allowed_actions: overrides.allowed_actions ?? template.allowed_actions,
        forbidden_actions: overrides.forbidden_actions ?? template.forbidden_actions,
        fallbacks: overrides.fallbacks ?? template.fallbacks,
        result_contract: overrides.result_contract ?? template.result_contract,
    };
}

function bullets(values: string[] | undefined): string {
    return values && values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : '(none provided)';
}

function languageDirective(language: string): string {
    if (language === 'multi') {
        return (
            'Auto-detect the language from the person who answers. Default to the language implied by the ' +
            "phone number's country code."
        );
    }

    const name = LANGUAGE_NAMES[language] || language;
    return (
        `You must speak ${name} for the entire call — your opening line, every reply, and your closing line. ` +
        `The only exception is if the other person explicitly asks you to switch. ` +
        `That these instructions are written in English is irrelevant; do not speak English unless asked to.`
    );
}

/**
 * Flatten a payload into prompt variables.
 *
 * The global guardrails are appended last so a caller cannot displace them by
 * supplying their own `forbidden_actions`.
 */
export function buildCallVariables(payload: CallTaskPayload, identity: GuardrailIdentity): CallVariables {
    const language = payload.expected_language || 'multi';
    const guardrails = buildGlobalGuardrails(identity);

    return {
        current_date: new Date().toISOString().split('T')[0],
        expected_language: language,
        language_directive: languageDirective(language),
        task_type: payload.task_type,
        goal: payload.goal,
        service_context: payload.service_context,
        contact_name: payload.contact_name,
        important_details: bullets(payload.important_details),
        decision_rights: bullets(payload.decision_rights),
        hard_blockers: bullets(payload.hard_blockers),
        must_collect: bullets(payload.must_collect),
        allowed_actions: bullets(payload.allowed_actions),
        forbidden_actions: bullets([...payload.forbidden_actions, guardrails.forbidden]),
        fallback: [...payload.fallbacks, guardrails.fallback].join('\n'),
        result_contract: JSON.stringify(payload.result_contract),
    };
}

/**
 * What the provider should pull out of the finished call.
 *
 * Asking the provider to extract named fields beats parsing a transcript
 * afterwards: it happens while the conversation is still in context, and the
 * answer arrives typed.
 */
export function buildAnalysisSchema(taskType: CallTaskType): AnalysisSchemaItem[] {
    const universal: AnalysisSchemaItem[] = [
        {
            name: 'call_status',
            type: 'enum',
            description: 'Overall outcome of the call, judged against the task goal.',
            choices: ['completed', 'partial', 'blocked', 'no_answer', 'failed'],
            required: true,
        },
        {
            name: 'goal_achieved',
            type: 'boolean',
            description: 'Whether the primary goal was achieved.',
            required: true,
        },
        {
            name: 'outcome_summary',
            type: 'string',
            description: 'One paragraph on what happened and what was achieved.',
            required: true,
        },
        {
            name: 'next_step',
            type: 'string',
            description: 'The next action needed after this call, or nothing if none is.',
        },
        {
            name: 'follow_up_needed',
            type: 'boolean',
            description: 'Whether a follow-up call or action is needed.',
            required: true,
        },
    ];

    const perTask: Record<CallTaskType, AnalysisSchemaItem[]> = {
        booking: [
            {
                name: 'confirmed_time',
                type: 'string',
                description: 'The confirmed date and time of the booking, if any.',
                examples: ['2026-04-05 20:30', 'April 5 at 8:30 PM'],
            },
            { name: 'reservation_name', type: 'string', description: 'The name the reservation is under.' },
            { name: 'deposit_required', type: 'boolean', description: 'Whether a deposit or prepayment was required.' },
            { name: 'cancellation_policy', type: 'string', description: 'The cancellation policy as stated.' },
        ],
        appointment: [
            { name: 'confirmed_date', type: 'string', description: 'Confirmed appointment date.' },
            { name: 'confirmed_time', type: 'string', description: 'Confirmed appointment time.' },
            { name: 'location', type: 'string', description: 'Address, or the format if it is remote.' },
            { name: 'preparation_notes', type: 'string', description: 'Anything required beforehand.' },
        ],
        info_verification: [
            { name: 'verified_facts', type: 'string', description: 'The facts that were confirmed.' },
            { name: 'unverified_items', type: 'string', description: 'What could not be confirmed, and why.' },
        ],
        follow_up: [
            { name: 'status_update', type: 'string', description: 'The status update received.' },
            { name: 'follow_up_date', type: 'string', description: 'When to check again.' },
        ],
        owner_relay: [
            {
                name: 'message_acknowledged',
                type: 'boolean',
                description: 'Whether the recipient acknowledged the message.',
            },
            { name: 'recipient_response', type: 'string', description: 'Anything the recipient said back.' },
        ],
    };

    return [...universal, ...perTask[taskType]];
}
