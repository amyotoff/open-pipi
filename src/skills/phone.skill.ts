/**
 * Delegating a phone call to a voice agent.
 *
 * The interesting part of this skill is what it refuses to do. It will not
 * place a call without an approval, without a configured provider, or without
 * the caller having said what to do when the goal turns out to be impossible —
 * because an unsupervised agent that meets an unanticipated situation will
 * improvise, and improvising on someone's behalf on a phone line is how
 * commitments get made that nobody authorized.
 *
 * The addon behind it lives in src/addons/voice-calls. See docs/addons.md for
 * the pattern this is an example of.
 */

import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getSpaceParticipants } from '../db';
import { logWarn } from '../utils/logging';
import { RuntimeExecutionContext, resolveSpaceIdFromExecutionContext } from '../core/runtime-context';
import { BOT_DISPLAY_NAME } from '../config';

const E164 = /^\+[1-9]\d{7,14}$/;

const TASK_TYPES = ['booking', 'appointment', 'info_verification', 'follow_up', 'owner_relay'] as const;

/**
 * Who the delegate says it represents.
 *
 * A name, never contact details — it goes into a prompt that a stranger will
 * hear. Falls back to the assistant's own name when the space has no named
 * owner, which reads better on a call than an empty string.
 */
function resolveIdentity(context?: RuntimeExecutionContext): { ownerName: string } {
    const spaceId = resolveSpaceIdFromExecutionContext(context);

    if (spaceId) {
        try {
            const owner = getSpaceParticipants(spaceId).find(
                (participant) => participant.membership_role === 'owner' || participant.role === 'owner'
            );
            const name = owner?.nickname || owner?.display_name;
            if (name) return { ownerName: name };
        } catch (error) {
            logWarn('VOICE', 'owner_lookup_failed', {
                space_id: spaceId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { ownerName: BOT_DISPLAY_NAME };
}

const skill: SkillManifest = {
    name: 'phone',
    description:
        'Delegate an outbound phone call to a voice agent: bookings, appointments, checking facts, follow-ups, and relaying a message.',
    version: '1.0.0',

    meta: {
        run_mode: 'sidecar',
        approval: 'explicit',
        // A call costs money per minute and is not retractable once someone has
        // picked up.
        cost: 'high',
        visibility: 'owner',
        pack_tags: [],
    },

    toolMeta: {
        delegate_phone_call: {
            approval: 'explicit',
            approval_action: 'delegate_phone_call',
            approval_reason: 'placing a real phone call to a third party on your behalf',
        },
    },

    tools: [
        {
            name: 'delegate_phone_call',
            description:
                'Place a real outbound phone call through a voice agent and return a structured result. ' +
                'The agent is on its own once the call starts — you cannot intervene — so state the goal, ' +
                'the limits, and at least one fallback. If you are missing a detail you would need on the ' +
                'call, ask the user instead of calling.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    phone: { type: Type.STRING, description: 'Number in E.164 format, for example +391234567890.' },
                    task_type: {
                        type: Type.STRING,
                        description: `One of: ${TASK_TYPES.join(', ')}.`,
                    },
                    goal: {
                        type: Type.STRING,
                        description:
                            'What the call must achieve, concretely. "Book a table for two on 5 April at 20:00".',
                    },
                    contact_name: { type: Type.STRING, description: 'Who is being called — person or business.' },
                    service_context: {
                        type: Type.STRING,
                        description: 'What kind of call this is, for the agent\'s framing. "Restaurant reservation".',
                    },
                    important_details: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Facts the agent needs on the call: dates, names, known preferences.',
                    },
                    fallbacks: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description:
                            'What to do if the goal cannot be met. Give at least one — without it the agent ' +
                            'will invent something.',
                    },
                    decision_rights: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'How far the agent may go on its own. "May accept a delivery fee up to 8 euros".',
                    },
                    hard_blockers: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Lines it must not cross. "Must not give a date of birth".',
                    },
                    must_collect: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "Facts it must come back with. Defaults to the task type's list.",
                    },
                    forbidden_actions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Extra restrictions on top of the built-in ones.',
                    },
                    expected_language: {
                        type: Type.STRING,
                        description:
                            'ISO 639-1 code for the call, e.g. "it". Omit to infer it from the number\'s country code.',
                    },
                },
                required: [
                    'phone',
                    'task_type',
                    'goal',
                    'contact_name',
                    'service_context',
                    'important_details',
                    'fallbacks',
                ],
            },
        },
    ],

    handlers: {
        delegate_phone_call: async (args: any, context?: RuntimeExecutionContext): Promise<string> => {
            const phone = String(args.phone || '').trim();
            const taskType = String(args.task_type || '');

            if (!E164.test(phone)) {
                return `[TOOL_RESULT] "${phone}" is not an E.164 number. It needs a leading + and country code, e.g. +391234567890.`;
            }
            if (!TASK_TYPES.includes(taskType as (typeof TASK_TYPES)[number])) {
                return `[TOOL_RESULT] Unknown task_type "${taskType}". Use one of: ${TASK_TYPES.join(', ')}.`;
            }

            const fallbacks: string[] = Array.isArray(args.fallbacks) ? args.fallbacks.filter(Boolean) : [];
            if (fallbacks.length === 0) {
                // Refusing here rather than defaulting: the caller not thinking
                // about failure is exactly the case that goes wrong on a call.
                return '[TOOL_RESULT] Give at least one fallback — what should the agent do if the goal turns out to be impossible?';
            }

            const { getVoiceProvider, registerRetellProvider, buildTaskPayload, inferLanguageFromPhone } =
                await import('../addons/voice-calls');

            // Registered on first use rather than at boot: an install with no
            // calling configured should not pay for this module at startup.
            registerRetellProvider();
            const provider = getVoiceProvider();

            if (!provider) {
                return (
                    '[TOOL_RESULT] Calling is not configured on this install, so no call was placed. ' +
                    'Setting it up is described in docs/addons.md.'
                );
            }

            const payload = buildTaskPayload(taskType as (typeof TASK_TYPES)[number], {
                goal: String(args.goal || ''),
                contact_name: String(args.contact_name || ''),
                service_context: String(args.service_context || ''),
                important_details: Array.isArray(args.important_details) ? args.important_details : [],
                fallbacks,
                decision_rights: Array.isArray(args.decision_rights) ? args.decision_rights : undefined,
                hard_blockers: Array.isArray(args.hard_blockers) ? args.hard_blockers : undefined,
                must_collect: Array.isArray(args.must_collect) ? args.must_collect : undefined,
                forbidden_actions: Array.isArray(args.forbidden_actions) ? args.forbidden_actions : undefined,
                expected_language: args.expected_language || inferLanguageFromPhone(phone),
            });

            try {
                const outcome = await provider.placeCall(phone, {
                    payload,
                    identity: resolveIdentity(context),
                    metadata: { space_id: resolveSpaceIdFromExecutionContext(context) ?? null },
                });
                const result = outcome.structuredResult;

                if (!result) {
                    return `[TOOL_RESULT] The call finished but produced no structured result. Summary: ${outcome.summary || '(none)'}`;
                }

                // Returned as JSON so the next turn can branch on it rather than
                // re-reading prose it would have to interpret.
                return `[TOOL_RESULT] Call finished.\n${JSON.stringify(result, null, 2)}`;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logWarn('VOICE', 'call_failed', { task_type: taskType, error: message });
                return `[TOOL_RESULT] The call could not be completed: ${message}`;
            }
        },
    },
};

export default skill;
