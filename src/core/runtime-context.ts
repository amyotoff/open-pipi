import { buildSpaceId, buildTelegramSpaceId, getSpace, getSpaceByChannelRef, Space } from '../db';

export interface RuntimeExecutionContext {
    chatId?: string;
    userId: string;
    spaceId?: string;
    channel?: string;
    channelRef?: string;
    taskId?: string;
    toolExecutionId?: number;
    /** Tools hidden from a nested model run, for example to prevent recursive delegation. */
    disabledTools?: string[];
}

type PartialRuntimeExecutionContext = Partial<RuntimeExecutionContext>;

function resolveSpaceIdFromChannelContext(
    context: Required<Pick<RuntimeExecutionContext, 'channel' | 'channelRef'>>
): string {
    const existing = getSpaceByChannelRef(context.channel, context.channelRef);
    return existing?.id || buildSpaceId(context.channel, context.channelRef);
}

export function resolveSpaceIdFromExecutionContext(context?: PartialRuntimeExecutionContext): string | undefined {
    if (!context) return undefined;
    if (context.spaceId) return context.spaceId;

    if (context.channel && context.channelRef) {
        return resolveSpaceIdFromChannelContext({
            channel: context.channel,
            channelRef: context.channelRef,
        });
    }

    return context.chatId ? buildTelegramSpaceId(context.chatId) : undefined;
}

export function resolveRuntimeSpace(context?: PartialRuntimeExecutionContext): Space | undefined {
    const spaceId = resolveSpaceIdFromExecutionContext(context);
    return spaceId ? getSpace(spaceId) : undefined;
}

export function resolveChannelRefFromExecutionContext(context?: PartialRuntimeExecutionContext): string | undefined {
    if (!context) return undefined;
    if (context.channelRef) return context.channelRef;
    if (context.chatId) return context.chatId;

    const space = resolveRuntimeSpace(context);
    return space?.external_ref;
}

export function resolveChannelFromExecutionContext(context?: PartialRuntimeExecutionContext): string | undefined {
    if (!context) return undefined;
    if (context.channel) return context.channel;
    if (context.chatId) return 'telegram';

    const space = resolveRuntimeSpace(context);
    return space?.channel;
}
