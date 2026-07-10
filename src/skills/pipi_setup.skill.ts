import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { BOT_DISPLAY_NAME } from '../config';
import { getSpace, getSpaceGroundingLevel, listGroundingOverrides, memberHasTrustFlag } from '../db';
import { resolveSpacePolicy } from '../core/policy';
import { materializeGroundingForSpace } from '../core/grounding-loader';
import { materializeAgentForSpace } from '../core/agent-kernel';
import { applyJeevesDefaultsForSpace } from '../core/jeeves-mvp';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';
import { createRuntimeBackup, getLatestHealthyRuntimeBackup, getLatestRuntimeBackup } from '../core/runtime-backup';

type ExecutionContext = Partial<RuntimeExecutionContext>;

function requirePolicyAuthority(
    context?: ExecutionContext
): { ok: true; spaceId: string } | { ok: false; message: string } {
    if (!context?.userId) {
        return { ok: false, message: '[TOOL_RESULT] pipi_setup requires an active chat context.' };
    }

    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return { ok: false, message: '[TOOL_RESULT] pipi_setup requires an active chat context.' };
    }

    if (!memberHasTrustFlag(spaceId, context.userId, 'can_change_policies')) {
        return { ok: false, message: '[TOOL_RESULT] Only owners can run setup in this space.' };
    }

    return { ok: true, spaceId };
}

const LEVEL_LABELS: Record<number, string> = {
    0: 'L0 — no overrides yet',
    1: 'L1 — people recorded',
    2: 'L2 — rules or org recorded',
    3: 'L3 — full context',
};

function buildStartPreview(grounding: ReturnType<typeof materializeGroundingForSpace>, level: number): string {
    const isRu = grounding.default_language === 'ru';
    if (level > 0) {
        return isRu ? 'Привет. Слушаю.' : 'Hi. Ready when you are.';
    }
    const desc = grounding.description || grounding.title;
    return isRu
        ? `Привет. Я ${BOT_DISPLAY_NAME} — ${desc}.\nГовори что нужно: задача, напоминание, вопрос, мысль вслух.`
        : `Hi. I'm ${BOT_DISPLAY_NAME} — ${desc}.\nTell me what you need: a task, reminder, question, or just think out loud.`;
}

