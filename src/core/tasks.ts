import cron, { ScheduledTask } from 'node-cron';
import {
    deleteTask,
    ensureTelegramSpace,
    getActiveProjectForSpace,
    getAllResidents,
    getDb,
    listSpaces,
    getSpace,
    getSpaceParticipants,
    getTask,
    linkProjectTarget,
    listTasks,
    recordTaskRun,
    storeMessage,
    Task,
    updateTaskStatus,
    updateTaskLastRun,
    upsertTask,
} from '../db';
import { handleButlerMessage } from '../agents/butler';
import { sendSpaceMessage } from '../channels/runtime';
import { getImportantDatesContext } from './memory-context';
import { rememberTaskOutcome } from './memory-write';
import { SeededTaskTemplate } from './assistant-pack';
import { materializeAgentForSpace } from './agent-kernel';
import { resolveSpacePolicy } from './policy';
import { resolveSpaceOperationalSettings } from './space-preferences';
import { AuditMode, normalizeAuditMode } from './tool-execution';
import { appendTimelineEvent } from './timeline';

type SeededTaskSpec = {
    id: string;
    template_id: string;
    title: string;
    kind: 'assistant_prompt' | 'atelier_summary';
    prompt: string;
    schedule_value: string;
};

type DeadlineAlertKind = 'upcoming' | 'overdue';

export type StoredTaskConfig = {
    audit_trail?: AuditMode;
    seeded?: {
        pack_id?: string;
        template_id?: string;
    };
    deadline?: {
        at?: string;
        alerted_for_at?: string;
        last_alert_kind?: DeadlineAlertKind;
        last_alert_at?: string;
    };
    ritual?: {
        custom_schedule?: boolean;
        custom_status?: boolean;
    };
};

type TaskExecutionConfig = {
    audit_trail?: AuditMode;
    deadline_at?: string;
};

const scheduledTasks = new Map<string, ScheduledTask>();
const TZ = process.env.TZ ? { timezone: process.env.TZ } : {};
const SYSTEM_TASK_CREATOR = 'system';
const SYSTEM_TASK_SENDER_ID = 'system_cron';
const DEFAULT_PACK_ID = 'jeeves';
const TELEGRAM_TASK_FORMAT_INSTRUCTIONS = [
    'TELEGRAM FORMAT:',
    '- Use **bold** for section headers, project names, owners, and important decisions.',
    '- Use a small, useful emoji at the start of major sections when it improves scanning.',
    '- Use short "- " bullets and indented "- " sub-bullets; do not use raw "*" bullets.',
    '- Keep paragraphs short and avoid nesting deeper than two levels.',
].join('\n');

type AssistantTaskKind = SeededTaskSpec['kind'];
type TaskExecutionOutcome = {
    status: 'success' | 'failed';
    result: string | null;
    error: string | null;
};

function getAssistantPackIdForSpace(spaceId: string): string {
    return getSpace(spaceId)?.assistant_pack_id || DEFAULT_PACK_ID;
}

function buildSeededTaskPrefix(spaceId: string): string {
    return `task:${spaceId}:`;
}

export function buildSeededTaskId(spaceId: string, templateId: string): string {
    return `${buildSeededTaskPrefix(spaceId)}${templateId}`;
}

function isSystemSeededTask(task: Task, spaceId: string): boolean {
    return task.created_by === SYSTEM_TASK_CREATOR && task.id.startsWith(buildSeededTaskPrefix(spaceId));
}

function listSystemSeededTasks(spaceId: string): Task[] {
    return listTasks(spaceId).filter((task) => isSystemSeededTask(task, spaceId));
}

function deleteTasks(tasks: Task[]): void {
    for (const task of tasks) {
        deleteTask(task.id);
    }
}

function formatTaskDate(mode?: SeededTaskTemplate['date_mode']): string | null {
    if (mode !== 'full' && mode !== 'short') {
        return null;
    }

    return new Date().toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        ...(mode === 'full' ? { year: 'numeric' as const } : {}),
        timeZone: process.env.TZ || undefined,
    });
}

