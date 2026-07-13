import { beforeEach, describe, expect, it, vi } from 'vitest';

const processWithLLM = vi.fn(async () => ({
    text: JSON.stringify({
        status: 'completed',
        summary: 'Compared the options',
        facts: { winner: 'B' },
        blockers: [],
        next_step: 'Parent review',
        confidence: 0.8,
    }),
}));

vi.mock('../core/llm', () => ({ processWithLLM }));
vi.mock('../core/agent-kernel', () => ({
    materializeAgentForSpace: vi.fn(() => ({
        family_members: [
            {
                id: 'researcher',
                role: 'Researcher',
                character: 'Sherlock Holmes',
                instructions: ['Separate evidence from inference.'],
            },
        ],
    })),
}));
vi.mock('../core/runtime-context', async (importOriginal) => {
    const original = await importOriginal<typeof import('../core/runtime-context')>();
    return { ...original, resolveSpaceIdFromExecutionContext: vi.fn(() => 'telegram:team') };
});

beforeEach(() => processWithLLM.mockClear());

describe('skills/family', () => {
    it('delegates a bounded contract and disables recursive delegation', async () => {
        const { default: skill } = await import('./family.skill');
        const result = await skill.handlers.family_delegate(
            { member_id: 'researcher', goal: 'Compare options', must_collect: ['evidence'] },
            { userId: 'owner', spaceId: 'telegram:team' }
        );

        expect(result).toContain('[WORK_RESULT]');
        expect(result).toContain('Compared the options');
        expect(processWithLLM).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({ disabledTools: ['family_delegate'] })
        );
    });

    it('rejects members not declared by the pack', async () => {
        const { default: skill } = await import('./family.skill');
        const result = await skill.handlers.family_delegate(
            { member_id: 'unknown', goal: 'Do work' },
            { userId: 'owner', spaceId: 'telegram:team' }
        );

        expect(result).toContain('Unknown family member');
        expect(processWithLLM).not.toHaveBeenCalled();
    });
});
