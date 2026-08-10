import {
    buildTelegramSpaceId,
    ensureSpaceMembership,
    ensureTelegramSpace,
    getDb,
    getSpace,
    listSpaces,
    logEvent,
    Space,
    updateSpacePolicy,
} from '../db';
import {
    parseSpacePolicyRecord,
    resolveSpaceOperationalSettings,
    type SpaceChannelMode,
} from '../core/space-preferences';
import { getRegisteredHandlers } from '../skills/_registry';
import {
    approvePendingAction,
    denyPendingAction,
    listPendingApprovalDetails,
    listPendingApprovalActions,
    type ApprovalActionClass,
    type ApprovedToolContinuation,
} from '../utils/approvals';
import { getChannel } from './_registry';
import { getAssistantPack, getAssistantPackIds, materializeAgentForPack } from '../core/assistant-pack';
import { createRuntimeBackup, getLatestRuntimeBackup, listRuntimeBackups } from '../core/runtime-backup';
import { executeApprovedToolContinuations, formatApprovedToolContinuationReply } from '../core/approval-continuation';

type TelegramOperatorContext = {
    chatId: string;
    chatType?: string;
    userId: string;
    text: string;
};

const CHANNEL_MODES: SpaceChannelMode[] = ['off', 'notify_only', 'inbox', 'full'];
const EXTERNAL_GROUP_MODES = ['mention_only', 'auto', 'watch'] as const;
type ExternalGroupMode = (typeof EXTERNAL_GROUP_MODES)[number];

export function stripToolResultPrefix(value: string): string {
    return value.replace(/^\[TOOL_RESULT\]\s*/, '');
}

function ensureTelegramOperatorSpace(context: TelegramOperatorContext): string {
    ensureTelegramSpace(context.chatId, context.chatType || 'private', context.chatId);
    const spaceId = buildTelegramSpaceId(context.chatId);
    ensureSpaceMembership(spaceId, context.userId, 'owner');
    return spaceId;
}

function parseSubcommand(text: string, command: string): string[] {
    return text
        .replace(new RegExp(`^/${command}(?:@\\w+)?\\s*`, 'i'), '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function channelModeDescription(mode: SpaceChannelMode): string {
    if (mode === 'full') return 'Conversational routing and notifications are enabled.';
    if (mode === 'inbox') return 'Incoming messages are stored, but the assistant does not auto-reply.';
    if (mode === 'notify_only') return 'Only command replies and system notifications are sent.';
    return 'All background sends via sendSpaceMessage are suppressed; only direct command replies (ctx.reply) go through.';
}

function externalGroupModeDescription(mode: ExternalGroupMode): string {
    if (mode === 'watch') {
        return 'Incoming messages are stored for cross-chat context, but the assistant does not auto-reply in this external group.';
    }
    if (mode === 'auto') {
        return 'The assistant may answer explicit work/request triggers in this external group.';
    }
    return 'The assistant answers only direct @mentions and replies to its messages in this external group.';
}

function parseExternalGroupMode(value: string | undefined): ExternalGroupMode | null {
    if (!value) return 'mention_only';
    return EXTERNAL_GROUP_MODES.includes(value as ExternalGroupMode) ? (value as ExternalGroupMode) : null;
}

function parsePolicyAliases(policy: Record<string, unknown>): string[] {
    const raw = policy.external_group_aliases;
    return Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [];
}

function normalizeAliases(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 12);
}

function getSpaceMessageStats(spaceId: string): { message_count: number; last_message_at: string | null } {
    const row = getDb()
        .prepare(
            `
        SELECT COUNT(*) as message_count, MAX(timestamp) as last_message_at
        FROM messages
        WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ?
    `
        )
        .get(spaceId) as { message_count: number; last_message_at: string | null } | undefined;

    return {
        message_count: row?.message_count || 0,
        last_message_at: row?.last_message_at || null,
    };
}

function formatLastMessageAt(value: string | null): string {
    return value ? value.substring(0, 16).replace('T', ' ') : 'never';
}