function buildCustomTaskSlug(title: string): string {
    return (
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 32) || 'task'
    );
}

function buildTaskConfigJson(config?: TaskExecutionConfig): string {
    return stringifyStoredTaskConfig({
        ...(config?.audit_trail ? { audit_trail: normalizeAuditMode(config.audit_trail) } : {}),
        ...(config?.deadline_at ? { deadline: { at: config.deadline_at } } : {}),
    });
}

export function parseStoredTaskConfig(raw: string | null | undefined): StoredTaskConfig {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as StoredTaskConfig;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function stringifyStoredTaskConfig(config: StoredTaskConfig): string {
    const normalized: Partial<StoredTaskConfig> = { ...config };

    if (!normalized.audit_trail) {
        delete normalized.audit_trail;
    }

    if (!normalized.seeded?.pack_id && !normalized.seeded?.template_id) {
        delete normalized.seeded;
    } else {
        normalized.seeded = {
            ...(normalized.seeded?.pack_id ? { pack_id: normalized.seeded.pack_id } : {}),
            ...(normalized.seeded?.template_id ? { template_id: normalized.seeded.template_id } : {}),
        };
    }

    const deadline = normalized.deadline;
    if (!deadline?.at) {
        delete normalized.deadline;
    } else {
        normalized.deadline = {
            at: deadline.at,
            ...(deadline.alerted_for_at ? { alerted_for_at: deadline.alerted_for_at } : {}),
            ...(deadline.last_alert_kind ? { last_alert_kind: deadline.last_alert_kind } : {}),
            ...(deadline.last_alert_at ? { last_alert_at: deadline.last_alert_at } : {}),
        };
    }

    const ritual = normalized.ritual;
    if (!(ritual?.custom_schedule === true || ritual?.custom_status === true)) {
        delete normalized.ritual;
    }

    return JSON.stringify(normalized);
}

function persistTaskConfig(task: Task, config: StoredTaskConfig): void {
    upsertTask({
        ...task,
        config_json: stringifyStoredTaskConfig(config),
        created_at: task.created_at,
    });
}

function formatTaskTimestamp(value: string): string {
    return value.substring(0, 16).replace('T', ' ');
}

export function getTaskDeadlineAt(task: Pick<Task, 'config_json'>): string | null {
    const deadlineAt = parseStoredTaskConfig(task.config_json).deadline?.at?.trim();
    if (!deadlineAt) return null;

    const parsed = new Date(deadlineAt);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

function buildTaskDeadlineMessage(task: Task, deadlineAt: string, kind: DeadlineAlertKind): string {
    const formattedDeadline = formatTaskTimestamp(deadlineAt);

    return kind === 'overdue'
        ? `⏰ Task deadline missed: "${task.title}" was due by ${formattedDeadline}.`
        : `⏰ Task deadline coming up: "${task.title}" is due by ${formattedDeadline}.`;
}

/**
 * Seeded and user-authored cron tasks share the same persistence shape, so we
 * keep the write path in one helper instead of repeating the mapping inline.
 */
function upsertAssistantCronTask(args: {
    id: string;
    spaceId: string;
    title: string;
    kind: AssistantTaskKind;
    prompt: string;
    scheduleValue: string;
    createdBy: string;
    configJson?: string;
    status?: string;
}): void {
    upsertTask({
        id: args.id,
        space_id: args.spaceId,
        title: args.title,
        kind: args.kind,
        prompt: args.prompt,
        schedule_type: 'cron',
        schedule_value: args.scheduleValue,
        config_json: args.configJson || '{}',
        status: args.status || 'active',
        created_by: args.createdBy,
    });
}

/**
 * Keep task memory and run history aligned so success/failure bookkeeping lives
 * in one place and future task kinds inherit the same reporting rules.
 */
function recordTaskExecution(task: Task, startedAt: string, startedMs: number, outcome: TaskExecutionOutcome): void {
    const finishedAt = new Date().toISOString();
    const summary = outcome.result || outcome.error || '';

    if (outcome.status === 'success') {
        updateTaskLastRun(task.id, finishedAt);
    }

    rememberTaskOutcome(task.space_id, task.title, outcome.status, summary);
    recordTaskRun({
        task_id: task.id,
        started_at: startedAt,
        finished_at: finishedAt,
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
        duration_ms: Date.now() - startedMs,
    });
    appendTimelineEvent({
        spaceId: task.space_id,
        type: outcome.status === 'success' ? 'task.run_succeeded' : 'task.run_failed',
        refType: 'task',
        refId: task.id,
        summary: `Task "${task.title}" ${outcome.status === 'success' ? 'completed' : 'failed'}: ${summary || 'no summary'}.`,
        details: {
            status: outcome.status,
            started_at: startedAt,
            finished_at: finishedAt,
        },
        happenedAt: finishedAt,
    });
}

function clearScheduledTasks(): void {
    for (const scheduled of scheduledTasks.values()) {
        scheduled.stop();
    }
    scheduledTasks.clear();
}

function shouldScheduleTask(task: Task): boolean {
    return task.schedule_type === 'cron' && resolveSpacePolicy(task.space_id).tasks;
}

function scheduleTask(task: Task): void {
    if (!cron.validate(task.schedule_value)) {
        console.warn(`[TASKS] Invalid cron schedule for ${task.id}: ${task.schedule_value}`);
        return;
    }

    const scheduled = cron.schedule(
        task.schedule_value,
        async () => {
            try {
                await runAssistantTask(task.id);
            } catch (error) {
                console.error(`[TASKS] Task ${task.id} failed:`, error);
            }
        },
        { ...TZ, name: task.id }
    );

    scheduledTasks.set(task.id, scheduled);
}

function syncSeededTasksForSpace(spaceId: string, seededTasks: SeededTaskSpec[], tasksEnabled: boolean): void {
    const existingSeededTasks = listSystemSeededTasks(spaceId);
    const existingById = new Map(existingSeededTasks.map((task) => [task.id, task]));
    const currentPackId = getAssistantPackIdForSpace(spaceId);

    /**
     * System tasks are declarative: every sync pass makes the database match the
     * current pack + policy instead of trying to patch individual differences.
     */
    if (!tasksEnabled) {
        deleteTasks(existingSeededTasks);
        return;
    }

    const expectedIds = new Set(seededTasks.map((task) => task.id));
    deleteTasks(existingSeededTasks.filter((task) => !expectedIds.has(task.id)));

    for (const task of seededTasks) {
        const existing = existingById.get(task.id);
        const config = parseStoredTaskConfig(existing?.config_json);
        const shouldRefreshTemplate = !!config.seeded?.pack_id && config.seeded.pack_id !== currentPackId;
        upsertAssistantCronTask({
            id: task.id,
            spaceId,
            title: existing && !shouldRefreshTemplate ? existing.title : task.title,
            kind: task.kind,
            prompt: existing && !shouldRefreshTemplate ? existing.prompt : task.prompt,
            scheduleValue:
                existing && (config.ritual?.custom_schedule || !shouldRefreshTemplate)
                    ? existing.schedule_value
                    : task.schedule_value,
            configJson: stringifyStoredTaskConfig({
                ...config,
                seeded: {
                    pack_id: currentPackId,
                    template_id: task.template_id,
                },
            }),
            status: existing && config.ritual?.custom_status ? existing.status : 'active',
            createdBy: SYSTEM_TASK_CREATOR,
        });
    }
}

function executeTaskByKind(task: Task): Promise<string> {
    return task.kind === 'atelier_summary' ? runAtelierSummaryTask(task) : runPromptTask(task);
}

function getRecentSpaceHistory(spaceId: string, hours: number): string {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = getDb()
        .prepare(
            `
        SELECT m.content, m.timestamp, r.nickname, r.display_name
        FROM messages m
        LEFT JOIN residents r ON m.sender_tg_id = r.tg_id
        WHERE m.space_id = ?
          AND m.is_bot = 0
          AND m.sender_tg_id != 'system_cron'
          AND m.timestamp > ?
        ORDER BY m.timestamp ASC
    `
        )
        .all(spaceId, cutoff) as {
        content: string;
        timestamp: string;
        nickname: string | null;
        display_name: string | null;
    }[];

    if (rows.length === 0) return '';

    return (
        `\n\nRecent chat history from the last ${hours} hours:\n` +
        rows
            .map((m) => {
                const name = m.nickname || m.display_name || 'Participant';
                return `[${m.timestamp.substring(11, 16)}] ${name}: ${m.content}`;
            })
            .join('\n')
    );
}

function getSpaceParticipantNames(spaceId: string): string {
    const participants = getSpaceParticipants(spaceId);
    const names = (participants.length > 0 ? participants : getAllResidents())
        .map((p) => p.nickname || p.display_name || p.username)
        .filter(Boolean);

    return names.join(', ');
}

function getSeededTasksForSpace(spaceId: string): SeededTaskSpec[] {
    const pack = materializeAgentForSpace(spaceId);

    return pack.seeded_tasks.map((template) => ({
        id: buildSeededTaskId(spaceId, template.template_id),
        template_id: template.template_id,
        title: template.title,
        kind: template.kind,
        prompt: template.prompt,
        schedule_value: template.schedule_value,
    }));
}

function getSeededTemplateForTask(task: Task): SeededTaskTemplate | undefined {
    const prefix = buildSeededTaskPrefix(task.space_id);
    if (!task.id.startsWith(prefix)) return undefined;

    const templateId = task.id.substring(prefix.length);
    return materializeAgentForSpace(task.space_id).seeded_tasks.find((template) => template.template_id === templateId);
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Collect live operational signals for initiative-style tasks.
 * Returns a human-readable block that gets injected into the task prompt
 * so the LLM knows what is worth acting on right now.
 *
 * Precondition: getDb() must succeed — if the database is not initialized,
 * this function will throw. Individual signal queries are isolated so a
 * single table/schema issue does not prevent other signals from collecting.
 */
export function collectInitiativeSignals(spaceId: string): string[] {
    const signals: string[] = [];
    const db = getDb();

    // Pending todos
    try {
        const { cnt } = db
            .prepare(`SELECT COUNT(*) as cnt FROM todos WHERE space_id = ? AND status = 'pending'`)
            .get(spaceId) as { cnt: number };
        if (cnt > 0) signals.push(`📝 ${cnt} pending todo(s)`);
    } catch (e) {
        process.stderr.write(`collectInitiativeSignals: todos query failed: ${e}\n`);
    }

    // Pending reminders
    // COALESCE handles legacy rows where space_id was NULL and only chat_jid existed.
    // After migration, both columns are populated, but COALESCE keeps backward compat.
    try {
        const { cnt } = db
            .prepare(
                `SELECT COUNT(*) as cnt FROM reminders WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ? AND status = 'pending'`
            )
            .get(spaceId) as { cnt: number };
        if (cnt > 0) signals.push(`🔔 ${cnt} pending reminder(s)`);
    } catch (e) {
        process.stderr.write(`collectInitiativeSignals: reminders query failed: ${e}\n`);
    }

    // Overdue tasks
    const now = Date.now();
    const overdue = listTasks(spaceId, 'active').filter((t) => {
        const deadlineAt = getTaskDeadlineAt(t);
        return deadlineAt && new Date(deadlineAt).getTime() < now;
    });
    if (overdue.length > 0) {
        signals.push(`⏰ ${overdue.length} task(s) past deadline: ${overdue.map((t) => t.title).join(', ')}`);
    }

    // Open atelier requests
    try {
        const { cnt } = db
            .prepare(
                `SELECT COUNT(*) as cnt FROM skill_requests WHERE space_id = ? AND status IN ('pending', 'in_progress')`
            )
            .get(spaceId) as { cnt: number };
        if (cnt > 0) signals.push(`🔧 ${cnt} open atelier request(s)`);
    } catch (e) {
        process.stderr.write(`collectInitiativeSignals: skill_requests query failed: ${e}\n`);
    }

    // Recent chat silence (no human messages in 24h)
    // sender_tg_id is the DB column; storeMessage normalizes sender_id → sender_tg_id.
    const cutoff24h = new Date(now - 24 * MS_PER_HOUR).toISOString();
    try {
        const { cnt } = db
            .prepare(
                `SELECT COUNT(*) as cnt FROM messages WHERE space_id = ? AND is_bot = 0 AND sender_tg_id != 'system_cron' AND timestamp > ?`
            )
            .get(spaceId, cutoff24h) as { cnt: number };
        if (cnt === 0) signals.push('🔇 No human messages in the last 24 hours — space is quiet');
    } catch (e) {
        process.stderr.write(`collectInitiativeSignals: messages query failed: ${e}\n`);
    }

    return signals;
}

function buildTaskPrompt(task: Task): string | null {
    if (task.kind === 'atelier_summary') {
        return null;
    }

    const space = getSpace(task.space_id);
    const seededTemplate = getSeededTemplateForTask(task);
    if (!seededTemplate || !space?.external_ref) {
        return task.prompt;
    }

    const participantNames = getSpaceParticipantNames(task.space_id) || 'participants not yet named';
    const history =
        seededTemplate.history_hours && seededTemplate.history_hours > 0
            ? getRecentSpaceHistory(task.space_id, seededTemplate.history_hours)
            : '';
    const date = formatTaskDate(seededTemplate.date_mode);
    const parts = [task.prompt];

    if (seededTemplate.audience_prefix) {
        parts.push(`${seededTemplate.audience_prefix} ${participantNames}.`);
    }
    if (date) {
        parts.push(`TODAY IS ${date}.`);
    }
    if (space.channel === 'telegram') {
        parts.push(TELEGRAM_TASK_FORMAT_INSTRUCTIONS);
    }
    if (seededTemplate.include_important_dates) {
        parts.push(`- ${getImportantDatesContext()}`);
    }
    if (history) {
        parts.push(history);
    }
    if (seededTemplate.ritual_key) {
        parts.push(
            'RITUAL SEND POLICY: send a note only when there is concrete useful context for this ritual. Do not mention onboarding status, adaptation day, knowledge density, or missing fact counts. Do not echo, rehash, or expand on topics from your own previous ritual messages — focus on new human-originated information only. If there are no priorities, blockers, commitments, tasks, reminders, or useful recent updates, reply exactly [NO_SEND].'
        );
    }
    if (seededTemplate.initiative_signals) {
        const signals = collectInitiativeSignals(task.space_id);
        parts.push('');
        parts.push('CURRENT SIGNALS:');
        parts.push(
            signals.length > 0
                ? signals.join('\n')
                : 'No urgent signals detected. Look for improvement opportunities or pending research.'
        );
    }

    return parts.join('\n');
}

async function runAtelierSummaryTask(task: Task): Promise<string> {
    const space = getSpace(task.space_id);
    if (!space?.external_ref) {
        return 'skipped:no-space';
    }

    const pending = getDb()
        .prepare(
            `
        SELECT COUNT(*) as cnt, MIN(created_at) as oldest
        FROM skill_requests
        WHERE space_id = ? AND status IN ('pending', 'in_progress')
    `
        )
        .get(task.space_id) as { cnt: number; oldest: string | null };

    if (!pending.cnt) {
        return 'skipped:no-open-requests';
    }

    const oldestDate = pending.oldest?.substring(0, 10) || '?';
    const daysAgo = pending.oldest ? Math.floor((Date.now() - new Date(pending.oldest).getTime()) / 86400000) : 0;

    const sendResult = await sendSpaceMessage(
        task.space_id,
        `📋 Atelier has ${pending.cnt} open request(s). Oldest: ${oldestDate} (${daysAgo} days ago). Use /atelier for details.`
    );

    if (!sendResult.success) {
        return `failed:${sendResult.error || 'send failed'}`;
    }

    return `sent:${pending.cnt}`;
}

async function runPromptTask(task: Task): Promise<string> {
    const space = getSpace(task.space_id);
    if (!space?.external_ref || !space.channel) {
        return 'skipped:unsupported-space';
    }

    const settings = resolveSpaceOperationalSettings(space.policy_json);
    if (settings.channel_mode === 'off') {
        return 'skipped:channel-off';
    }

    const prompt = buildTaskPrompt(task);
    if (!prompt) {
        return 'skipped:no-prompt';
    }

    storeMessage({
        id: `task-${task.id}-${Date.now()}`,
        space_id: task.space_id,
        channel_ref: space.external_ref,
        sender_id: SYSTEM_TASK_SENDER_ID,
        content: prompt,
        timestamp: new Date().toISOString(),
        is_bot: 0,
    });

    await handleButlerMessage({
        channel: space.channel,
        channelRef: space.external_ref,
        senderId: SYSTEM_TASK_SENDER_ID,
        text: prompt,
        spaceId: task.space_id,
        taskId: task.id,
    });
    return 'sent:assistant_prompt';
}

export async function runAssistantTask(taskId: string): Promise<void> {
    const task = getTask(taskId);
    if (!task || task.status !== 'active') return;

    const startedAt = new Date().toISOString();
    const startedMs = Date.now();

    try {
        const result = await executeTaskByKind(task);
        recordTaskExecution(task, startedAt, startedMs, {
            status: 'success',
            result,
            error: null,
        });
    } catch (error: any) {
        recordTaskExecution(task, startedAt, startedMs, {
            status: 'failed',
            result: null,
            error: error?.message || String(error),
        });
        throw error;
    }
}

export function ensureDefaultAssistantTasksForSpace(spaceId: string): void {
    const space = getSpace(spaceId);
    if (!space) return;

    const policy = resolveSpacePolicy(spaceId);
    syncSeededTasksForSpace(spaceId, getSeededTasksForSpace(spaceId), !!policy.tasks);
}

export function ensureDefaultAssistantTasks(chatId: string): void {
    const space = ensureTelegramSpace(chatId, 'group', chatId);
    ensureDefaultAssistantTasksForSpace(space.id);
}

export function ensureDefaultAssistantTasksForActiveSpaces(): number {
    let reseeded = 0;
    for (const space of listSpaces('ACTIVE')) {
        ensureDefaultAssistantTasksForSpace(space.id);
        if (resolveSpacePolicy(space.id).tasks) {
            reseeded += 1;
        }
    }
    return reseeded;
}

export function registerScheduledTasks(): number {
    clearScheduledTasks();

    for (const task of listTasks(undefined, 'active').filter(shouldScheduleTask)) {
        scheduleTask(task);
    }

    return scheduledTasks.size;
}

export function createAssistantTask(
    chatId: string,
    title: string,
    prompt: string,
    cronExpression: string,
    createdBy: string,
    config?: TaskExecutionConfig
): Task {
    const space = ensureTelegramSpace(chatId, 'group', chatId);
    return createAssistantTaskForSpace(space.id, title, prompt, cronExpression, createdBy, config);
}

export function createAssistantTaskForSpace(
    spaceId: string,
    title: string,
    prompt: string,
    cronExpression: string,
    createdBy: string,
    config?: TaskExecutionConfig
): Task {
    const id = `${buildSeededTaskPrefix(spaceId)}${buildCustomTaskSlug(title)}:${Date.now()}`;

    upsertAssistantCronTask({
        id,
        spaceId,
        title,
        kind: 'assistant_prompt',
        prompt,
        scheduleValue: cronExpression,
        configJson: buildTaskConfigJson(config),
        status: 'active',
        createdBy,
    });

    const activeProject = getActiveProjectForSpace(spaceId);
    if (activeProject) {
        linkProjectTarget(activeProject.id, 'task', id);
    }

    registerScheduledTasks();
    const task = getTask(id)!;
    appendTimelineEvent({
        spaceId,
        type: 'task.created',
        refType: 'task',
        refId: task.id,
        summary: `Created scheduled task "${task.title}" (${task.schedule_value}).`,
        details: {
            title: task.title,
            schedule: task.schedule_value,
            created_by: createdBy,
        },
    });
    return task;
}

export async function checkTaskDeadlines(): Promise<void> {
    const now = Date.now();
    const warningWindowMs = 24 * 60 * 60 * 1000;

    for (const task of listTasks(undefined, 'active').filter(shouldScheduleTask)) {
        const deadlineAt = getTaskDeadlineAt(task);
        if (!deadlineAt) continue;

        const deadlineMs = new Date(deadlineAt).getTime();
        const deltaMs = deadlineMs - now;
        const alertKind: DeadlineAlertKind | null =
            deltaMs <= 0 ? 'overdue' : deltaMs <= warningWindowMs ? 'upcoming' : null;

        if (!alertKind) continue;

        const config = parseStoredTaskConfig(task.config_json);
        const alreadyAlerted =
            config.deadline?.alerted_for_at === deadlineAt && config.deadline?.last_alert_kind === alertKind;
        if (alreadyAlerted) continue;

        try {
            const sendResult = await sendSpaceMessage(
                task.space_id,
                buildTaskDeadlineMessage(task, deadlineAt, alertKind),
                // The alert is uniquely identified by its task, deadline, and
                // kind, so the outbox refuses a second copy outright. The config
                // flag below still short-circuits the common case; this makes
                // duplicate alerts impossible rather than merely unlikely.
                { idempotencyKey: `task-deadline:${task.id}:${deadlineAt}:${alertKind}` }
            );
            if (!sendResult.success) {
                console.error(`[TASKS] Failed to send ${alertKind} deadline alert for ${task.id}:`, sendResult.error);
                continue;
            }

            const nextConfig = parseStoredTaskConfig(task.config_json);
            nextConfig.deadline = {
                ...(nextConfig.deadline || {}),
                at: deadlineAt,
                alerted_for_at: deadlineAt,
                last_alert_kind: alertKind,
                last_alert_at: new Date().toISOString(),
            };
            persistTaskConfig(task, nextConfig);

            appendTimelineEvent({
                spaceId: task.space_id,
                type: alertKind === 'overdue' ? 'task.deadline_overdue' : 'task.deadline_upcoming',
                refType: 'task',
                refId: task.id,
                summary: buildTaskDeadlineMessage(task, deadlineAt, alertKind),
                details: {
                    deadline_at: deadlineAt,
                    alert_kind: alertKind,
                },
            });
        } catch (error) {
            console.error(`[TASKS] Deadline check failed for ${task.id}:`, error);
        }
    }
}

export function pauseAssistantTask(taskId: string): Task | undefined {
    const task = getTask(taskId);
    if (!task) return undefined;

    updateTaskStatus(taskId, 'paused');
    registerScheduledTasks();
    const updated = getTask(taskId);
    if (updated) {
        appendTimelineEvent({
            spaceId: updated.space_id,
            type: 'task.paused',
            refType: 'task',
            refId: updated.id,
            summary: `Paused task "${updated.title}".`,
        });
    }
    return updated;
}

export function resumeAssistantTask(taskId: string): Task | undefined {
    const task = getTask(taskId);
    if (!task) return undefined;

    updateTaskStatus(taskId, 'active');
    registerScheduledTasks();
    const updated = getTask(taskId);
    if (updated) {
        appendTimelineEvent({
            spaceId: updated.space_id,
            type: 'task.resumed',
            refType: 'task',
            refId: updated.id,
            summary: `Resumed task "${updated.title}".`,
        });
    }
    return updated;
}

export function cancelAssistantTask(taskId: string): boolean {
    const task = getTask(taskId);
    const deleted = deleteTask(taskId);
    registerScheduledTasks();
    if (deleted > 0 && task) {
        appendTimelineEvent({
            spaceId: task.space_id,
            type: 'task.cancelled',
            refType: 'task',
            refId: task.id,
            summary: `Cancelled task "${task.title}".`,
        });
    }
    return deleted > 0;
}