const skill: SkillManifest = {
    name: 'pipi_setup',
    description: 'Operator tools for inspecting, configuring, and smoke-testing this space before and after deploy',
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
            name: 'pipi_status',
            description:
                'Show operator status for this space: pack, grounding, level, policy, and /start preview. Use this to verify configuration before or after deploy.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'pipi_apply_defaults',
            description:
                'Apply pack defaults to this space: activate scheduled tasks, set recommended policy, and register the grounding. Equivalent to the former /jeeves setup.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'pipi_smoke',
            description:
                'Quick smoke check: shows what the bot currently knows about this space — world model, people, overrides, and the /start message it would send.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'pipi_backup_status',
            description: 'Show the latest local restore point created for this runtime.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'pipi_backup_now',
            description: 'Create a manual local restore point for this runtime.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
    ],
    handlers: {
        async pipi_status(_: Record<string, never>, context?: ExecutionContext) {
            const auth = requirePolicyAuthority(context);
            if (!auth.ok) return auth.message;

            const { spaceId } = auth;
            const space = getSpace(spaceId);
            if (!space) return '[TOOL_RESULT] Space not initialized. Send any message first.';

            const agent = materializeAgentForSpace(spaceId);
            const grounding = materializeGroundingForSpace(spaceId);
            const policy = resolveSpacePolicy(spaceId);
            const level = getSpaceGroundingLevel(spaceId);
            const overrides = listGroundingOverrides(spaceId);
            const latestBackup = getLatestRuntimeBackup();
            const latestHealthyBackup = getLatestHealthyRuntimeBackup();

            const lines = [
                `[TOOL_RESULT] Setup status — ${spaceId}`,
                `Pack: ${agent.id} / ${agent.persona_id}`,
                `Grounding: ${grounding.id} — ${grounding.title}`,
                grounding.description ? `Description: ${grounding.description}` : null,
                `Language: ${grounding.default_language || 'not set'} | Timezone: ${grounding.timezone || 'not set'}`,
                `Grounding level: ${LEVEL_LABELS[level]} (${overrides.length} override${overrides.length !== 1 ? 's' : ''})`,
                `Policy: browser=${policy.browser}, tasks=${policy.tasks}, memory_sprint_days=${policy.memory_sprint_days}`,
                latestBackup
                    ? `Latest restore point: ${latestBackup.id} (${latestBackup.created_at}, ${latestBackup.file_count} files)`
                    : 'Latest restore point: none yet',
                latestHealthyBackup
                    ? `Latest healthy restore point: ${latestHealthyBackup.id} (${latestHealthyBackup.created_at})`
                    : 'Latest healthy restore point: none yet',
                `\n/start preview:\n"${buildStartPreview(grounding, level)}"`,
            ];

            return lines.filter(Boolean).join('\n');
        },

        async pipi_apply_defaults(_: Record<string, never>, context?: ExecutionContext) {
            const auth = requirePolicyAuthority(context);
            if (!auth.ok) return auth.message;

            const result = await applyJeevesDefaultsForSpace(auth.spaceId);
            return `[TOOL_RESULT] ${result}`;
        },

        async pipi_smoke(_: Record<string, never>, context?: ExecutionContext) {
            const auth = requirePolicyAuthority(context);
            if (!auth.ok) return auth.message;

            const { spaceId } = auth;
            const grounding = materializeGroundingForSpace(spaceId);
            const level = getSpaceGroundingLevel(spaceId);
            const overrides = listGroundingOverrides(spaceId);

            const lines: string[] = [`[TOOL_RESULT] Smoke check — ${spaceId}`, `Grounding level: ${level}/3`];

            if (grounding.grounding_text) {
                const firstLine = grounding.grounding_text.split('\n').find((l) => l.trim());
                if (firstLine) lines.push(`World model: ${firstLine}`);
            }

            if (grounding.people_text) {
                const firstPerson = grounding.people_text.split('\n').find((l) => l.startsWith('##'));
                if (firstPerson) lines.push(`First person: ${firstPerson.replace('## ', '')}`);
            }

            if (overrides.length > 0) {
                lines.push(`Overrides: ${overrides.map((o) => `${o.kind}/${o.subject}`).join(', ')}`);
            } else {
                lines.push('Overrides: none — bot will capture context from conversation');
            }

            lines.push(`\n/start would say:\n"${buildStartPreview(grounding, level)}"`);

            return lines.join('\n');
        },

        async pipi_backup_status(_: Record<string, never>, context?: ExecutionContext) {
            const auth = requirePolicyAuthority(context);
            if (!auth.ok) return auth.message;

            const latestBackup = getLatestRuntimeBackup();
            const latestHealthyBackup = getLatestHealthyRuntimeBackup();
            if (!latestBackup) {
                return '[TOOL_RESULT] No restore points have been created yet.';
            }

            const warningLine =
                latestBackup.warnings.length > 0 ? `\nWarnings: ${latestBackup.warnings.join(' | ')}` : '';
            return `[TOOL_RESULT] Latest restore point
ID: ${latestBackup.id}
Created: ${latestBackup.created_at}
Version: ${latestBackup.app_version}
Health: ${latestBackup.health_status}
Files: ${latestBackup.file_count}
Size: ${latestBackup.total_bytes} bytes
Spaces: ${latestBackup.counts.spaces}
Memory entries: ${latestBackup.counts.memory_entries}
Tasks: ${latestBackup.counts.tasks}
Artifacts: ${latestBackup.counts.artifacts}
Latest healthy restore point: ${latestHealthyBackup?.id || 'none yet'}${warningLine}`;
        },

        async pipi_backup_now(_: Record<string, never>, context?: ExecutionContext) {
            const auth = requirePolicyAuthority(context);
            if (!auth.ok) return auth.message;

            const backup = await createRuntimeBackup('manual');
            const warningLine = backup.warnings.length > 0 ? ` Warnings: ${backup.warnings.join(' | ')}` : '';
            return `[TOOL_RESULT] Created restore point ${backup.id}. Files: ${backup.file_count}. Spaces: ${backup.counts.spaces}. Memory entries: ${backup.counts.memory_entries}.${warningLine}`;
        },
    },
};

export default skill;