function summarizeExternalSpace(space: Space): string {
    const policy = parseSpacePolicyRecord(space.policy_json);
    const aliases = parsePolicyAliases(policy);
    const mode =
        resolveSpaceOperationalSettings(space.policy_json).channel_mode === 'inbox'
            ? 'watch'
            : parseExternalGroupMode(
                  typeof policy.external_group_mode === 'string' ? policy.external_group_mode : ''
              ) || 'mention_only';
    const stats = getSpaceMessageStats(space.id);
    const title = space.title || space.external_ref || space.id;
    const aliasText = aliases.length > 0 ? ` aliases=${aliases.join(', ')}` : '';
    return `- ${title} (${space.id}) mode=${mode} messages=${stats.message_count} last=${formatLastMessageAt(stats.last_message_at)}${aliasText}`;
}

function listExternalTelegramSpaces(): Space[] {
    return listSpaces('ACTIVE')
        .filter(
            (space) =>
                space.channel === 'telegram' &&
                parseSpacePolicyRecord(space.policy_json).external_group_enabled === true
        )
        .sort((a, b) => {
            const aStats = getSpaceMessageStats(a.id);
            const bStats = getSpaceMessageStats(b.id);
            return (bStats.last_message_at || '').localeCompare(aStats.last_message_at || '');
        });
}

function attachExternalGroup(spaceId: string, mode: ExternalGroupMode): string {
    const watchOnly = mode === 'watch';
    updateSpacePolicy(spaceId, {
        channel_mode: watchOnly ? 'inbox' : 'full',
        external_group_enabled: true,
        external_group_mode: watchOnly ? 'mention_only' : mode,
        external_group_watch_only: watchOnly,
        external_group_attached_at: new Date().toISOString(),
    });
    return `[TOOL_RESULT] External group attached for ${spaceId}.
Mode: ${mode}
Channel mode: ${watchOnly ? 'inbox' : 'full'}
Behavior: ${externalGroupModeDescription(mode)}`;
}

export async function runSetupTelegramCommand(context: TelegramOperatorContext): Promise<string> {
    const spaceId = ensureTelegramOperatorSpace(context);
    const handlers = getRegisteredHandlers();
    const parts = parseSubcommand(context.text, 'setup');
    const subcommand = parts[0]?.toLowerCase();

    if (subcommand === 'apply') {
        if (!handlers.pipi_apply_defaults) {
            return '[TOOL_RESULT] Setup management is not available.';
        }
        await handlers.pipi_apply_defaults({}, { chatId: context.chatId, userId: context.userId, spaceId });
        updateSpacePolicy(spaceId, { onboarding_state: 'active', setup_version: 1 });
        return "Recommended settings applied. You're ready — just tell me what you need.";
    }

    if (subcommand === 'smoke') {
        const result = handlers.pipi_smoke
            ? await handlers.pipi_smoke({}, { chatId: context.chatId, userId: context.userId, spaceId })
            : '[TOOL_RESULT] Setup management is not available.';
        return stripToolResultPrefix(result);
    }

    if (subcommand === 'reset') {
        updateSpacePolicy(spaceId, { onboarding_state: 'new', setup_version: 1 });
        return 'Setup state reset to new.\nNext step: /setup apply';
    }

    if (subcommand && subcommand !== 'status') {
        return `[TOOL_RESULT] Usage:
/setup
/setup status
/setup apply
/setup smoke
/setup reset`;
    }

    const settings = resolveSpaceOperationalSettings(getSpace(spaceId)?.policy_json);
    if (!subcommand) {
        return settings.onboarding_state === 'new'
            ? 'Set up this chat\n\nChoose “Use recommended settings” for a quick start. You can change individual settings later.'
            : 'Assistant settings\n\nThe assistant is active in this chat. You can refresh the recommended settings or inspect technical status.';
    }

    const result = handlers.pipi_status
        ? await handlers.pipi_status({}, { chatId: context.chatId, userId: context.userId, spaceId })
        : '[TOOL_RESULT] Setup management is not available.';
    return `Technical setup status\nState: ${settings.onboarding_state}\n\n${stripToolResultPrefix(result)}`;
}

