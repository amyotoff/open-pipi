import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { Schema, Type } from '@google/genai';
import {
    appendToolExecutionLogData,
    beginToolExecutionLog,
    deleteToolExecutionLog,
    finishToolExecutionLog,
    getTask,
    insertToolLog,
    logEvent,
} from '../db';
import { buildPackToolRuntimeSnapshot, getPackToolForContext } from './pack-tool-runtime';
import { PackToolDescriptor } from './pack-types';
import {
    getToolDeclarationForContext,
    getToolExecutionSpecForContext,
    isRegisteredSkillToolAllowedForContext,
    preflightToolArgsForContext,
} from '../skills/_registry';
import { resolveAllowedCapabilities, resolveSpacePolicyForContext } from './policy';
import { RuntimeExecutionContext } from './runtime-context';
import { AuditMode, normalizeAuditMode, ToolExecutionSpec } from './tool-execution';
import { runPackToolViaSandboxd } from './sandbox-client';
import { addSpanAttributes, addSpanEvent, recordToolCallTelemetry, withSpan } from '../observability';
import { normalizeArrayInput } from '../utils/tool-input';
import {
    requireResumableSingleUseToolApproval,
    requireSingleUseToolApproval,
    requireToolApproval,
} from '../utils/approvals';

type ToolHandler = (args: any, context?: RuntimeExecutionContext) => Promise<string>;
type HandlerMap = Record<string, ToolHandler>;
type MetaHandler = (
    callName: string,
    args: any,
    context?: RuntimeExecutionContext,
    handlers?: HandlerMap
) => Promise<string | null>;
type SandboxWorkspaceMount = {
    workspaceRoot: string;
    relativeWorkspacePath: string | null;
};

const DEFAULT_SANDBOX_WORKSPACE_CONTAINER_ROOT = process.env.SANDBOX_WORKSPACE_CONTAINER_ROOT || '/app/data';

function normalizeRelativePath(input: string, label: string): string {
    const normalized = input.replace(/\\/g, '/');
    if (!normalized || normalized === '.' || normalized.startsWith('/')) {
        throw new Error(`${label} must be a non-empty relative path.`);
    }

    const collapsed = path.posix.normalize(normalized);
    if (collapsed === '.' || collapsed.startsWith('../') || collapsed === '..') {
        throw new Error(`${label} must stay inside its project root.`);
    }

    return collapsed;
}

function resolveSandboxPackProjectRoot(tool: PackToolDescriptor): string {
    const configuredRoot = process.env.SANDBOX_PACK_PROJECT_ROOT;
    if (configuredRoot) {
        return path.resolve(configuredRoot);
    }

    const relativeToolPath = normalizeRelativePath(tool.script_relative_path, 'script_relative_path');
    const projectRoot = path.resolve(tool.script_path, ...Array(relativeToolPath.split('/').length).fill('..'));
    return projectRoot;
}

function resolveSandboxWorkspaceMount(workspacePath?: string | null): SandboxWorkspaceMount | null {
    if (!workspacePath) return null;

    const configuredHostRoot = process.env.SANDBOX_WORKSPACE_ROOT;
    const configuredContainerRoot =
        process.env.SANDBOX_WORKSPACE_CONTAINER_ROOT || DEFAULT_SANDBOX_WORKSPACE_CONTAINER_ROOT;

    if (configuredHostRoot && workspacePath.startsWith(configuredContainerRoot)) {
        const relativeWorkspacePath = path
            .relative(configuredContainerRoot, workspacePath)
            .split(path.sep)
            .join(path.posix.sep);
        const normalized = relativeWorkspacePath
            ? normalizeRelativePath(relativeWorkspacePath, 'relative_workspace_path')
            : null;
        return {
            workspaceRoot: path.resolve(configuredHostRoot),
            relativeWorkspacePath: normalized,
        };
    }

    const resolvedWorkspacePath = path.resolve(workspacePath);
    if (!fs.existsSync(resolvedWorkspacePath)) {
        throw new Error(`Workspace path "${workspacePath}" is not accessible for sandbox execution.`);
    }

    return {
        workspaceRoot: resolvedWorkspacePath,
        relativeWorkspacePath: null,
    };
}

