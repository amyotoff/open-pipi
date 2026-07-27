/**
 * Whether the assistant should speak in a group, and on whose terms.
 *
 * This is space policy, not transport mechanics: the same rules apply whether a
 * group arrives over Telegram, Discord, or the Web. It lives beside the gateway
 * rather than inside a transport so no adapter has to reimplement it.
 */

import { BOT_NAME_ALIASES, isHouseholdChat } from '../config';
import { parseSpacePolicyRecord } from '../core/space-preferences';
import { shouldJoinGroupConversation } from '../core/local-triage';
import type { Space } from '../db';
import type { IncomingMessage } from '../transports/types';

const PASSIVE_GROUP_COOLDOWN_MS = 10 * 60_000;
const lastPassiveGroupReplyAt = new Map<string, number>();

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GROUP_NAME_TRIGGER_PATTERN = new RegExp(`(${BOT_NAME_ALIASES.map(escapeRegExp).join('|')})`, 'i');
const GROUP_REQUEST_TRIGGER_PATTERN =
    /(help|помоги|подскажи|расскажи|найди|compare|сравни|search|research|plan|спланируй|remind|напомни|todo|задач|remember this|remember|запомни|schedule|расписани|organize|организуй|write|напиши|draft|черновик|summarize|резюм|summary)/i;
const EXTERNAL_GROUP_MODES = new Set(['mention_only', 'auto']);

export type GroupMode = 'household' | 'external';
export type ExternalGroupMode = 'mention_only' | 'auto';

export interface ParticipationVerdict {
    isDirect: boolean;
    isPrimaryGroup: boolean;
    groupMode?: GroupMode;
    externalGroupMode?: ExternalGroupMode;
}

/** Detect messages that express emotion, mood, or personal context worth noticing */
export function isEmotionalOrPersonal(text: string): boolean {
    const t = text.toLowerCase();
    // Mood / feelings / state
    if (
        /(устал|вымотал|выдохся|нет сил|задолбал|бесит|злюсь|грустн|тоскл|скучн|одинок|тревожн|стресс|паник|нервнич|расстроен|обидн|раздража|не могу больше|сил нет|хреново|плохо себя|болит|заболе|температур|простуд|голова раскал|мигрень|тошнит)/i.test(
            t
        )
    )
        return true;
    // Excitement / celebration
    if (
        /(ура!|получилось|наконец-то|вау|офигеть|круто!|победа|сдал|прошёл|прошел|повысил|приняли|оффер|предложили работу)/i.test(
            t
        )
    )
        return true;
    // Life events
    if (
        /(приехал|уехал|улетаю|вернулся|вернулась|гости придут|гости приед|день рождения|годовщин|юбилей|свадьб|новоселье)/i.test(
            t
        )
    )
        return true;
    // Asking for comfort / help
    if (/(обними|поддержи|что делать|как быть|не знаю что|посоветуй|помоги разобраться)/i.test(t)) return true;
    return false;
}

export function hasPrimaryGroupTrigger(text: string): boolean {
    return GROUP_NAME_TRIGGER_PATTERN.test(text) || GROUP_REQUEST_TRIGGER_PATTERN.test(text);
}

export function isExternalGroupEnabled(rawPolicy: string | null | undefined): boolean {
    return parseSpacePolicyRecord(rawPolicy).external_group_enabled === true;
}

export function resolveExternalGroupMode(rawPolicy: string | null | undefined): ExternalGroupMode {
    const value = parseSpacePolicyRecord(rawPolicy).external_group_mode;
    return typeof value === 'string' && EXTERNAL_GROUP_MODES.has(value) ? (value as ExternalGroupMode) : 'mention_only';
}

/**
 * Decide whether this endpoint is one the assistant takes part in.
 *
 * `declaredPrimaryGroup` exists because "primary" means different things per
 * transport and only the transport knows: Discord pins it to one configured
 * channel, while Telegram derives it from the household chat plus the space's
 * own external-group policy. Passing it explicitly keeps each transport's
 * answer where it is known instead of hiding it in metadata Core would sniff.
 */
export function evaluateParticipation(input: {
    message: IncomingMessage;
    space?: Space;
    declaredPrimaryGroup?: boolean;
}): ParticipationVerdict {
    const isDirect = input.message.endpoint.type === 'direct';
    if (isDirect) {
        return { isDirect: true, isPrimaryGroup: false };
    }

    if (input.declaredPrimaryGroup !== undefined) {
        return { isDirect: false, isPrimaryGroup: input.declaredPrimaryGroup };
    }

    const isHousehold = isHouseholdChat(input.message.endpoint.id);
    const isExternalGroup = !isHousehold && isExternalGroupEnabled(input.space?.policy_json);

    return {
        isDirect: false,
        isPrimaryGroup: isHousehold || isExternalGroup,
        groupMode: isExternalGroup ? 'external' : isHousehold ? 'household' : undefined,
        externalGroupMode: isExternalGroup ? resolveExternalGroupMode(input.space?.policy_json) : undefined,
    };
}

/**
 * Group chats stay mostly passive: answer on explicit invitations, obvious
 * requests, emotionally salient messages, or when a cheap local relevance
 * check finds concrete value. The assistant never speaks merely to stay visible.
 */
export async function shouldHandlePrimaryGroupMessage(
    input: {
        endpointId: string;
        text: string;
        addressedToAssistant?: boolean;
    },
    options?: { allowRequestTriggers?: boolean; allowPassiveTurns?: boolean }
): Promise<boolean> {
    const hasTrigger = options?.allowRequestTriggers === false ? false : hasPrimaryGroupTrigger(input.text);
    if (input.addressedToAssistant || hasTrigger || isEmotionalOrPersonal(input.text)) return true;

    if (options?.allowPassiveTurns === false) return false;
    const lastReplyAt = lastPassiveGroupReplyAt.get(input.endpointId) || 0;
    if (Date.now() - lastReplyAt < PASSIVE_GROUP_COOLDOWN_MS) return false;

    const relevant = await shouldJoinGroupConversation(input.text);
    if (relevant) lastPassiveGroupReplyAt.set(input.endpointId, Date.now());
    return relevant;
}

/** Test seam: the passive-reply cooldown is process state, not database state. */
export function resetPassiveGroupCooldowns(): void {
    lastPassiveGroupReplyAt.clear();
}
