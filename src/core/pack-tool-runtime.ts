import { getDb, getSpace, getSpaceParticipants, listTasks, Space, Task } from '../db';
import { ensureActiveMemorySprint } from './memory-sprint';
import { resolveSpacePolicy } from './policy';
import {
    resolveChannelFromExecutionContext,
    resolveChannelRefFromExecutionContext,
    resolveSpaceIdFromExecutionContext,
    RuntimeExecutionContext,
} from './runtime-context';
import { materializeAgentForSpace } from './agent-kernel';
import { PackToolDescriptor, PackToolRuntimeSnapshot } from './pack-types';
import { getValidGoogleAccessToken } from './google-oauth';

function countPendingTodos(spaceId: string, database = getDb()): number {
    try {
        return (
            database
                .prepare(
                    `
            SELECT COUNT(*) as cnt
            FROM todos
            WHERE space_id = ? AND status = 'pending'
        `
                )
                .get(spaceId) as { cnt: number }
        ).cnt;
    } catch {
        return 0;
    }
}

function countPendingReminders(channelRef: string, database = getDb()): number {
    return (
        database
            .prepare(
                `
        SELECT COUNT(*) as cnt FROM reminders
        WHERE chat_jid = ? AND status = 'pending'
    `
            )
            .get(channelRef) as { cnt: number }
    ).cnt;
}

type ResolvedPackToolSpaceContext = {
    spaceId: string;
    space: Space;
    channel: string;
    channelRef: string;
};

function resolvePackToolSpaceId(context?: Partial<RuntimeExecutionContext>): string | null {
    return resolveSpaceIdFromExecutionContext(context) || null;
}

function resolveExistingPackToolSpaceContext(
    context?: Partial<RuntimeExecutionContext>
): ResolvedPackToolSpaceContext | null {
    const spaceId = resolvePackToolSpaceId(context);
    if (!spaceId) return null;

    const space = getSpace(spaceId);
    if (!space) return null;

    return {
        spaceId,
        space,
        channel: resolveChannelFromExecutionContext(context) || space.channel,
        channelRef: resolveChannelRefFromExecutionContext(context) || space.external_ref,
    };
}

function buildParticipantNames(spaceId: string): string[] {
    return getSpaceParticipants(spaceId).map(
        (participant) => participant.nickname || participant.display_name || participant.username || participant.tg_id
    );
}

function buildActiveTaskSummaries(spaceId: string): PackToolRuntimeSnapshot['active_tasks'] {
    return listTasks(spaceId, 'active').map((task: Task) => ({
        id: task.id,
        title: task.title,
        schedule_value: task.schedule_value,
        created_by: task.created_by || null,
    }));
}

function buildPendingCounts(
    spaceId: string,
    channelRef: string,
    database = getDb()
): PackToolRuntimeSnapshot['pending_counts'] {
    return {
        todos: countPendingTodos(spaceId, database),
        reminders: countPendingReminders(channelRef, database),
    };
}

function normalizePackToolResult(toolId: string, result: unknown): string {
    const text = typeof result === 'string' ? result.trim() : '';
    return text || `Pack tool "${toolId}" completed without a textual result.`;
}

export function buildPackToolRuntimeSnapshot(context: RuntimeExecutionContext): PackToolRuntimeSnapshot | null {
    const resolved = resolveExistingPackToolSpaceContext(context);
    if (!resolved) return null;

    const { spaceId, space, channel, channelRef } = resolved;
    const policy = resolveSpacePolicy(spaceId);
    const sprint = ensureActiveMemorySprint(spaceId);
    const participantNames = buildParticipantNames(spaceId);
    const activeTasks = buildActiveTaskSummaries(spaceId);

    /**
     * Pack tools get a compact, stable snapshot instead of raw DB objects so
     * tool scripts can stay deterministic and easy to reason about.
     */
    return {
        now: new Date().toISOString(),
        space_id: spaceId,
        assistant_pack_id: space.assistant_pack_id,
        channel,
        channel_ref: channelRef,
        workspace_path: typeof policy.workspace_path === 'string' ? policy.workspace_path : null,
        participant_count: participantNames.length,
        participant_names: participantNames,
        active_task_count: activeTasks.length,
        active_tasks: activeTasks,
        pending_counts: buildPendingCounts(spaceId, channelRef),
        memory_sprint: {
            opened_at: sprint.opened_at,
            closes_at: sprint.closes_at,
            cadence_days: sprint.cadence_days,
        },
        policy: { ...policy },
    };
}

export function getPackToolsForContext(context?: RuntimeExecutionContext): PackToolDescriptor[] {
    const spaceId = resolvePackToolSpaceId(context);
    if (!spaceId) return [];

    return materializeAgentForSpace(spaceId).pack_tools;
}

export function getPackToolForContext(
    toolId: string,
    context?: RuntimeExecutionContext
): PackToolDescriptor | undefined {
    return getPackToolsForContext(context).find((tool) => tool.id === toolId);
}

export async function executePackTool(toolId: string, args: any, context: RuntimeExecutionContext): Promise<string> {
    const spaceId = resolvePackToolSpaceId(context);
    if (!spaceId) {
        return `Pack tool "${toolId}" requires an active space context.`;
    }

    const tool = getPackToolsForContext(context).find((item) => item.id === toolId);
    if (!tool) {
        return `Pack tool "${toolId}" is not available in this space.`;
    }

    const runtime = buildPackToolRuntimeSnapshot({ ...context, spaceId });
    if (!runtime) {
        return `Pack tool "${toolId}" could not build a runtime snapshot for this space.`;
    }

    const googleToken = await getValidGoogleAccessToken(spaceId);
    if (googleToken) {
        runtime.google_access_token = googleToken;
    }

    return normalizePackToolResult(toolId, await tool.run(args || {}, runtime, context));
}
