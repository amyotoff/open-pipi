import { FunctionDeclaration } from '@google/genai';
import { TrustFlag } from './authority';
import { RuntimeExecutionContext } from './runtime-context';
import { MaterializedCoreToolbox } from './coretoolbox';
import { ToolExecutionSpec } from './tool-execution';

export interface SeededTaskTemplate {
    template_id: string;
    title: string;
    kind: 'assistant_prompt' | 'atelier_summary';
    schedule_value: string;
    prompt: string;
    ritual_key?: 'morning' | 'evening' | 'weekly';
    ritual_frequency?: 'daily' | 'weekly';
    ritual_description?: string;
    audience_prefix?: string;
    date_mode?: 'full' | 'short' | 'none';
    history_hours?: number;
    include_important_dates?: boolean;
    /** When true, buildTaskPrompt injects live operational signals (pending todos, overdue tasks, chat silence). */
    initiative_signals?: boolean;
}

export interface AssistantPack {
    id: string;
    persona_id: string;
    system_prompt_path?: string | null;
    enabled_capabilities: string[];
    memory_rules: string[];
    seeded_tasks: SeededTaskTemplate[];
    default_policies: Record<string, unknown>;
    authority_presets: Record<string, { base_authority: number; trust_flags: TrustFlag[] }>;
    onboarding_hints?: string[];
}

export interface PackToolDescriptor {
    id: string;
    title: string;
    description: string;
    script_path: string;
    script_relative_path: string;
    declaration: FunctionDeclaration;
    execution?: Partial<ToolExecutionSpec>;
    run: (args: any, runtime: PackToolRuntimeSnapshot, context?: RuntimeExecutionContext) => Promise<string> | string;
}

export interface MaterializedAgent extends AssistantPack {
    system_prompt: string;
    skills_doc: string;
    tools_doc: string;
    core_toolbox: MaterializedCoreToolbox;
    pack_tools: PackToolDescriptor[];
    source: 'installable' | 'static';
    pack_root: string | null;
}

export interface InstallableAgentMeta {
    id: string;
    persona_id: string;
    memory_rules: string[];
    default_policies: Record<string, unknown>;
    authority_presets: Record<string, { base_authority: number; trust_flags: TrustFlag[] }>;
    seeded_tasks: SeededTaskTemplate[];
    onboarding_hints?: string[];
}

export interface InstallableSkillsMeta {
    enabled_capabilities: string[];
    skill_hints?: Record<string, string>;
}

export interface PackToolModuleExport {
    id: string;
    title: string;
    description: string;
    parameters?: FunctionDeclaration['parameters'];
    execution?: Partial<ToolExecutionSpec>;
    run: (args: any, runtime: PackToolRuntimeSnapshot, context?: RuntimeExecutionContext) => Promise<string> | string;
}

export interface PackToolRuntimeSnapshot {
    now: string;
    space_id: string;
    assistant_pack_id: string;
    channel: string;
    channel_ref: string;
    workspace_path: string | null;
    participant_count: number;
    participant_names: string[];
    active_task_count: number;
    active_tasks: Array<{
        id: string;
        title: string;
        schedule_value: string;
        created_by: string | null;
    }>;
    pending_counts: {
        todos: number;
        reminders: number;
    };
    memory_sprint: {
        opened_at: string;
        closes_at: string;
        cadence_days: number;
    };
    policy: Record<string, unknown>;
    google_access_token?: string;
}