export async function runChannelTelegramCommand(context: TelegramOperatorContext): Promise<string> {
    const spaceId = ensureTelegramOperatorSpace(context);
    const parts = parseSubcommand(context.text, 'channel');
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === 'status') {
        const space = getSpace(spaceId);
        const settings = resolveSpaceOperationalSettings(space?.policy_json);
        const policy = parseSpacePolicyRecord(space?.policy_json);
        const externalGroupEnabled = policy.external_group_enabled === true;
        const externalGroupMode =
            parseExternalGroupMode(
                typeof policy.external_group_mode === 'string' ? policy.external_group_mode : undefined
            ) || 'mention_only';
        const effectiveExternalMode =
            settings.channel_mode === 'inbox' && externalGroupEnabled ? 'watch' : externalGroupMode;
        const aliases = parsePolicyAliases(policy);
        const stats = getSpaceMessageStats(spaceId);
        const connectionStatus =
            !space || space.channel === 'telegram'
                ? 'connected'
                : getChannel(space.channel as any)?.isConnected()
                  ? 'connected'
                  : 'not connected';
        return `[TOOL_RESULT] Channel status
Space: ${spaceId}
Transport: ${space?.channel || 'telegram'}
Ref: ${space?.external_ref || context.chatId}
Mode: ${settings.channel_mode}
External group: ${externalGroupEnabled ? 'attached' : 'not attached'}
External group mode: ${effectiveExternalMode}
Aliases: ${aliases.length > 0 ? aliases.join(', ') : 'none'}
Messages: ${stats.message_count}
Last message: ${formatLastMessageAt(stats.last_message_at)}
Adapter: ${connectionStatus}
Behavior: ${channelModeDescription(settings.channel_mode)}`;
    }

    if (subcommand === 'list') {
        const spaces = listExternalTelegramSpaces();
        if (spaces.length === 0) {
            return '[TOOL_RESULT] No external Telegram groups are attached yet. Use /channel attach inside a partner/client group.';
        }

        return `[TOOL_RESULT] External Telegram groups\n${spaces.map(summarizeExternalSpace).join('\n')}`;
    }

    if (subcommand === 'mode') {
        const nextMode = parts[1] as SpaceChannelMode | undefined;
        if (!nextMode || !CHANNEL_MODES.includes(nextMode)) {
            return '[TOOL_RESULT] Usage: /channel mode <off|notify_only|inbox|full>';
        }

        updateSpacePolicy(spaceId, { channel_mode: nextMode });
        return `[TOOL_RESULT] Channel mode for ${spaceId} is now "${nextMode}". ${channelModeDescription(nextMode)}`;
    }

    if (subcommand === 'attach') {
        if (context.chatType !== 'group' && context.chatType !== 'supergroup') {
            return '[TOOL_RESULT] /channel attach can only be used inside a Telegram group or supergroup.';
        }

        const nextExternalMode = parseExternalGroupMode(parts[1]);
        if (!nextExternalMode) {
            return '[TOOL_RESULT] Usage: /channel attach [mention_only|auto|watch]';
        }

        return attachExternalGroup(spaceId, nextExternalMode);
    }

    if (subcommand === 'detach') {
        updateSpacePolicy(spaceId, {
            channel_mode: 'inbox',
            external_group_enabled: false,
            external_group_detached_at: new Date().toISOString(),
        });
        return `[TOOL_RESULT] External group detached for ${spaceId}. Incoming messages will no longer be routed as a partner/client chat. Channel mode is now "inbox".`;
    }

    if (subcommand === 'external') {
        const nextExternalMode = parseExternalGroupMode(parts[1]);
        if (!nextExternalMode) {
            return '[TOOL_RESULT] Usage: /channel external <mention_only|auto|watch>';
        }

        if (nextExternalMode === 'watch') {
            updateSpacePolicy(spaceId, {
                channel_mode: 'inbox',
                external_group_enabled: true,
                external_group_mode: 'mention_only',
                external_group_watch_only: true,
            });
            return `[TOOL_RESULT] External group mode for ${spaceId} is now "watch". ${externalGroupModeDescription('watch')}`;
        }

        updateSpacePolicy(spaceId, {
            channel_mode: 'full',
            external_group_mode: nextExternalMode,
            external_group_watch_only: false,
        });
        return `[TOOL_RESULT] External group mode for ${spaceId} is now "${nextExternalMode}". ${externalGroupModeDescription(nextExternalMode)}`;
    }

    if (subcommand === 'watch') {
        updateSpacePolicy(spaceId, {
            channel_mode: 'inbox',
            external_group_enabled: true,
            external_group_mode: 'mention_only',
            external_group_watch_only: true,
        });
        return `[TOOL_RESULT] External group mode for ${spaceId} is now "watch". ${externalGroupModeDescription('watch')}`;
    }

    if (subcommand === 'auto' || subcommand === 'mention_only') {
        const nextExternalMode = subcommand as ExternalGroupMode;
        updateSpacePolicy(spaceId, {
            channel_mode: 'full',
            external_group_enabled: true,
            external_group_mode: nextExternalMode,
            external_group_watch_only: false,
        });
        return `[TOOL_RESULT] External group mode for ${spaceId} is now "${nextExternalMode}". ${externalGroupModeDescription(nextExternalMode)}`;
    }

    if (subcommand === 'alias') {
        const policy = parseSpacePolicyRecord(getSpace(spaceId)?.policy_json);
        const action = parts[1]?.toLowerCase();
        if (!action) {
            const aliases = parsePolicyAliases(policy);
            return `[TOOL_RESULT] External group aliases for ${spaceId}: ${aliases.length > 0 ? aliases.join(', ') : 'none'}.
Usage: /channel alias add <alias>, /channel alias remove <alias>, /channel alias clear`;
        }

        if (action === 'clear') {
            updateSpacePolicy(spaceId, { external_group_aliases: [] });
            return `[TOOL_RESULT] External group aliases cleared for ${spaceId}.`;
        }

        const alias = parts.slice(2).join(' ').trim();
        if (!alias || !['add', 'remove'].includes(action)) {
            return '[TOOL_RESULT] Usage: /channel alias add <alias>, /channel alias remove <alias>, /channel alias clear';
        }

        const current = parsePolicyAliases(policy);
        const nextAliases =
            action === 'add'
                ? normalizeAliases([...current, alias])
                : current.filter((value) => value.toLowerCase() !== alias.toLowerCase());
        updateSpacePolicy(spaceId, { external_group_aliases: nextAliases });
        return `[TOOL_RESULT] External group aliases for ${spaceId}: ${nextAliases.length > 0 ? nextAliases.join(', ') : 'none'}.`;
    }

    return `[TOOL_RESULT] Usage:
/channel
/channel status
/channel list
/channel mode <off|notify_only|inbox|full>
/channel attach [mention_only|auto|watch]
/channel external <mention_only|auto|watch>
/channel watch
/channel auto
/channel mention_only
/channel alias add <alias>
/channel alias remove <alias>
/channel alias clear
/channel detach`;
}

