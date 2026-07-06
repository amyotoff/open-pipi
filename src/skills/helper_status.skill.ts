import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDailyTokenCost, getSpace, getSpaceGroundingLevel, listGroundingOverrides, memberHasTrustFlag } from '../db';
import { resolveSpacePolicy } from '../core/policy';
import { materializeGroundingForSpace } from '../core/grounding-loader';
import { materializeAgentForSpace } from '../core/agent-kernel';
import { getLatestRuntimeBackup } from '../core/runtime-backup';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

type ExecutionContext = Partial<RuntimeExecutionContext>;

const LEVEL_LABELS: Record<number, string> = {
    0: 'L0 — no overrides yet',
    1: 'L1 — people recorded',
    2: 'L2 — rules or org recorded',
    3: 'L3 — full context',
};

const skill: SkillManifest = {
    name: 'helper_status',
    description:
        "Owner-only runtime status reporter: active pack, grounding, policy, latest backup, and today's global token spend",
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'low',
        visibility: 'owner',
        required_trust_flag: 'can_change_policies',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },
    tools: [
        {
            name: 'helper_self_status',
            description:
                'Report the bot\'s own runtime state for this space: active pack, grounding, level, policy, latest backup, and today\'s runtime-wide token spend (input/output tokens, cost in USD, call count). Call when an owner asks about the bot\'s current state, health, budget, or spending: "how are you", "как дела", "which pack are you on", "how much have you spent today", "what\'s the budget". Token cost is tracked globally across the runtime, NOT per space — say so when answering. Owner-only; non-owners cannot call this tool.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
    ],
    handlers: {
        async helper_self_status(_: Record<string, never>, context?: ExecutionContext) {
            if (!context?.userId) {
                return '[TOOL_RESULT] helper_self_status requires an active chat context.';
            }

            const spaceId = resolveSpaceIdFromExecutionContext(context);
            if (!spaceId) {
                return '[TOOL_RESULT] helper_self_status requires an active chat context.';
            }

            if (!memberHasTrustFlag(spaceId, context.userId, 'can_change_policies')) {
                return '[TOOL_RESULT] Only owners can see runtime status.';
            }

            const space = getSpace(spaceId);
            if (!space) {
                return '[TOOL_RESULT] Space not initialized yet — send any message first.';
            }

            const agent = materializeAgentForSpace(spaceId);
            const grounding = materializeGroundingForSpace(spaceId);
            const policy = resolveSpacePolicy(spaceId);
            const level = getSpaceGroundingLevel(spaceId);
            const overrides = listGroundingOverrides(spaceId);
            const latestBackup = getLatestRuntimeBackup();

            const backupLine = latestBackup
                ? `Latest backup: ${latestBackup.id} (${latestBackup.created_at}, health=${latestBackup.health_status})`
                : 'Latest backup: none yet';

            const today = new Date().toISOString().split('T')[0];
            const usage = getDailyTokenCost(today);
            const costStr = `$${usage.cost_usd.toFixed(4)}`;
            const spendLine = `Today's spend (${today}, runtime-wide, not per-space): ${usage.input_tokens} in + ${usage.output_tokens} out tokens across ${usage.calls} calls ≈ ${costStr}`;

            const lines = [
                `[TOOL_RESULT] Self status — ${spaceId}`,
                `Pack: ${agent.id} / ${agent.persona_id}`,
                `Grounding: ${grounding.id} — ${grounding.title}`,
                `Language: ${grounding.default_language || 'not set'} | Timezone: ${grounding.timezone || 'not set'}`,
                `Grounding level: ${LEVEL_LABELS[level]} (${overrides.length} override${overrides.length !== 1 ? 's' : ''})`,
                `Policy: browser=${policy.browser}, tasks=${policy.tasks}, memory_sprint_days=${policy.memory_sprint_days}`,
                backupLine,
                spendLine,
            ];

            return lines.join('\n');
        },
    },
};

export default skill;
