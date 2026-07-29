/**
 * What an owner sees when asked to approve something.
 *
 * The reason on its own names a category of action. These tests pin that the
 * arguments which change the answer reach the person deciding.
 */

import { describe, expect, it } from 'vitest';
import { describeApprovalRequest } from './tool-executor';
import type { ToolExecutionSpec } from './tool-execution';

function spec(overrides: Partial<ToolExecutionSpec> = {}): ToolExecutionSpec {
    return {
        tool_name: 'delegate_phone_call',
        run_mode: 'sidecar',
        capabilities: [],
        approval: 'explicit',
        approval_reason: 'placing a real phone call to a third party on your behalf',
        approval_detail_fields: ['phone', 'contact_name', 'goal'],
        audit_default: 'errors',
        ...overrides,
    };
}

describe('describing what is being approved', () => {
    it('names the number, not just the kind of action', () => {
        const prompt = describeApprovalRequest(spec(), {
            phone: '+391234567890',
            contact_name: 'Trattoria da Bruno',
            goal: 'Book a table for two at 20:00',
        });

        // Approving "a phone call" without knowing to whom is not a decision.
        expect(prompt).toContain('+391234567890');
        expect(prompt).toContain('Trattoria da Bruno');
        expect(prompt).toContain('placing a real phone call');
    });

    it('falls back to the bare reason when a tool declares no detail fields', () => {
        const prompt = describeApprovalRequest(spec({ approval_detail_fields: undefined }), { phone: '+391234567890' });

        expect(prompt).toBe('placing a real phone call to a third party on your behalf');
    });

    it('skips fields that are absent rather than showing empty labels', () => {
        const prompt = describeApprovalRequest(spec(), { phone: '+391234567890', contact_name: '', goal: null });

        expect(prompt).toContain('phone: +391234567890');
        expect(prompt).not.toContain('contact_name');
        expect(prompt).not.toContain('goal');
    });

    it('keeps the prompt readable when an argument is long', () => {
        const prompt = describeApprovalRequest(spec(), { phone: '+391234567890', goal: 'x'.repeat(500) });

        // It still has to fit in a chat message the owner will actually read.
        expect(prompt.length).toBeLessThan(300);
        expect(prompt).toContain('…');
    });

    it('renders a list argument without printing [object Object]', () => {
        const prompt = describeApprovalRequest(spec({ approval_detail_fields: ['important_details'] }), {
            important_details: ['two people', 'window table'],
        });

        expect(prompt).toContain('two people; window table');
    });

    it('still says something when a tool has no reason configured at all', () => {
        const prompt = describeApprovalRequest(spec({ approval_reason: undefined, approval_detail_fields: [] }), {});

        expect(prompt).toContain('delegate_phone_call');
    });
});