function summarizeResult(result: string): string {
    return result.replace(/\s+/g, ' ').trim().substring(0, 280);
}

function hasSchemaType(schema: Schema | undefined, expected: Type): boolean {
    return typeof schema?.type === 'string' && schema.type.toUpperCase() === expected;
}

function normalizeSchemaValue(schema: Schema | undefined, value: unknown): unknown {
    if (!schema) return value;

    if (hasSchemaType(schema, Type.ARRAY)) {
        const rawItems = normalizeArrayInput(value);
        return rawItems.map((item) => normalizeSchemaValue(schema.items, item));
    }

    if (hasSchemaType(schema, Type.OBJECT)) {
        const raw =
            value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
        const normalized: Record<string, unknown> = { ...raw };

        for (const [key, childSchema] of Object.entries(schema.properties || {})) {
            if (raw[key] !== undefined || hasSchemaType(childSchema, Type.ARRAY)) {
                normalized[key] = normalizeSchemaValue(childSchema, raw[key]);
            }
        }

        return normalized;
    }

    return value;
}

function normalizeToolArgsFromSchema(parameters: Schema | undefined, toolArgs: unknown): Record<string, unknown> {
    const normalized = normalizeSchemaValue(parameters, toolArgs);
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
        return normalized as Record<string, unknown>;
    }
    return {};
}

function resolveTaskAuditOverride(context: RuntimeExecutionContext): AuditMode | null {
    if (!context.taskId) return null;

    const task = getTask(context.taskId);
    if (!task?.config_json) return null;

    try {
        const parsed = JSON.parse(task.config_json) as { audit_trail?: string };
        return parsed.audit_trail ? normalizeAuditMode(parsed.audit_trail) : null;
    } catch {
        return null;
    }
}

function resolveEffectiveAuditMode(spec: ToolExecutionSpec, context: RuntimeExecutionContext): AuditMode {
    const taskAudit = resolveTaskAuditOverride(context);
    if (taskAudit) return taskAudit;

    const spacePolicy = resolveSpacePolicyForContext(context);
    return normalizeAuditMode(spacePolicy.audit_trail, spec.audit_default);
}

/** Long values are truncated: an approval prompt has to stay readable in a chat message. */
const APPROVAL_DETAIL_MAX_CHARS = 120;

/**
 * What the owner is actually being asked to approve.
 *
 * The reason alone describes a *kind* of action — "opening an external page",
 * "placing a phone call" — which is not something anyone can meaningfully agree
 * to. Tools that declare `approval_detail_fields` get the arguments that change
 * the answer appended, so the decision is about this call rather than the
 * category.
 */
export function describeApprovalRequest(spec: ToolExecutionSpec, args: Record<string, unknown>): string {
    const reason = spec.approval_reason || `running the "${spec.tool_name}" tool`;
    const fields = spec.approval_detail_fields ?? [];

    const details = fields
        .map((field) => {
            const value = args?.[field];
            if (value == null || value === '') return null;

            const rendered = Array.isArray(value) ? value.join('; ') : String(value);
            const trimmed = rendered.trim();
            if (!trimmed) return null;

            return `${field}: ${
                trimmed.length > APPROVAL_DETAIL_MAX_CHARS ? `${trimmed.slice(0, APPROVAL_DETAIL_MAX_CHARS)}…` : trimmed
            }`;
        })
        .filter((entry): entry is string => entry !== null);

    return details.length > 0 ? `${reason} — ${details.join(', ')}` : reason;
}

function resolveApprovalActionClass(spec: ToolExecutionSpec, args: Record<string, unknown>): string | undefined {
    const base = spec.approval_action;
    const fields = spec.approval_action_fields || [];
    if (!base || fields.length === 0) return base;

    const boundArgs = Object.fromEntries(fields.map((field) => [field, args[field] ?? null]));
    const digest = crypto.createHash('sha256').update(JSON.stringify(boundArgs)).digest('hex').slice(0, 16);
    return `${base}_${digest}`;
}

