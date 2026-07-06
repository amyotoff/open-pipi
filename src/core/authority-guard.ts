import { getMemberEffectiveAuthority, memberHasTrustFlag } from '../db';
import { DEFAULT_AUTHORITY_THRESHOLD } from './authority';
import { resolveSpaceIdFromExecutionContext } from './runtime-context';

export type AuthorityGuardInput = {
    chatId?: string;
    spaceId?: string;
    senderId: string;
    text: string;
    replyTarget?: {
        personId?: string;
        displayName?: string;
        isBot?: boolean;
    };
};

export type AuthorityGuardResult = { allow: true } | { allow: false; reason: string };

export function classifyAuthoritySensitiveInstruction(text: string): {
    isOverrideLike: boolean;
    isHighImpact: boolean;
} {
    const normalized = text.trim().toLowerCase();

    const isOverrideLike =
        /(отмени|игнорируй|не надо|не нужно|вместо этого|сделай иначе|override|ignore|cancel|do not|don't|instead)/i.test(
            normalized
        );
    const isHighImpact =
        /(удали|сотри|wipe|delete|remove|перезапусти|restart|reboot|shutdown|выключи|kill|deploy|publish|опубликуй|задеплой|купи|закажи|purchase|buy|order|переведи|transfer|pay|оплати|reset)/i.test(
            normalized
        );

    return { isOverrideLike, isHighImpact };
}

export function evaluateAuthorityGuard(input: AuthorityGuardInput): AuthorityGuardResult {
    const { isOverrideLike, isHighImpact } = classifyAuthoritySensitiveInstruction(input.text);
    if (!isOverrideLike && !isHighImpact) {
        return { allow: true };
    }

    const spaceId = resolveSpaceIdFromExecutionContext({
        chatId: input.chatId || '',
        userId: input.senderId,
        spaceId: input.spaceId,
    });
    if (!spaceId) {
        return { allow: true };
    }
    const senderCanOverride = memberHasTrustFlag(spaceId, input.senderId, 'can_override_instructions');
    const senderCanHighImpact = memberHasTrustFlag(spaceId, input.senderId, 'can_issue_high_impact_commands');

    if (isHighImpact && !senderCanHighImpact) {
        return {
            allow: false,
            reason: 'Это похоже на high-impact команду. Мне нужно подтверждение от участника с правом high-impact действий в этом space.',
        };
    }

    const replyTarget = input.replyTarget;
    if (!replyTarget?.personId || replyTarget.isBot || replyTarget.personId === input.senderId) {
        return { allow: true };
    }

    const targetName = replyTarget.displayName || 'этого участника';
    const senderAuthority = getMemberEffectiveAuthority(spaceId, input.senderId) ?? 0;
    const targetAuthority = getMemberEffectiveAuthority(spaceId, replyTarget.personId) ?? 0;
    const gap = senderAuthority - targetAuthority;

    if (isOverrideLike && !senderCanOverride) {
        return {
            allow: false,
            reason: `Это похоже на попытку переопределить указание ${targetName}. Нужна явная договорённость в чате или участник с правом override.`,
        };
    }

    if (gap <= -DEFAULT_AUTHORITY_THRESHOLD) {
        return {
            allow: false,
            reason: `Это конфликтует с указанием ${targetName}, у которого сейчас заметно выше authority. Попросите его подтвердить изменение или уточните решение вместе.`,
        };
    }

    if (Math.abs(gap) < DEFAULT_AUTHORITY_THRESHOLD) {
        return {
            allow: false,
            reason: `Здесь возможен конфликт указаний между участниками с близким authority. Уточните, чья инструкция должна быть главной.`,
        };
    }

    return { allow: true };
}
