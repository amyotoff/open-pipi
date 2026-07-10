import { RuntimeExecutionContext, resolveSpaceIdFromExecutionContext } from '../core/runtime-context';

const GRANT_TTL_MS = 2 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

export type ApprovalActionClass = string;
type ApprovalDecision = 'approve' | 'deny';
type ApprovalContext = Partial<RuntimeExecutionContext> & { userId: string; chatId?: string };
type ApprovalState = { prompt: string; expiresAt: number; actionClass: ApprovalActionClass; toolName: string };

const pendingApprovals = new Map<string, ApprovalState>();
const grantedApprovals = new Map<string, number>();

const ACTION_CLASS_FOR_TOOL: Record<string, ApprovalActionClass | undefined> = {
    browse_web: 'browse_web',
    webrun_execute: 'deep_research',
};

export function getApprovalActionClass(toolName: string): ApprovalActionClass {
    return ACTION_CLASS_FOR_TOOL[toolName] || toolName;
}

function approvalScope(context: ApprovalContext): string | null {
    return resolveSpaceIdFromExecutionContext(context) || context.chatId || null;
}

function approvalKey(scope: string, userId: string, actionClass: ApprovalActionClass): string {
    return `${scope}:${userId}:${actionClass}`;
}

function cleanupExpiredApprovals(now = Date.now()): void {
    for (const [key, expiresAt] of grantedApprovals.entries()) {
        if (expiresAt <= now) grantedApprovals.delete(key);
    }

    for (const [key, approval] of pendingApprovals.entries()) {
        if (approval.expiresAt <= now) pendingApprovals.delete(key);
    }
}

function isAffirmative(text: string): boolean {
    return /(^|[\s,!.?])(?:да|yes|ага|угу|ок|окей|go ahead|разрешаю|подтверждаю|согласен)(?=$|[\s,!.?])/i.test(text);
}

function isNegative(text: string): boolean {
    return /(^|[\s,!.?])(?:нет|неа|отмена|cancel|стоп|не надо|не нужно)(?=$|[\s,!.?])/i.test(text);
}

type PendingApprovalDescriptor = {
    actionClass: ApprovalActionClass;
    toolName: string;
    prompt: string;
    expiresAt: number;
};

function listPendingDescriptors(context: ApprovalContext, now = Date.now()): PendingApprovalDescriptor[] {
    cleanupExpiredApprovals(now);

    const scope = approvalScope(context);
    if (!scope) return [];

    return Array.from(pendingApprovals.entries())
        .filter(([key]) => key.startsWith(`${scope}:${context.userId}:`))
        .map(([, approval]) => ({
            actionClass: approval.actionClass,
            toolName: approval.toolName,
            prompt: approval.prompt,
            expiresAt: approval.expiresAt,
        }))
        .sort((left, right) => left.actionClass.localeCompare(right.actionClass));
}

function resolveDecision(
    context: ApprovalContext,
    decision: ApprovalDecision,
    requestedActionClass?: ApprovalActionClass
): { granted: ApprovalActionClass[]; denied: ApprovalActionClass[]; pending: ApprovalActionClass[]; error?: string } {
    const now = Date.now();
    const scope = approvalScope(context);
    if (!scope) {
        return { granted: [], denied: [], pending: [], error: 'Approval scope is unavailable.' };
    }

    const pending = listPendingDescriptors(context, now);
    const pendingActions = pending.map((item) => item.actionClass);
    if (pending.length === 0) {
        return { granted: [], denied: [], pending: [], error: 'No pending approvals.' };
    }

    const actionClass = requestedActionClass || (pending.length === 1 ? pending[0].actionClass : null);

    if (!actionClass) {
        return {
            granted: [],
            denied: [],
            pending: pendingActions,
            error: `More than one approval is pending: ${pendingActions.join(', ')}.`,
        };
    }

    const matched = pending.find((item) => item.actionClass === actionClass);
    if (!matched) {
        return {
            granted: [],
            denied: [],
            pending: pendingActions,
            error: `Approval "${actionClass}" is not pending.`,
        };
    }

    const key = approvalKey(scope, context.userId, actionClass);
    pendingApprovals.delete(key);

    if (decision === 'approve') {
        grantedApprovals.set(key, now + GRANT_TTL_MS);
        return { granted: [actionClass], denied: [], pending: pendingActions.filter((item) => item !== actionClass) };
    }

    grantedApprovals.delete(key);
    return { granted: [], denied: [actionClass], pending: pendingActions.filter((item) => item !== actionClass) };
}

export function listPendingApprovalActions(context: ApprovalContext): ApprovalActionClass[] {
    return listPendingDescriptors(context).map((item) => item.actionClass);
}

export function approvePendingAction(context: ApprovalContext, requestedActionClass?: ApprovalActionClass) {
    return resolveDecision(context, 'approve', requestedActionClass);
}

export function denyPendingAction(context: ApprovalContext, requestedActionClass?: ApprovalActionClass) {
    return resolveDecision(context, 'deny', requestedActionClass);
}

export function requireToolApproval(
    toolName: string,
    context: ApprovalContext | undefined,
    prompt: string,
    requestedActionClass?: ApprovalActionClass
): string | null {
    if (!context?.userId) {
        return `[TOOL_RESULT] Действие "${toolName}" требует явного подтверждения пользователя, но контекст пользователя недоступен.`;
    }

    const actionClass = requestedActionClass || getApprovalActionClass(toolName);

    const scope = approvalScope(context);
    if (!scope) {
        return `[TOOL_RESULT] Действие "${toolName}" требует явного подтверждения пользователя, но контекст чата недоступен.`;
    }

    const now = Date.now();
    cleanupExpiredApprovals(now);

    const key = approvalKey(scope, context.userId, actionClass);
    const grantedUntil = grantedApprovals.get(key);
    if (grantedUntil && grantedUntil > now) {
        return null;
    }

    pendingApprovals.set(key, {
        prompt,
        expiresAt: now + PENDING_TTL_MS,
        actionClass,
        toolName,
    });

    return `[TOOL_RESULT] Требуется явное подтверждение пользователя для "${actionClass}". Ответь "да"/"нет" или используй /approve ${actionClass} / /deny ${actionClass}. Причина: ${prompt}`;
}

export function recordApprovalResponse(
    context: ApprovalContext,
    text: string
): { granted: ApprovalActionClass[]; denied: ApprovalActionClass[] } {
    const now = Date.now();
    cleanupExpiredApprovals(now);

    const pending = listPendingDescriptors(context, now);
    if (pending.length !== 1) {
        return { granted: [], denied: [] };
    }

    if (!isAffirmative(text) && !isNegative(text)) {
        return { granted: [], denied: [] };
    }

    const result = resolveDecision(context, isAffirmative(text) ? 'approve' : 'deny', pending[0].actionClass);
    return { granted: result.granted, denied: result.denied };
}
