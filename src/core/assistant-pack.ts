import { loadInstallablePack, listInstallablePackIds } from './pack-loader';
import { materializeCoreToolbox } from './coretoolbox';
import { AssistantPack, MaterializedAgent, SeededTaskTemplate } from './pack-types';

export type { AssistantPack, MaterializedAgent, SeededTaskTemplate } from './pack-types';

const DEFAULT_INSTALLABLE_PACK_ID = 'jeeves';

function materializeMissingPackShim(id: string): MaterializedAgent {
    return {
        id,
        persona_id: id,
        system_prompt_path: null,
        enabled_capabilities: [],
        memory_rules: ['person', 'space', 'work'],
        seeded_tasks: [],
        default_policies: {},
        authority_presets: {},
        system_prompt: [
            `The requested assistant pack "${id}" is not installed.`,
            'Do not pretend to have pack-specific capabilities.',
            'Explain the missing pack plainly and ask an owner to install or switch packs.',
        ].join('\n'),
        skills_doc: '',
        tools_doc: '',
        character_doc: '',
        core_toolbox: materializeCoreToolbox([]),
        pack_tools: [],
        source: 'static',
        pack_root: null,
    };
}

export function materializeAgentForPack(id: string = DEFAULT_INSTALLABLE_PACK_ID): MaterializedAgent {
    const installed = loadInstallablePack(id);
    if (installed) {
        return installed;
    }

    return materializeMissingPackShim(id);
}

export function getAssistantPack(id: string = DEFAULT_INSTALLABLE_PACK_ID): AssistantPack {
    const agent = materializeAgentForPack(id);
    return {
        id: agent.id,
        persona_id: agent.persona_id,
        system_prompt_path: agent.system_prompt_path,
        enabled_capabilities: agent.enabled_capabilities,
        memory_rules: agent.memory_rules,
        seeded_tasks: agent.seeded_tasks,
        default_policies: agent.default_policies,
        authority_presets: agent.authority_presets,
        onboarding_hints: agent.onboarding_hints,
        family_members: agent.family_members,
    };
}

export function getAssistantPackIds(): string[] {
    const ids = listInstallablePackIds();
    return ids.length > 0 ? ids : [DEFAULT_INSTALLABLE_PACK_ID];
}

export function getSeededTasksForPack(id: string = DEFAULT_INSTALLABLE_PACK_ID): SeededTaskTemplate[] {
    return materializeAgentForPack(id).seeded_tasks;
}

export function getSystemPromptForPack(id: string = DEFAULT_INSTALLABLE_PACK_ID): string {
    return materializeAgentForPack(id).system_prompt;
}
