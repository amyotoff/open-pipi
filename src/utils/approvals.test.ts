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
