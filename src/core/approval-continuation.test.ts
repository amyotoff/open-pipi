import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadContinuation(executeImpl: () => Promise<string>) {
    vi.resetModules();
    const handler = vi.fn(async () => 'handler result');
    const getRegisteredHandlersForContext = vi.fn(() => ({ home_assistant_control: handler }));
    const executeToolCall = vi.fn(executeImpl);
    const revokeApprovalGrant = vi.fn();

    vi.doMock('../skills/_registry', () => ({ getRegisteredHandlersForContext }));
    vi.doMock('./tool-executor', () => ({ executeToolCall }));
    vi.doMock('../utils/approvals', () => ({ revokeApprovalGrant }));

    const module = await import('./approval-continuation');
    return { module, getRegisteredHandlersForContext, executeToolCall, revokeApprovalGrant };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('approved tool continuation', () => {
    it('re-enters the normal executor with only the exact stored tool and a fresh context', async () => {
        const { module, getRegisteredHandlersForContext, executeToolCall, revokeApprovalGrant } =
            await loadContinuation(async () => '[TOOL_RESULT] executed once');
        const continuation = {
            actionClass: 'home_assistant_control_exact',
            toolName: 'home_assistant_control',
            toolArgs: { entity_id: 'light.kitchen', action: 'turn_off' },
        };

        const results = await module.executeApprovedToolContinuations([continuation], {
            userId: 'owner',
            spaceId: 'telegram:home',
            chatId: 'home',
            channel: 'telegram',
            channelRef: 'home',
            taskId: 'must-not-propagate',
            toolExecutionId: 999,
            allowedTools: ['family_delegate', 'home_assistant_control'],
            disabledTools: ['unrelated'],
        });

        const restrictedContext = {
            userId: 'owner',
            spaceId: 'telegram:home',
            chatId: 'home',
            channel: 'telegram',
            channelRef: 'home',
            allowedTools: ['home_assistant_control'],
            disabledTools: [],
        };
        expect(getRegisteredHandlersForContext).toHaveBeenCalledWith(restrictedContext);
        expect(executeToolCall).toHaveBeenCalledWith({
            toolName: 'home_assistant_control',
            toolArgs: continuation.toolArgs,
            context: restrictedContext,
            handlers: { home_assistant_control: expect.any(Function) },
        });
        expect(results).toEqual([
            {
                actionClass: continuation.actionClass,
                toolName: continuation.toolName,
                result: '[TOOL_RESULT] executed once',
            },
        ]);
        expect(revokeApprovalGrant).toHaveBeenCalledWith(restrictedContext, continuation.actionClass);
    });

    it('returns a safe failure and revokes a latent grant when execution throws', async () => {
        const { module, revokeApprovalGrant } = await loadContinuation(async () => {
            throw new Error('Home Assistant outcome is unknown; inspect state before retrying.');
        });
        const continuation = {
            actionClass: 'home_assistant_control_exact',
            toolName: 'home_assistant_control',
            toolArgs: { entity_id: 'light.kitchen', action: 'turn_off' },
        };

        const [result] = await module.executeApprovedToolContinuations([continuation], {
            userId: 'owner',
            spaceId: 'telegram:home',
        });

        expect(result.result).toContain('Approved action was not completed');
        expect(result.result).toContain('outcome is unknown');
        expect(revokeApprovalGrant).toHaveBeenCalledTimes(1);
    });
});
