export type ToolCapability =
    | 'workspace_read'
    | 'artifact_write'
    | 'web_browse'
    | 'external_http'
    | 'home_automation'
    | 'shell_none';

export type ToolRunMode = 'inline' | 'sidecar' | 'sandbox' | 'mcp';
export type AuditMode = 'off' | 'errors' | 'all';

export interface SandboxExecutionSpec {
    backend?: 'docker';
    enabled?: boolean;
    image?: string;
    network?: 'off' | 'egress_allowlist';
    egress_allowlist?: string[];
    timeout_ms?: number;
    memory_mb?: number;
    cpu_limit?: number;
    read_only_rootfs?: boolean;
    tmpfs_mb?: number;
}

export interface ToolExecutionSpec {
    tool_name: string;
    run_mode: ToolRunMode;
    capabilities: ToolCapability[];
    approval: 'none' | 'explicit';
    approval_action?: string;
    approval_reason?: string;
    /**
     * Argument names worth showing the owner when asking for approval.
     *
     * "Place a phone call" is not a decision anyone can make; "place a phone
     * call to +39..." is. Listed per tool because only the tool knows which of
     * its arguments change what the owner is agreeing to.
     */
    approval_detail_fields?: string[];
    /** Bind the approval class to a digest of these normalized arguments. */
    approval_action_fields?: string[];
    /** Consume a matching grant after one execution. */
    approval_single_use?: boolean;
    /** Store and resume the exact tool call after an affirmative reply. */
    approval_resume?: boolean;
    audit_default: AuditMode;
    sandbox?: SandboxExecutionSpec;
    mcp?: {
        server_id: string;
        tool_name?: string;
    };
}

const KNOWN_TOOL_CAPABILITIES: ToolCapability[] = [
    'workspace_read',
    'artifact_write',
    'web_browse',
    'external_http',
    'home_automation',
    'shell_none',
];

const TOOL_CAPABILITY_OVERRIDES: Record<string, ToolCapability[]> = {
    browse_web: ['web_browse', 'external_http'],
    web_search: ['external_http'],
    webrun_execute: ['web_browse', 'external_http'],
    workspace_status: ['workspace_read'],
    workspace_list: ['workspace_read'],
    workspace_read_text: ['workspace_read'],
    workspace_find_files: ['workspace_read'],
    workspace_find_text: ['workspace_read'],
    workspace_list_artifacts: ['workspace_read'],
    workspace_save_artifact: ['artifact_write'],
    workflow_list_recent_artifacts: ['workspace_read'],
    tutor_create_lesson_note: ['artifact_write'],
    office_create_followup: ['artifact_write'],
    reporter_create_brief: ['artifact_write'],
    reporter_create_draft: ['artifact_write'],
    html_artifact_create: ['artifact_write'],
    html_artifact_list: ['workspace_read'],
    home_assistant_status: ['home_automation'],
    home_assistant_list_entities: ['home_automation'],
    home_assistant_get_state: ['home_automation'],
    home_assistant_control: ['home_automation'],
};

export function normalizeAuditMode(value: unknown, fallback: AuditMode = 'errors'): AuditMode {
    if (value === 'off' || value === 'errors' || value === 'all') {
        return value;
    }
    return fallback;
}

export function normalizeToolCapabilities(value: unknown): ToolCapability[] {
    if (!Array.isArray(value)) return [];

    const capabilities = value.filter(
        (item): item is ToolCapability =>
            typeof item === 'string' && KNOWN_TOOL_CAPABILITIES.includes(item as ToolCapability)
    );

    return Array.from(new Set(capabilities));
}

export function defaultCapabilitiesForTool(toolName: string): ToolCapability[] {
    return TOOL_CAPABILITY_OVERRIDES[toolName] || ['shell_none'];
}

export function deriveToolExecutionSpec(
    toolName: string,
    args: any,
    base?: Partial<ToolExecutionSpec>
): ToolExecutionSpec {
    const operation = typeof args?.operation === 'string' ? args.operation.trim() : '';

    if (toolName === 'web') {
        const isSearch = operation === 'search';
        const isDeepResearch = operation === 'deep_research';
        const capabilities: ToolCapability[] = isSearch ? ['external_http'] : ['web_browse', 'external_http'];
        return {
            tool_name: toolName,
            run_mode: isSearch ? 'inline' : 'sidecar',
            approval: isSearch ? 'none' : 'explicit',
            approval_action: isSearch ? undefined : isDeepResearch ? 'deep_research' : 'browse_web',
            approval_reason: isSearch
                ? undefined
                : isDeepResearch
                  ? 'running a deep web research agent that visits multiple external sites'
                  : 'opening an external web page',
            audit_default: normalizeAuditMode(base?.audit_default, 'errors'),
            capabilities,
            sandbox: base?.sandbox,
            mcp: base?.mcp,
        };
    }

    if (toolName === 'file_search') {
        const capabilities: ToolCapability[] = operation === 'save_artifact' ? ['artifact_write'] : ['workspace_read'];
        return {
            tool_name: toolName,
            run_mode: 'inline',
            approval: 'none',
            approval_action: base?.approval_action,
            approval_reason: base?.approval_reason,
            approval_detail_fields: base?.approval_detail_fields,
            approval_action_fields: base?.approval_action_fields,
            approval_single_use: base?.approval_single_use,
            approval_resume: base?.approval_resume,
            audit_default: normalizeAuditMode(base?.audit_default, 'errors'),
            capabilities,
            sandbox: base?.sandbox,
            mcp: base?.mcp,
        };
    }

    if (toolName === 'api_tool' && operation === 'create_workflow_artifact') {
        return {
            tool_name: toolName,
            run_mode: 'inline',
            approval: 'none',
            approval_action: base?.approval_action,
            approval_reason: base?.approval_reason,
            approval_detail_fields: base?.approval_detail_fields,
            approval_action_fields: base?.approval_action_fields,
            approval_single_use: base?.approval_single_use,
            approval_resume: base?.approval_resume,
            audit_default: normalizeAuditMode(base?.audit_default, 'errors'),
            capabilities: ['artifact_write'],
            sandbox: base?.sandbox,
            mcp: base?.mcp,
        };
    }

    return {
        tool_name: toolName,
        run_mode: base?.run_mode || 'inline',
        approval: base?.approval || 'none',
        approval_action: base?.approval_action,
        approval_reason: base?.approval_reason,
        approval_detail_fields: base?.approval_detail_fields,
        approval_action_fields: base?.approval_action_fields,
        approval_single_use: base?.approval_single_use,
        approval_resume: base?.approval_resume,
        audit_default: normalizeAuditMode(base?.audit_default, 'errors'),
        capabilities:
            normalizeToolCapabilities(base?.capabilities).length > 0
                ? normalizeToolCapabilities(base?.capabilities)
                : defaultCapabilitiesForTool(toolName),
        sandbox: base?.sandbox,
        mcp: base?.mcp,
    };
}
