import { FunctionDeclaration } from '@google/genai';
import { TrustFlag } from '../core/authority';
import { RuntimeExecutionContext } from '../core/runtime-context';

export interface CronJob {
    expression: string;
    handler: () => Promise<void>;
    description: string;
}

export interface CapabilityMeta {
    run_mode: 'inline' | 'sidecar' | 'sandbox';
    approval: 'none' | 'explicit';
    cost: 'low' | 'medium' | 'high';
    visibility: 'all' | 'owner' | 'policy';
    policy_gate?: 'browser' | 'tasks';
    required_trust_flag?: TrustFlag;
    requires_workspace?: boolean;
    /** Only expose this capability inside a nested run with an exact tool allowlist. */
    delegated_only?: boolean;
    /** Restrict host-global integrations to a resident with the global owner role. */
    host_owner_only?: boolean;
    pack_tags: string[];
}

export interface SkillToolMeta {
    run_mode?: CapabilityMeta['run_mode'];
    approval?: CapabilityMeta['approval'];
    approval_action?: string;
    approval_reason?: string;
    /** Argument names to show the owner in the approval prompt. */
    approval_detail_fields?: string[];
    /** Argument names that bind an approval to one exact call. */
    approval_action_fields?: string[];
    /** Consume the matching approval grant after one call. */
    approval_single_use?: boolean;
    /** Resume the exact stored call when approval arrives in a later message. */
    approval_resume?: boolean;
}

export interface SkillManifest {
    name: string;
    description: string;
    version: string;
    meta?: CapabilityMeta;
    toolMeta?: Record<string, SkillToolMeta>;
    tools: FunctionDeclaration[];
    handlers: Record<string, (args: any, context?: RuntimeExecutionContext) => Promise<string>>;
    /** Pure argument validation/canonicalization performed before central approval. */
    preflight?: Record<string, (args: any) => Record<string, unknown>>;
    crons?: CronJob[];
    migrations?: string[];
    init?: () => Promise<void>;
}