function resolveRequestedApprovalAction(
    value: string | undefined,
    pending: ApprovalActionClass[]
): ApprovalActionClass | undefined | null {
    if (!value) return undefined;
    return pending.includes(value) ? value : null;
}

function resolveApprovalTelegramCommand(
    command: 'approve' | 'deny',
    context: TelegramOperatorContext
): { text: string; continuations: ApprovedToolContinuation[] } {
    const spaceId = ensureTelegramOperatorSpace(context);

    const scope = { chatId: context.chatId, userId: context.userId, spaceId: buildTelegramSpaceId(context.chatId) };
    const pending = listPendingApprovalActions(scope);
    const pendingTools = new Map(
        listPendingApprovalDetails(scope).map(({ actionClass, toolName }) => [actionClass, toolName])
    );
    const parts = parseSubcommand(context.text, command);
    const requestedAction = resolveRequestedApprovalAction(parts[0], pending);
    if (requestedAction === null) {
        return {
            text:
                pending.length > 0
                    ? `[TOOL_RESULT] Approval "${parts[0]}" is not pending. Pending: ${pending.join(', ')}.`
                    : '[TOOL_RESULT] No pending approvals for this space.',
            continuations: [],
        };
    }

    const result =
        command === 'approve'
            ? approvePendingAction(scope, requestedAction)
            : denyPendingAction(scope, requestedAction);

    if (result.error) {
        const remaining = listPendingApprovalActions(scope);
        if (remaining.length === 0) {
            return { text: '[TOOL_RESULT] No pending approvals for this space.', continuations: [] };
        }

        if (!requestedAction && remaining.length > 1) {
            return {
                text: `[TOOL_RESULT] More than one approval is pending: ${remaining.join(', ')}. Use /${command} <action>.`,
                continuations: [],
            };
        }

        return {
            text: `[TOOL_RESULT] ${result.error} Pending: ${remaining.join(', ')}.`,
            continuations: [],
        };
    }

    const actions = command === 'approve' ? result.granted : result.denied;
    for (const actionClass of actions) {
        logEvent('approval_decision', {
            space_id: spaceId,
            user_id: context.userId,
            channel: 'telegram',
            channel_ref: context.chatId,
            action_class: actionClass,
            tool_name:
                result.continuations?.find((item) => item.actionClass === actionClass)?.toolName ||
                pendingTools.get(actionClass) ||
                null,
            decision: command === 'approve' ? 'approved' : 'denied',
            source: 'command',
        });
    }
    return {
        text: `[TOOL_RESULT] ${command === 'approve' ? 'Approved' : 'Denied'}: ${actions.join(', ')}.`,
        continuations: result.continuations || [],
    };
}

