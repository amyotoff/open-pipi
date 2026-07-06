import { getSpace } from '../db';
import { getAssistantPack } from './assistant-pack';
import { materializeAgentForSpace } from './agent-kernel';
import { RuntimeExecutionContext, resolveSpaceIdFromExecutionContext } from './runtime-context';
import { AuditMode, ToolCapability, normalizeAuditMode, normalizeToolCapabilities } from './tool-execution';

export interface SpacePolicy {
    browser: boolean;
    tasks: boolean;
    workspace_path: string | null;
    memory_sprint_days: number;
    sandbox_enabled: boolean;
    audit_trail: AuditMode;
    allowed_capabilities: ToolCapability[] | null;
    onboarding_complete?: boolean;
    [key: string]: unknown;
}

const DEFAULT_SPACE_POLICY: SpacePolicy = {
    browser: false,
    tasks: true,
    workspace_path: null,
    memory_sprint_days: 7,
    sandbox_enabled: false,
    audit_trail: 'errors',
    allowed_capabilities: null,
};

const DEFAULT_ASSISTANT_PACK_ID = 'jeeves';
const IMPLICIT_CAPABILITY_RULES: Array<{ enabled: (policy: SpacePolicy) => boolean; capabilities: ToolCapability[] }> =
    [
        {
            enabled: (policy) => Boolean(policy.workspace_path),
            capabilities: ['workspace_read'],
        },
        {
            enabled: (policy) => policy.browser,
            capabilities: ['external_http', 'web_browse'],
        },
    ];

function parsePolicyJson(raw: string | null | undefined): Partial<SpacePolicy> {
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw) as Partial<SpacePolicy>;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function cloneDefaultSpacePolicy(): SpacePolicy {
    return { ...DEFAULT_SPACE_POLICY };
}

function resolvePackPolicyDefaults(packId: string | null | undefined): Partial<SpacePolicy> {
    return getAssistantPack(packId || DEFAULT_ASSISTANT_PACK_ID).default_policies as Partial<SpacePolicy>;
}

function resolveSpacePackPolicyDefaults(spaceId: string, packId: string | null | undefined): Partial<SpacePolicy> {
    try {
        return materializeAgentForSpace(spaceId).default_policies as Partial<SpacePolicy>;
    } catch {
        return resolvePackPolicyDefaults(packId);
    }
}

function normalizeResolvedCapabilities(value: unknown): ToolCapability[] | null {
    const capabilities = normalizeToolCapabilities(value);
    return capabilities.length > 0 ? capabilities : null;
}

function normalizeResolvedPolicy(policy: SpacePolicy): SpacePolicy {
    return {
        ...policy,
        audit_trail: normalizeAuditMode(policy.audit_trail, DEFAULT_SPACE_POLICY.audit_trail),
        allowed_capabilities: normalizeResolvedCapabilities(policy.allowed_capabilities),
    };
}

// Keep policy resolution intentionally layered: global baseline -> pack defaults -> per-space overrides.
function mergeSpacePolicy(...layers: Array<Partial<SpacePolicy>>): SpacePolicy {
    return normalizeResolvedPolicy(Object.assign(cloneDefaultSpacePolicy(), ...layers));
}

export function resolveSpacePolicy(spaceId: string): SpacePolicy {
    const space = getSpace(spaceId);
    return mergeSpacePolicy(
        resolveSpacePackPolicyDefaults(spaceId, space?.assistant_pack_id),
        parsePolicyJson(space?.policy_json)
    );
}

export function resolveSpacePolicyForContext(context: Partial<RuntimeExecutionContext>): SpacePolicy {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    return spaceId ? resolveSpacePolicy(spaceId) : cloneDefaultSpacePolicy();
}

export function resolveTelegramChatPolicy(chatId: string): SpacePolicy {
    return resolveSpacePolicyForContext({ chatId, channel: 'telegram', channelRef: chatId });
}

export function resolveAllowedCapabilities(policy: SpacePolicy): ToolCapability[] {
    if (policy.allowed_capabilities && policy.allowed_capabilities.length > 0) {
        return policy.allowed_capabilities;
    }

    const capabilities = new Set<ToolCapability>(['shell_none', 'artifact_write']);

    for (const rule of IMPLICIT_CAPABILITY_RULES) {
        if (!rule.enabled(policy)) {
            continue;
        }

        for (const capability of rule.capabilities) {
            capabilities.add(capability);
        }
    }

    return Array.from(capabilities);
}