function capabilityBlockMessage(toolName: string, required: string[], allowed: string[]): string {
    return `[TOOL_RESULT] Tool "${toolName}" is blocked by current execution policy. Required: ${required.join(', ')}. Allowed: ${allowed.join(', ')}.`;
}

function sandboxDisabledMessage(toolName: string): string {
    return `[TOOL_RESULT] Tool "${toolName}" requires sandbox execution, but sandbox tools are disabled in this space.`;
}

function beginAuditLog(
    spec: ToolExecutionSpec,
    context: RuntimeExecutionContext,
    auditMode: AuditMode,
    args: any
): number | undefined {
    if (auditMode === 'off') return undefined;

    const spacePolicy = resolveSpacePolicyForContext(context);
    return beginToolExecutionLog({
        space_id: context.spaceId || null,
        task_id: context.turnId || context.taskId || null,
        tool_name: spec.tool_name,
        run_mode: spec.run_mode,
        audit_mode: auditMode,
        capabilities: spec.capabilities,
        args: args || {},
        workspace_root: spacePolicy.workspace_path,
    });
}

function finalizeAuditLog(
    logId: number | undefined,
    auditMode: AuditMode,
    status: 'success' | 'error' | 'blocked',
    durationMs: number,
    result?: string,
    error?: string
): void {
    if (!logId) return;

    finishToolExecutionLog(logId, {
        status,
        duration_ms: durationMs,
        result_preview: result ? summarizeResult(result) : null,
        error: error || null,
    });

    if (auditMode === 'errors' && status === 'success') {
        deleteToolExecutionLog(logId);
    }
}

type ToolExecutionOutcome = {
    status: 'success' | 'error' | 'blocked';
    result?: string;
    error?: string;
    event?: Record<string, unknown>;
    audit?: Record<string, unknown>;
};

/**
 * Keep audit rows and analytics events in lockstep so new exit branches only
 * need one helper call instead of repeating the same bookkeeping.
 */
function recordToolOutcome(args: {
    logId: number | undefined;
    auditMode: AuditMode;
    startedMs: number;
    toolName: string;
    toolArgs: any;
    spec: ToolExecutionSpec;
    context: RuntimeExecutionContext;
    outcome: ToolExecutionOutcome;
}): void {
    const { logId, auditMode, startedMs, toolName, toolArgs, spec, context, outcome } = args;
    const durationMs = Date.now() - startedMs;
    const executionRef = context.turnId || context.taskId || null;

    addSpanAttributes({
        'app.tool.name': toolName,
        'app.tool.run_mode': spec.run_mode,
        'app.tool.audit_mode': auditMode,
        'app.tool.status': outcome.status,
        'app.tool.duration_ms': durationMs,
        'app.space_id': context.spaceId,
        'app.task_id': context.taskId,
        'app.turn_id': context.turnId,
    });
    if (outcome.error) {
        addSpanEvent('tool.error', {
            tool_name: toolName,
            error: outcome.error,
        });
    }
    recordToolCallTelemetry(durationMs, {
        tool_name: toolName,
        run_mode: spec.run_mode,
        audit_mode: auditMode,
        status: outcome.status,
    });

    if (logId && outcome.audit) {
        appendToolExecutionLogData(logId, outcome.audit);
    }

    finalizeAuditLog(logId, auditMode, outcome.status, durationMs, outcome.result, outcome.error);
    insertToolLog({
        space_id: context.spaceId || null,
        task_id: executionRef,
        tool_name: toolName,
        run_mode: spec.run_mode,
        audit_mode: auditMode,
        args: toolArgs,
        result_text: outcome.result || null,
        status: outcome.status,
        error: outcome.error || null,
        started_at: new Date(startedMs).toISOString(),
        finished_at: new Date(startedMs + durationMs).toISOString(),
        duration_ms: durationMs,
    });
    logEvent('tool_call', {
        tool: toolName,
        args: toolArgs,
        duration_ms: durationMs,
        ok: outcome.status === 'success',
        ...(outcome.error ? { error: outcome.error } : {}),
        run_mode: spec.run_mode,
        capabilities: spec.capabilities,
        audit_mode: auditMode,
        task_id: context.taskId || null,
        turn_id: context.turnId || null,
        ...(outcome.event || {}),
    });
}