export function runApprovalTelegramCommand(command: 'approve' | 'deny', context: TelegramOperatorContext): string {
    return resolveApprovalTelegramCommand(command, context).text;
}

export async function runApprovalTelegramCommandAsync(
    command: 'approve' | 'deny',
    context: TelegramOperatorContext
): Promise<string> {
    const resolution = resolveApprovalTelegramCommand(command, context);
    if (resolution.continuations.length === 0) return resolution.text;

    const results = await executeApprovedToolContinuations(resolution.continuations, {
        userId: context.userId,
        spaceId: buildTelegramSpaceId(context.chatId),
        chatId: context.chatId,
        channel: 'telegram',
        channelRef: context.chatId,
    });
    const executed = formatApprovedToolContinuationReply(results);
    return executed ? `[TOOL_RESULT] ${executed}` : resolution.text;
}

// ---------------------------------------------------------------------------
// /pack — inspect current pack or mutate to a different one
// ---------------------------------------------------------------------------

export function runPackTelegramCommand(context: TelegramOperatorContext): string {
    const spaceId = ensureTelegramOperatorSpace(context);
    const parts = parseSubcommand(context.text, 'pack');
    const subcommand = parts[0]?.toLowerCase();

    const space = getSpace(spaceId);
    const currentPackId = space?.assistant_pack_id || 'unknown';
    const availableIds = getAssistantPackIds();
    const currentAgent = materializeAgentForPack(currentPackId);
    const isNaked = currentAgent.source === 'static';

    if (!subcommand || subcommand === 'status') {
        const packLines = availableIds.map((id) => {
            const marker = id === currentPackId ? ' ← current' : '';
            const pack = getAssistantPack(id);
            return `  ${id} (${pack.persona_id})${marker}`;
        });

        const header = isNaked
            ? `⚠ Pack "${currentPackId}" is not installed. Bot is running naked.\nPick a pack: /pack mutate <id>`
            : `Current pack: ${currentPackId} (${currentAgent.persona_id})`;

        return `${header}\n\nAvailable packs:\n${packLines.join('\n')}\n\nSwitch or refresh the current pack: /pack mutate <id>`;
    }

    if (subcommand === 'mutate') {
        const targetId = parts[1]?.toLowerCase();
        if (!targetId) {
            return `Usage: /pack mutate <id>\n\nAvailable: ${availableIds.join(', ')}`;
        }

        if (!availableIds.includes(targetId)) {
            return `Unknown pack "${targetId}".\nAvailable: ${availableIds.join(', ')}`;
        }

        const handlers = getRegisteredHandlers();
        if (!handlers.space_set_pack) {
            return 'Pack switching is not available (spaces skill not loaded).';
        }

        // space_set_pack is async but we call it synchronously here —
        // the handler itself is sync-safe (db writes only), the async
        // wrapper comes from the dynamic import of tasks inside it.
        // Return a promise-based result via the caller.
        return `__async:pack:${targetId}`;
    }

    return `Usage:\n/pack\n/pack mutate <id> — switch, or refresh when <id> is already current`;
}

