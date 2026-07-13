import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { materializeAgentForSpace } from '../core/agent-kernel';
import { processWithLLM } from '../core/llm';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { createWorkContract, parseWorkResult, renderWorkContract } from '../core/work-contract';

type DelegateArgs = {
    member_id: string;
    goal: string;
    context?: string;
    context_refs?: string[];
    must_collect?: string[];
    decision_rights?: string[];
    forbidden_actions?: string[];
    fallback?: string[];
    result_contract?: string[];
};

const skill: SkillManifest = {
    name: 'family',
    description: 'Delegate bounded work to another role in the current assistant family',
    version: '1.0.0',
    meta: {
        run_mode: 'sidecar',
        approval: 'none',
        cost: 'medium',
        visibility: 'all',
        pack_tags: ['office'],
    },
    tools: [
        {
            name: 'family_delegate',
            description:
                'Delegate a bounded task to a named member of this assistant family. Use a clear goal, limits, and expected result instead of an open-ended chat.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    member_id: { type: Type.STRING, description: 'Family member id exposed by the current pack.' },
                    goal: { type: Type.STRING, description: 'Concrete outcome the delegate must produce.' },
                    context: { type: Type.STRING, description: 'Only the context needed to complete this task.' },
                    context_refs: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Relevant Company Wiki pages, files, URLs, or message references.',
                    },
                    must_collect: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Facts or evidence that must be present in the result.',
                    },
                    decision_rights: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Decisions the delegate may make without returning to the parent agent.',
                    },
                    forbidden_actions: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Actions the delegate must not take.',
                    },
                    fallback: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Safe alternatives when the preferred route is blocked.',
                    },
                    result_contract: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: 'Fields or sections expected in the returned result.',
                    },
                },
                required: ['member_id', 'goal'],
            },
        },
    ],
    handlers: {
        async family_delegate(args: DelegateArgs, context?: RuntimeExecutionContext) {
            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!context || !spaceId) {
                return '[TOOL_RESULT] Family delegation requires an active space.';
            }

            const agent = materializeAgentForSpace(spaceId);
            const member = (agent.family_members || []).find((candidate) => candidate.id === args.member_id);
            if (!member) {
                const available = (agent.family_members || []).map((candidate) => candidate.id).join(', ');
                return `[TOOL_RESULT] Unknown family member "${args.member_id}". Available: ${available || 'none'}.`;
            }

            let contract;
            try {
                contract = createWorkContract(args);
            } catch (error) {
                return `[TOOL_RESULT] ${error instanceof Error ? error.message : 'Invalid work contract.'}`;
            }

            const systemPrompt = [
                `You are the ${member.role} in an assistant family.`,
                `Behavioral calibration: ${member.character}.`,
                ...member.instructions.map((instruction) => `- ${instruction}`),
                '- Use the character only to calibrate decisions and working behavior.',
                '- Do not imitate fictional speech, quotes, mannerisms, setting, or biography.',
                '- Work only inside the supplied contract. Do not silently expand your authority.',
                '- Return one JSON object with: status, summary, facts, blockers, next_step, confidence.',
                '- status must be completed, partial, blocked, or failed; confidence must be from 0 to 1.',
            ].join('\n');

            const response = await processWithLLM(
                [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `WORK CONTRACT\n${renderWorkContract(contract)}` },
                ],
                {
                    ...context,
                    spaceId,
                    allowedTools: member.allowed_tools.filter(
                        (toolName) => !context.allowedTools || context.allowedTools.includes(toolName)
                    ),
                    disabledTools: [...new Set([...(context.disabledTools || []), 'family_delegate'])],
                }
            );
            const result = parseWorkResult(response.text);
            return `[WORK_RESULT]\n${JSON.stringify({ member_id: member.id, role: member.role, ...result }, null, 2)}`;
        },
    },
};

export default skill;