export async function executeToolCall(args: {
    toolName: string;
    toolArgs: any;
    context: RuntimeExecutionContext;
    handlers: HandlerMap;
    metaHandler?: MetaHandler;
}): Promise<string> {
    const { toolName, toolArgs, context, handlers, metaHandler } = args;
    return await withSpan(
        'tool.execute',
        {
            attributes: {
                tool_name: toolName,
                space_id: context.spaceId,
                task_id: context.taskId,
                turn_id: context.turnId,
            },
        },
        async () => {
            const startedMs = Date.now();
            const registeredSkillAccess = isRegisteredSkillToolAllowedForContext(toolName, context);
            const runtimeToolAccess =
                (!context.allowedTools || context.allowedTools.includes(toolName)) &&
                !(context.disabledTools || []).includes(toolName);
            const toolAccessDenied = registeredSkillAccess === false || !runtimeToolAccess;
            const declaration = getToolDeclarationForContext(toolName, context);
            let normalizedToolArgs = normalizeToolArgsFromSchema(declaration?.parameters, toolArgs || {});
            let preflightError: unknown;
            if (!toolAccessDenied) {
                try {
                    normalizedToolArgs = preflightToolArgsForContext(toolName, normalizedToolArgs, context);
                } catch (error) {
                    preflightError = error;
                }
            }
            const spec = getToolExecutionSpecForContext(toolName, normalizedToolArgs, context);
            const auditMode = resolveEffectiveAuditMode(spec, context);
            const spacePolicy = resolveSpacePolicyForContext(context);
            const allowedCapabilities = resolveAllowedCapabilities(spacePolicy);
            const missingCapabilities = spec.capabilities.filter(
                (capability) => !allowedCapabilities.includes(capability)
            );

            addSpanAttributes({
                'app.tool.capabilities': spec.capabilities.join(','),
                'app.tool.run_mode': spec.run_mode,
                'app.tool.approval': spec.approval,
                'app.tool.audit_mode': auditMode,
            });

            const finish = (logId: number | undefined, outcome: ToolExecutionOutcome): string => {
                recordToolOutcome({
                    logId,
                    auditMode,
                    startedMs,
                    toolName,
                    toolArgs: normalizedToolArgs,
                    spec,
                    context,
                    outcome,
                });
                return outcome.result || '';
            };

            if (toolAccessDenied) {
                const result = `[TOOL_RESULT] Tool "${toolName}" is not allowed in the current execution context.`;
                const logId = beginAuditLog(spec, context, auditMode, normalizedToolArgs);
                return finish(logId, {
                    status: 'blocked',
                    result,
                    error: 'tool_not_allowed',
                });
            }

            if (preflightError) {
                const message = preflightError instanceof Error ? preflightError.message : 'Invalid tool arguments.';
                const result = `[TOOL_RESULT] Tool "${toolName}" rejected its arguments: ${message}`;
                const logId = beginAuditLog(spec, context, auditMode, normalizedToolArgs);
                return finish(logId, {
                    status: 'blocked',
                    result,
                    error: 'invalid_arguments',
                });
            }

            if (missingCapabilities.length > 0) {
                const result = capabilityBlockMessage(toolName, spec.capabilities, allowedCapabilities);
                const logId = beginAuditLog(spec, context, auditMode, normalizedToolArgs);
                return finish(logId, {
                    status: 'blocked',
                    result,
                    error: 'capability_blocked',
                });
            }

            if (spec.run_mode === 'sandbox' && !spacePolicy.sandbox_enabled) {
                const result = sandboxDisabledMessage(toolName);
                const logId = beginAuditLog(spec, context, auditMode, normalizedToolArgs);
                return finish(logId, {
                    status: 'blocked',
                    result,
                    error: 'sandbox_disabled',
                });
            }

            if (spec.approval === 'explicit') {
                const prompt = describeApprovalRequest(spec, normalizedToolArgs);
                const actionClass = resolveApprovalActionClass(spec, normalizedToolArgs);
                const result =
                    spec.approval_resume && actionClass
                        ? requireResumableSingleUseToolApproval(
                              toolName,
                              context,
                              prompt,
                              actionClass,
                              normalizedToolArgs
                          )
                        : spec.approval_single_use && actionClass
                          ? requireSingleUseToolApproval(toolName, context, prompt, actionClass)
                          : requireToolApproval(toolName, context, prompt, actionClass);
                if (result) {
                    const logId = beginAuditLog(spec, context, auditMode, normalizedToolArgs);
                    return finish(logId, {
                        status: 'blocked',
                        result,
                        error: 'approval_required',
                    });
                }
            }

            const logId = beginAuditLog(spec, context, auditMode, normalizedToolArgs);
            const runtimeContext = logId ? { ...context, toolExecutionId: logId } : context;

            try {
                if (spec.run_mode === 'sandbox') {
                    const packTool = getPackToolForContext(toolName, context);
                    if (!packTool) {
                        return finish(logId, {
                            status: 'error',
                            result: `[TOOL_RESULT] Sandbox execution is currently supported only for pack-local tools, and "${toolName}" was not found as a pack tool.`,
                            error: 'sandbox_tool_not_found',
                        });
                    }

                    const runtime = buildPackToolRuntimeSnapshot(runtimeContext);
                    if (!runtime) {
                        return finish(logId, {
                            status: 'error',
                            result: `[TOOL_RESULT] Sandbox tool "${toolName}" could not build a runtime snapshot for this space.`,
                            error: 'sandbox_runtime_unavailable',
                        });
                    }

                    const projectRoot = resolveSandboxPackProjectRoot(packTool);
                    const relativeToolPath = normalizeRelativePath(packTool.script_relative_path, 'relative_tool_path');
                    const workspaceMount = resolveSandboxWorkspaceMount(spacePolicy.workspace_path);

                    const sandboxResult = await runPackToolViaSandboxd({
                        tool_name: packTool.id,
                        project_root: projectRoot,
                        relative_tool_path: relativeToolPath,
                        tool_args: normalizedToolArgs,
                        runtime,
                        context: runtimeContext,
                        sandbox: packTool.execution?.sandbox,
                        workspace_root: workspaceMount?.workspaceRoot || null,
                        relative_workspace_path: workspaceMount?.relativeWorkspacePath || null,
                    });

                    return finish(logId, {
                        status: 'success',
                        result: sandboxResult.text,
                        audit: {
                            sandbox_backend: sandboxResult.metadata.backend,
                            sandbox_image: sandboxResult.metadata.image,
                            sandbox_container_id: sandboxResult.metadata.container_id,
                            files_written: sandboxResult.metadata.files_written,
                            artifacts: sandboxResult.metadata.files_written,
                        },
                        event: {
                            sandbox_backend: sandboxResult.metadata.backend,
                            sandbox_image: sandboxResult.metadata.image,
                        },
                    });
                }

                const metaResult = metaHandler
                    ? await metaHandler(toolName, normalizedToolArgs, runtimeContext, handlers)
                    : null;
                let result: string;

                if (metaResult !== null) {
                    result = metaResult;
                } else {
                    const handler = handlers[toolName];
                    if (!handler) {
                        result = `No handler found for tool "${toolName}"`;
                        console.warn(`[LLM] No handler for tool "${toolName}"`);
                        return finish(logId, {
                            status: 'error',
                            result,
                            error: 'no_handler',
                        });
                    }

                    result = await handler(normalizedToolArgs, runtimeContext);
                }

                return finish(logId, { status: 'success', result });
            } catch (error: any) {
                recordToolOutcome({
                    logId,
                    auditMode,
                    startedMs,
                    toolName,
                    toolArgs: normalizedToolArgs,
                    spec,
                    context,
                    outcome: {
                        status: 'error',
                        error: error?.message || String(error),
                    },
                });
                throw error;
            }
        }
    );
}
