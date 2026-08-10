import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadApprovalsModule() {
    vi.resetModules();
    return await import('./approvals');
}

afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
});

describe('tool approvals', () => {
    it('requires approval before a risky tool can run', async () => {
        const approvals = await loadApprovalsModule();

        const message = approvals.requireToolApproval(
            'browse_web',
            { chatId: 'chat-1', userId: 'user-1' },
            'opening a public website'
        );

        expect(message).toMatch(/Требуется явное подтверждение/i);
        expect(approvals.listPendingApprovalActions({ chatId: 'chat-1', userId: 'user-1' })).toEqual(['browse_web']);
    });

    it('uses the tool name as a safe action class for new explicit tools', async () => {
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-new', userId: 'user-new' };

        expect(approvals.requireToolApproval('publish_report', context, 'publishing a report')).toContain(
            'publish_report'
        );
        expect(approvals.listPendingApprovalActions(context)).toEqual(['publish_report']);
    });

    it('grants approval after an affirmative reply when exactly one action is pending', async () => {
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-2', userId: 'user-2' };

        approvals.requireToolApproval('browse_web', context, 'opening a public website');
        const response = approvals.recordApprovalResponse(context, 'да, разрешаю');
        const followUp = approvals.requireToolApproval('browse_web', context, 'opening a public website');

        expect(response.granted).toContain('browse_web');
        expect(followUp).toBeNull();
    });

    it('consumes single-use approval after one matching action', async () => {
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-physical', userId: 'user-physical' };
        const actionClass = 'home_assistant_control_a1b2c3';

        approvals.requireSingleUseToolApproval(
            'home_assistant_control',
            context,
            'turning on light.kitchen',
            actionClass
        );
        approvals.approvePendingAction(context, actionClass);

        expect(
            approvals.requireSingleUseToolApproval(
                'home_assistant_control',
                context,
                'turning on light.kitchen',
                actionClass
            )
        ).toBeNull();
        expect(
            approvals.requireSingleUseToolApproval(
                'home_assistant_control',
                context,
                'turning on light.kitchen',
                actionClass
            )
        ).toMatch(/Требуется явное подтверждение/i);
    });

    it('returns one cloned continuation only to the matching scope and user', async () => {
        const approvals = await loadApprovalsModule();
        const context = { spaceId: 'telegram:home', chatId: 'home', userId: 'owner' };
        const toolArgs = { entity_id: 'light.kitchen', action: 'turn_off', nested: { marker: 'original' } };

        approvals.requireResumableSingleUseToolApproval(
            'home_assistant_control',
            context,
            'turning off light.kitchen',
            'home_assistant_control_exact',
            toolArgs
        );
        toolArgs.nested.marker = 'mutated';

        expect(approvals.recordApprovalResponse({ ...context, userId: 'someone-else' }, 'да')).toEqual({
            granted: [],
            denied: [],
        });
        const approved = approvals.recordApprovalResponse(context, 'да');

        expect(approved).toMatchObject({ granted: ['home_assistant_control_exact'], denied: [] });
        expect(approved.continuations).toEqual([
            {
                actionClass: 'home_assistant_control_exact',
                toolName: 'home_assistant_control',
                toolArgs: {
                    entity_id: 'light.kitchen',
                    action: 'turn_off',
                    nested: { marker: 'original' },
                },
            },
        ]);
        expect(approvals.recordApprovalResponse(context, 'да')).toEqual({ granted: [], denied: [] });
    });

    it('fails closed on mixed affirmative and negative language', async () => {
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-mixed', userId: 'owner' };

        for (const text of ['да не надо', 'yes, cancel']) {
            approvals.requireResumableSingleUseToolApproval(
                'home_assistant_control',
                context,
                'turning off light.kitchen',
                'home_assistant_control_exact',
                { entity_id: 'light.kitchen', action: 'turn_off' }
            );
            const response = approvals.recordApprovalResponse(context, text);

            expect(response).toEqual({ granted: [], denied: ['home_assistant_control_exact'] });
            expect(response.continuations).toBeUndefined();
        }
    });

    it('requires an unambiguous full affirmative for a resumable physical call', async () => {
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-physical-words', userId: 'owner' };
        approvals.requireResumableSingleUseToolApproval(
            'home_assistant_control',
            context,
            'turning off light.kitchen',
            'home_assistant_control_exact',
            { entity_id: 'light.kitchen', action: 'turn_off' }
        );

        expect(approvals.recordApprovalResponse(context, 'ок')).toEqual({ granted: [], denied: [] });
        expect(approvals.listPendingApprovalActions(context)).toEqual(['home_assistant_control_exact']);
        expect(approvals.recordApprovalResponse(context, 'да')).toMatchObject({
            granted: ['home_assistant_control_exact'],
            denied: [],
        });
    });

    it('does not auto-grant when more than one action class is pending', async () => {
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-3', userId: 'user-3' };

        approvals.requireToolApproval('browse_web', context, 'opening a public website');
        approvals.requireToolApproval('webrun_execute', context, 'running deep research');
        const response = approvals.recordApprovalResponse(context, 'yes');

        expect(response).toEqual({ granted: [], denied: [] });
        expect(approvals.listPendingApprovalActions(context)).toEqual(['browse_web', 'deep_research']);
    });

    it('supports explicit approval and denial by action class', async () => {
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-4', userId: 'user-4' };

        approvals.requireToolApproval('browse_web', context, 'opening a public website');
        approvals.requireToolApproval('webrun_execute', context, 'running deep research');

        expect(approvals.approvePendingAction(context, 'browse_web')).toEqual({
            granted: ['browse_web'],
            denied: [],
            pending: ['deep_research'],
        });
        expect(approvals.denyPendingAction(context, 'deep_research')).toEqual({
            granted: [],
            denied: ['deep_research'],
            pending: [],
        });
    });

    it('expires granted approvals after the TTL', async () => {
        vi.useFakeTimers();
        const approvals = await loadApprovalsModule();
        const context = { chatId: 'chat-5', userId: 'user-5' };

        approvals.requireToolApproval('webrun_execute', context, 'deep research');
        approvals.approvePendingAction(context, 'deep_research');
        vi.advanceTimersByTime(2 * 60 * 1000 + 1);

        const followUp = approvals.requireToolApproval('webrun_execute', context, 'deep research');
        expect(followUp).toMatch(/Требуется явное подтверждение/i);
    });

    it('keeps approvals isolated by scope', async () => {
        const approvals = await loadApprovalsModule();
        approvals.requireToolApproval(
            'browse_web',
            { chatId: 'chat-6', userId: 'user-6', spaceId: 'telegram:alpha' },
            'alpha browse'
        );
        approvals.approvePendingAction({ chatId: 'chat-6', userId: 'user-6', spaceId: 'telegram:alpha' }, 'browse_web');

        const followUp = approvals.requireToolApproval(
            'browse_web',
            { chatId: 'chat-6', userId: 'user-6', spaceId: 'telegram:beta' },
            'beta browse'
        );
        expect(followUp).toMatch(/Требуется явное подтверждение/i);
    });
});
