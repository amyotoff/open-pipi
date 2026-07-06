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
    pack_tags: string[];
}

export interface SkillManifest {
    name: string;
    description: string;
    version: string;
    meta?: CapabilityMeta;
    tools: FunctionDeclaration[];
    handlers: Record<string, (args: any, context?: RuntimeExecutionContext) => Promise<string>>;
    crons?: CronJob[];
    migrations?: string[];
    init?: () => Promise<void>;
}
