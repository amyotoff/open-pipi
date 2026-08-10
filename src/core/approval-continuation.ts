import { getRegisteredHandlersForContext } from '../skills/_registry';
import { ApprovedToolContinuation, revokeApprovalGrant } from '../utils/approvals';
import { executeToolCall } from './tool-executor';
import { RuntimeExecutionContext } from './runtime-context';

export interface ApprovedToolContinuationResult {
    actionClass: string;
    toolName: string;
    result: string;
}

/** Execute stored calls through the normal registry, policy, approval, and audit path. */
export async function executeApprovedToolContinuations(
    continuations: ApprovedToolContinuation[],
    context: RuntimeExecutionContext
): Promise<ApprovedToolContinuationResult[]> {
    const results: ApprovedToolContinuationResult[] = [];

    for (const continuation of continuations) {
        const restrictedContext: RuntimeExecutionContext = {
            userId: context.userId,
            spaceId: context.spaceId,
            chatId: context.chatId,
            channel: context.channel,
            channelRef: context.channelRef,
            allowedTools: [continuation.toolName],
            disabledTools: [],
        };

        try {
            const handlers = getRegisteredHandlersForContext(restrictedContext);
            const result = await executeToolCall({
                toolName: continuation.toolName,
                toolArgs: continuation.toolArgs,
                context: restrictedContext,
                handlers,
            });
            results.push({
                actionClass: continuation.actionClass,
                toolName: continuation.toolName,
                result,
            });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'The approved action failed without a safe diagnostic. Check the local service logs.';
            results.push({
                actionClass: continuation.actionClass,
                toolName: continuation.toolName,
                result: `[TOOL_RESULT] Approved action was not completed: ${message}`,
            });
        } finally {
            // If policy or authorization blocked execution before the approval
            // branch, do not leave a latent physical-action grant behind.
            revokeApprovalGrant(restrictedContext, continuation.actionClass);
        }
    }

    return results;
}

export function formatApprovedToolContinuationReply(results: ApprovedToolContinuationResult[]): string {
    return results
        .map(({ result }) => result.replace(/^\[TOOL_RESULT\]\s*/u, '').trim())
        .filter(Boolean)
        .join('\n\n');
}
