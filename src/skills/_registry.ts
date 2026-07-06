import { FunctionDeclaration } from '@google/genai';
import { CapabilityMeta, SkillManifest } from './_types';
import { getDb, getMembership, getResident, getSpace, memberHasTrustFlag } from '../db';
import { getAssistantPack } from '../core/assistant-pack';
import { getPackToolsForContext, executePackTool } from '../core/pack-tool-runtime';
import { resolveSpacePolicy } from '../core/policy';
import { deriveToolExecutionSpec, ToolExecutionSpec } from '../core/tool-execution';
import cron from 'node-cron';
import { resolveSpaceIdFromExecutionContext, RuntimeExecutionContext } from '../core/runtime-context';

// All skills imported statically (reliable, no dynamic magic)
import memorySkill from './memory.skill';
import shoppingSkill from './shopping.skill';
import todosSkill from './todos.skill';
import browsingSkill from './browsing.skill';
import webrunSkill from './webrun.skill';
import remindersSkill from './reminders.skill';
import spacesSkill from './spaces.skill';
import groundingSkill from './grounding.skill';
import projectsSkill from './projects.skill';
import tasksSkill from './tasks.skill';
import membersSkill from './members.skill';
import atelierSkill from './atelier.skill';
import workspaceSkill from './workspace.skill';
import workflowsSkill from './workflows.skill';
import historySkill from './history.skill';
import artifactsSkill from './artifacts.skill';
import htmlArtifactsSkill from './html-artifacts.skill';
import journalSkill from './journal.skill';
import ritualsSkill from './rituals.skill';
import pipiSetupSkill from './pipi_setup.skill';
import onboardingSkill from './onboarding.skill';
import helperSkill from './helper.skill';
import helperStatusSkill from './helper_status.skill';
import brainSkill from './brain.skill';

const ALL_SKILLS: SkillManifest[] = [
    memorySkill,
    shoppingSkill,
    todosSkill,
    browsingSkill,
    webrunSkill,
    remindersSkill,
    spacesSkill,
    groundingSkill,
    projectsSkill,
    tasksSkill,
    membersSkill,
    atelierSkill,
    workspaceSkill,
    workflowsSkill,
    historySkill,
    artifactsSkill,
    htmlArtifactsSkill,
    journalSkill,
    ritualsSkill,
    pipiSetupSkill,
    onboardingSkill,
    helperSkill,
    helperStatusSkill,
    brainSkill,
];

const DEFAULT_CAPABILITY_META: CapabilityMeta = {
    run_mode: 'inline',
    approval: 'none',
    cost: 'low',
    visibility: 'all',
    pack_tags: ['jeeves'],
};

const CORE_TOOL_EXECUTION_BASE: Record<string, Partial<ToolExecutionSpec>> = {
    web: { run_mode: 'sidecar', approval: 'explicit' },
    file_search: { run_mode: 'inline', approval: 'none' },
    user_info: { run_mode: 'inline', approval: 'none', capabilities: ['shell_none'] },
    personal_context: { run_mode: 'inline', approval: 'none', capabilities: ['shell_none'] },
    automations: { run_mode: 'inline', approval: 'none', capabilities: ['shell_none'] },
    api_tool: { run_mode: 'inline', approval: 'none', capabilities: ['shell_none'] },
    list_skills: { run_mode: 'inline', approval: 'none', capabilities: ['shell_none'] },
    request_new_skill: { run_mode: 'inline', approval: 'none', capabilities: ['shell_none'] },
    clear_skill_requests: { run_mode: 'inline', approval: 'none', capabilities: ['shell_none'] },
};

// Collected tools and handlers from all skills
const allTools: FunctionDeclaration[] = [];
const allHandlers: Record<string, (args: any, context?: RuntimeExecutionContext) => Promise<string>> = {};

export function getRegisteredTools(): FunctionDeclaration[] {
    return allTools;
}

export function getToolDeclarationForContext(
    toolName: string,
    context?: RuntimeExecutionContext
): FunctionDeclaration | undefined {
    const packTool = getPackToolsForContext(context).find((tool) => tool.id === toolName);
    if (packTool) {
        return packTool.declaration;
    }

    return ALL_SKILLS.flatMap((skill) => skill.tools).find((tool) => tool.name === toolName);
}

function isOwnerContext(context: RuntimeExecutionContext): boolean {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    const membership = spaceId ? getMembership(spaceId, context.userId) : undefined;
    if (membership && ['owner', 'admin'].includes(membership.role)) {
        return true;
    }

    return getResident(context.userId)?.role === 'owner';
}

function isSkillAllowedForContext(skill: SkillManifest, context: RuntimeExecutionContext): boolean {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    if (!spaceId) {
        return false;
    }
    const space = getSpace(spaceId);
    const pack = getAssistantPack(space?.assistant_pack_id || 'jeeves');
    const meta = getCapabilityMeta(skill.name);

    if (!pack.enabled_capabilities.includes(skill.name)) {
        return false;
    }

    if (meta.visibility === 'owner' && !isOwnerContext(context)) {
        return false;
    }

    if (meta.visibility === 'policy') {
        if (!meta.policy_gate) return false;
        const policy = resolveSpacePolicy(spaceId);
        if (policy[meta.policy_gate] !== true) {
            return false;
        }
    }

    if (meta.required_trust_flag) {
        return memberHasTrustFlag(spaceId, context.userId, meta.required_trust_flag);
    }

    if (meta.requires_workspace) {
        const policy = resolveSpacePolicy(spaceId);
        return !!policy.workspace_path;
    }

    return true;
}