export async function runPackTelegramCommandAsync(context: TelegramOperatorContext): Promise<string> {
    const sync = runPackTelegramCommand(context);
    if (!sync.startsWith('__async:pack:')) return sync;

    const targetId = sync.replace('__async:pack:', '');
    const spaceId = buildTelegramSpaceId(context.chatId);
    const handlers = getRegisteredHandlers();
    const result = await handlers.space_set_pack!(
        { pack_id: targetId },
        { chatId: context.chatId, userId: context.userId, spaceId }
    );
    return stripToolResultPrefix(result);
}

// ---------------------------------------------------------------------------
// /backup — create or inspect runtime backups
// ---------------------------------------------------------------------------

export async function runBackupTelegramCommand(context: TelegramOperatorContext): Promise<string> {
    ensureTelegramOperatorSpace(context);
    const parts = parseSubcommand(context.text, 'backup');
    const subcommand = parts[0]?.toLowerCase();

    if (subcommand === 'status') {
        const latest = getLatestRuntimeBackup();
        if (!latest) {
            return 'No backups yet.\n\nCreate one: /backup\nTip: always run /backup before upgrading the bot.';
        }

        const age = Date.now() - new Date(latest.created_at).getTime();
        const hoursAgo = Math.round(age / (1000 * 60 * 60));
        const ageLabel = hoursAgo < 1 ? 'just now' : `${hoursAgo}h ago`;
        const total = listRuntimeBackups(1000).length;

        const warningLine = latest.warnings.length > 0 ? `\nWarnings: ${latest.warnings.join(' | ')}` : '';

        return [
            `Latest backup: ${latest.id}`,
            `Created: ${latest.created_at} (${ageLabel})`,
            `Health: ${latest.health_status} | Files: ${latest.file_count}`,
            `Spaces: ${latest.counts.spaces} | Memory: ${latest.counts.memory_entries} | Tasks: ${latest.counts.tasks}`,
            `Total backups: ${total}`,
            warningLine,
            '',
            'Tip: run /backup before upgrading the bot.',
        ]
            .filter(Boolean)
            .join('\n');
    }

    if (!subcommand) {
        const backup = await createRuntimeBackup('manual');
        const warningLine = backup.warnings.length > 0 ? `\nWarnings: ${backup.warnings.join(' | ')}` : '';

        return [
            `Backup created: ${backup.id}`,
            `Files: ${backup.file_count} | Spaces: ${backup.counts.spaces} | Memory: ${backup.counts.memory_entries}`,
            warningLine,
        ]
            .filter(Boolean)
            .join('\n');
    }

    return 'Usage:\n/backup — create a backup now\n/backup status — show latest backup';
}