export function getRegisteredToolsForContext(context?: RuntimeExecutionContext): FunctionDeclaration[] {
    if (!context) return allTools;

    const skillTools = ALL_SKILLS.filter((skill) => isSkillAllowedForContext(skill, context)).flatMap(
        (skill) => skill.tools
    );

    const packTools = getPackToolsForContext(context).map((tool) => tool.declaration);
    return [...skillTools, ...packTools];
}

export function getRegisteredHandlers(): Record<
    string,
    (args: any, context?: RuntimeExecutionContext) => Promise<string>
> {
    return allHandlers;
}

export function getRegisteredHandlersForContext(
    context?: RuntimeExecutionContext
): Record<string, (args: any, context?: RuntimeExecutionContext) => Promise<string>> {
    if (!context) {
        return allHandlers;
    }

    const handlers = { ...allHandlers };
    for (const tool of getPackToolsForContext(context)) {
        handlers[tool.id] = async (args: any, runtimeContext?: RuntimeExecutionContext) =>
            executePackTool(tool.id, args, runtimeContext || context);
    }

    return handlers;
}

export function getRegisteredSkills(): SkillManifest[] {
    return ALL_SKILLS;
}

export function getCapabilityMeta(skillName: string): CapabilityMeta {
    const skill = ALL_SKILLS.find((item) => item.name === skillName);
    return {
        ...DEFAULT_CAPABILITY_META,
        ...(skill?.meta || {}),
    };
}

export function getRegisteredCapabilities(): Array<{
    skill: string;
    description: string;
    meta: CapabilityMeta;
    tools: string[];
}> {
    return ALL_SKILLS.map((skill) => ({
        skill: skill.name,
        description: skill.description,
        meta: getCapabilityMeta(skill.name),
        tools: skill.tools.map((tool) => tool.name).filter((name): name is string => Boolean(name)),
    }));
}

export function getRegisteredCapabilitiesForContext(context?: RuntimeExecutionContext): Array<{
    skill: string;
    description: string;
    meta: CapabilityMeta;
    tools: string[];
}> {
    if (!context) {
        return getRegisteredCapabilities();
    }

    return getRegisteredCapabilities().filter((capability) => {
        const skill = ALL_SKILLS.find((item) => item.name === capability.skill);
        return skill ? isSkillAllowedForContext(skill, context) : false;
    });
}

export function getToolExecutionSpecForContext(
    toolName: string,
    args: any,
    context?: RuntimeExecutionContext
): ToolExecutionSpec {
    const packTool = getPackToolsForContext(context).find((tool) => tool.id === toolName);
    if (packTool) {
        return deriveToolExecutionSpec(toolName, args, packTool.execution);
    }

    const skill = ALL_SKILLS.find((item) => item.tools.some((tool) => tool.name === toolName));
    if (skill) {
        const meta = getCapabilityMeta(skill.name);
        return deriveToolExecutionSpec(toolName, args, {
            run_mode: meta.run_mode,
            approval: meta.approval,
            audit_default: 'errors',
        });
    }

    return deriveToolExecutionSpec(toolName, args, CORE_TOOL_EXECUTION_BASE[toolName]);
}

export async function initAllSkills(): Promise<void> {
    console.log(`[REGISTRY] Initializing ${ALL_SKILLS.length} skills...`);

    for (const skill of ALL_SKILLS) {
        // 1. Run migrations
        if (skill.migrations) {
            const db = getDb();
            for (const sql of skill.migrations) {
                try {
                    db.exec(sql);
                } catch {
                    // Ignore "already exists" errors
                }
            }
        }

        // 2. Collect tools
        allTools.push(...skill.tools);

        // 3. Collect handlers
        for (const [toolName, handler] of Object.entries(skill.handlers)) {
            if (allHandlers[toolName]) {
                console.warn(
                    `[REGISTRY] Duplicate handler for tool "${toolName}" from skill "${skill.name}". Overwriting.`
                );
            }
            allHandlers[toolName] = handler;
        }

        // 4. Register cron jobs
        if (skill.crons) {
            for (const job of skill.crons) {
                cron.schedule(
                    job.expression,
                    async () => {
                        try {
                            await job.handler();
                        } catch (err) {
                            console.error(`[CRON] Error in ${skill.name}/${job.description}:`, err);
                        }
                    },
                    { timezone: process.env.TZ || 'UTC' }
                );
                console.log(`  [CRON] ${skill.name}: ${job.description} (${job.expression})`);
            }
        }

        // 5. Run skill init
        if (skill.init) {
            try {
                await skill.init();
            } catch (err) {
                console.error(`[REGISTRY] Failed to init skill "${skill.name}":`, err);
            }
        }

        console.log(`  [OK] ${skill.name} v${skill.version} — ${skill.tools.length} tools`);
    }

    console.log(`[REGISTRY] Total: ${allTools.length} tools, ${Object.keys(allHandlers).length} handlers`);
}
