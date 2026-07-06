import {
    ensureSpace,
    ensureSpaceMembership,
    getDb,
    getSpace,
    storeMessage,
    updateSpaceAssistantPack,
    updateSpacePolicy,
    upsertTask,
    upsertResident,
} from '../db';
import { sendSpaceMessage } from '../channels/runtime';
import { runSetupTelegramCommand } from '../channels/operator-commands';
import { composeConversationContext } from './context-composer';
import { getMemoryContext } from './memory-context';
import { rememberSpaceMemory } from './memory-write';
import { resolveSpacePolicy } from './policy';
import { resolveSpaceOperationalSettings } from './space-preferences';
import { runAssistantTask } from './tasks';
import { executeToolCall } from './tool-executor';
import { recordApprovalResponse, requireToolApproval } from '../utils/approvals';

export type EvaluatorScenarioStatus = 'passed' | 'failed' | 'skipped';

export interface EvaluatorScenarioResult {
    id: string;
    title: string;
    status: EvaluatorScenarioStatus;
    summary: string;
    evidence: string[];
    error?: string;
}

export interface EvaluatorReport {
    ok: boolean;
    started_at: string;
    finished_at: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    scenarios: EvaluatorScenarioResult[];
}

export type EvaluatorSeverity = 'low' | 'medium' | 'high';

export interface CompactOperationalFailure {
    id: string;
    title: string;
    severity: EvaluatorSeverity;
    summary: string;
    evidence: string[];
    error?: string;
}

export interface CompactOperationalReport {
    ok: boolean;
    generated_at: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    summary: string;
    failed_ids: string[];
    passed_ids: string[];
    skipped_ids: string[];
    failures: CompactOperationalFailure[];
}

type ScenarioContext = {
    runId: string;
};

function makeRunId(): string {
    return `kiss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function scenarioSpaceRef(runId: string, label: string): string {
    return `evaluator-${runId}-${label}`;
}

function severityForScenario(id: string): EvaluatorSeverity {
    if (id === 'memory_isolation' || id === 'tool_policy_block' || id === 'session_handoff') {
        return 'high';
    }
    if (
        id === 'cross_channel_continuation' ||
        id === 'space_bootstrap_and_pack_attach' ||
        id === 'channel_mode_gate' ||
        id === 'approval_single_pending'
    ) {
        return 'medium';
    }
    return 'low';
}

function compactSummary(report: EvaluatorReport): string {
    if (report.failed === 0) {
        return `${report.passed}/${report.total} operational scenarios passed. No regressions detected.`;
    }

    const failedIds = report.scenarios
        .filter((scenario) => scenario.status === 'failed')
        .map((scenario) => scenario.id)
        .join(', ');
    return `${report.failed}/${report.total} operational scenarios failed. Impacted invariants: ${failedIds}.`;
}

function seedResidentInSpace(args: {
    spaceId: string;
    personId: string;
    displayName: string;
    role?: 'owner' | 'member';
}): void {
    upsertResident({
        tg_id: args.personId,
        display_name: args.displayName,
        username: args.displayName.toLowerCase().replace(/\s+/g, '_'),
        role: args.role || 'owner',
    });
    ensureSpaceMembership(args.spaceId, args.personId, args.role || 'owner');
}

function appendScenarioMessage(args: {
    id: string;
    spaceId: string;
    channel: string;
    channelRef: string;
    senderId?: string | null;
    content: string;
    isBot?: boolean;
    timestamp?: string;
}): void {
    storeMessage({
        id: args.id,
        space_id: args.spaceId,
        channel: args.channel,
        channel_ref: args.channelRef,
        sender_id: args.senderId ?? null,
        content: args.content,
        timestamp: args.timestamp || new Date().toISOString(),
        is_bot: args.isBot ? 1 : 0,
    });
}

function buildPassed(id: string, title: string, summary: string, evidence: string[]): EvaluatorScenarioResult {
    return { id, title, status: 'passed', summary, evidence };
}

function buildFailed(
    id: string,
    title: string,
    summary: string,
    error: unknown,
    evidence: string[] = []
): EvaluatorScenarioResult {
    return {
        id,
        title,
        status: 'failed',
        summary,
        evidence,
        error: error instanceof Error ? error.message : String(error),
    };
}

async function runScenario(
    id: string,
    title: string,
    fn: (context: ScenarioContext) => Promise<EvaluatorScenarioResult>,
    context: ScenarioContext
): Promise<EvaluatorScenarioResult> {
    try {
        return await fn(context);
    } catch (error) {
        return buildFailed(id, title, `${title} failed.`, error);
    }
}

async function evaluateSpaceBootstrapAndPackAttach(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Create space and attach pack';
    const space = ensureSpace('telegram', scenarioSpaceRef(context.runId, 'pack'), {
        kind: 'group_chat',
        title: 'Evaluator Pack Space',
        assistant_pack_id: 'jeeves',
    });

    const emptyMemory = getMemoryContext({ spaceId: space.id });
    if (emptyMemory !== '') {
        throw new Error('A newly created space did not start with empty memory context.');
    }

    const beforePolicy = resolveSpacePolicy(space.id);
    updateSpaceAssistantPack(space.id, 'reporter');

    const updatedSpace = getSpace(space.id);
    const afterPolicy = resolveSpacePolicy(space.id);

    if (updatedSpace?.assistant_pack_id !== 'reporter') {
        throw new Error(`Expected assistant pack "reporter", got "${updatedSpace?.assistant_pack_id || 'missing'}".`);
    }

    if (beforePolicy.memory_sprint_days === afterPolicy.memory_sprint_days || afterPolicy.memory_sprint_days !== 14) {
        throw new Error(
            `Expected reporter defaults to set memory_sprint_days=14, got ${afterPolicy.memory_sprint_days}.`
        );
    }

    return buildPassed(
        'space_bootstrap_and_pack_attach',
        title,
        'A fresh space bootstraps cleanly and pack attachment changes operational defaults.',
        [
            `space_id=${space.id}`,
            'initial_pack=jeeves',
            `final_pack=${updatedSpace.assistant_pack_id}`,
            `initial_memory_sprint_days=${beforePolicy.memory_sprint_days}`,
            `final_memory_sprint_days=${afterPolicy.memory_sprint_days}`,
        ]
    );
}

async function evaluateSetupFacadeBootstrap(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Setup facade bootstraps a new space';
    const chatId = scenarioSpaceRef(context.runId, 'setup');
    const spaceId = `telegram:${chatId}`;

    upsertResident({
        tg_id: '333',
        username: 'setup_owner',
        display_name: 'Setup Owner',
        role: 'owner',
    });

    const initial = await runSetupTelegramCommand({
        chatId,
        chatType: 'private',
        userId: '333',
        text: '/setup',
    });
    const beforeSettings = resolveSpaceOperationalSettings(getSpace(spaceId)?.policy_json);

    if (!initial.includes('Setup state: new')) {
        throw new Error(`Expected /setup to show a new state, got "${initial}".`);
    }
    if (beforeSettings.onboarding_state !== 'new') {
        throw new Error(`Expected a new setup state before apply, got "${beforeSettings.onboarding_state}".`);
    }

    const applied = await runSetupTelegramCommand({
        chatId,
        chatType: 'private',
        userId: '333',
        text: '/setup apply',
    });
    const activeStatus = await runSetupTelegramCommand({
        chatId,
        chatType: 'private',
        userId: '333',
        text: '/setup status',
    });
    const afterSettings = resolveSpaceOperationalSettings(getSpace(spaceId)?.policy_json);

    if (afterSettings.onboarding_state !== 'active') {
        throw new Error(`Expected /setup apply to activate onboarding, got "${afterSettings.onboarding_state}".`);
    }
    if (afterSettings.setup_version !== 1) {
        throw new Error(`Expected setup_version=1 after apply, got ${afterSettings.setup_version}.`);
    }
    if (!activeStatus.includes('Setup state: active')) {
        throw new Error(`Expected /setup status to show active, got "${activeStatus}".`);
    }

    return buildPassed(
        'setup_facade_bootstrap',
        title,
        'The setup facade gives a clear new -> active transition for a fresh Telegram space.',
        [
            `space_id=${spaceId}`,
            `before_state=${beforeSettings.onboarding_state}`,
            `after_state=${afterSettings.onboarding_state}`,
            `setup_version=${afterSettings.setup_version}`,
            `apply_result=${applied.split('\n')[0]}`,
        ]
    );
}

async function evaluateMemoryIsolation(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Memory stays isolated between spaces';
    const left = ensureSpace('telegram', scenarioSpaceRef(context.runId, 'memory-a'), {
        kind: 'group_chat',
        title: 'Evaluator Memory A',
    });
    const right = ensureSpace('telegram', scenarioSpaceRef(context.runId, 'memory-b'), {
        kind: 'group_chat',
        title: 'Evaluator Memory B',
    });

    rememberSpaceMemory(left.id, 'note', 'alpha evaluator memory');
    rememberSpaceMemory(right.id, 'note', 'beta evaluator memory');

    const leftContext = getMemoryContext({ spaceId: left.id });
    const rightContext = getMemoryContext({ spaceId: right.id });

    if (!leftContext.includes('alpha evaluator memory')) {
        throw new Error('Left space did not retain its own memory.');
    }
    if (!rightContext.includes('beta evaluator memory')) {
        throw new Error('Right space did not retain its own memory.');
    }
    if (leftContext.includes('beta evaluator memory')) {
        throw new Error('Left space leaked memory from the right space.');
    }
    if (rightContext.includes('alpha evaluator memory')) {
        throw new Error('Right space leaked memory from the left space.');
    }

    return buildPassed('memory_isolation', title, 'Structured memory remains scoped to its own space.', [
        `left_space_id=${left.id}`,
        `right_space_id=${right.id}`,
        'left_context_contains=alpha evaluator memory',
        'right_context_contains=beta evaluator memory',
    ]);
}

async function evaluateToolPolicyBlock(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Tool policy blocks dangerous capability';
    const space = ensureSpace('telegram', scenarioSpaceRef(context.runId, 'policy'), {
        kind: 'group_chat',
        title: 'Evaluator Policy Space',
        assistant_pack_id: 'jeeves',
        policy_json: JSON.stringify({
            browser: false,
            audit_trail: 'all',
        }),
    });

    let handlerCalled = false;
    const result = await executeToolCall({
        toolName: 'browse_web',
        toolArgs: { url: 'https://example.com' },
        context: {
            userId: 'evaluator',
            chatId: space.external_ref,
            channel: space.channel,
            channelRef: space.external_ref,
            spaceId: space.id,
        },
        handlers: {
            browse_web: async () => {
                handlerCalled = true;
                return 'unexpected';
            },
        },
    });

    const row = getDb()
        .prepare(
            `
        SELECT status, error, tool_name
        FROM tool_execution_log
        WHERE space_id = ?
        ORDER BY id DESC
        LIMIT 1
    `
        )
        .get(space.id) as { status: string; error: string | null; tool_name: string } | undefined;

    if (!result.includes('blocked by current execution policy')) {
        throw new Error(`Expected policy block result, got "${result}".`);
    }
    if (handlerCalled) {
        throw new Error('Blocked tool still reached its handler.');
    }
    if (!row || row.status !== 'blocked' || row.tool_name !== 'browse_web') {
        throw new Error('Blocked tool execution was not recorded in the audit log.');
    }

    return buildPassed(
        'tool_policy_block',
        title,
        'The executor stops a blocked tool before it can run and records the block.',
        [
            `space_id=${space.id}`,
            `tool_name=${row.tool_name}`,
            `audit_status=${row.status}`,
            `audit_error=${row.error || 'none'}`,
        ]
    );
}

async function evaluateChannelModeGate(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Channel mode gates background execution';
    const space = ensureSpace('telegram', scenarioSpaceRef(context.runId, 'channel-gate'), {
        kind: 'group_chat',
        title: 'Evaluator Channel Gate',
        assistant_pack_id: 'jeeves',
    });

    updateSpacePolicy(space.id, { channel_mode: 'off' });
    upsertTask({
        id: `task:${space.id}:quiet-check`,
        space_id: space.id,
        title: 'Quiet check',
        kind: 'assistant_prompt',
        prompt: 'Send the quiet room digest.',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        config_json: '{}',
        status: 'active',
        created_by: 'evaluator',
    });

    await runAssistantTask(`task:${space.id}:quiet-check`);
    const sendResult = await sendSpaceMessage(space.id, 'Background ping');
    const taskRun = getDb()
        .prepare(
            `
        SELECT status, result
        FROM task_runs
        WHERE task_id = ?
        ORDER BY started_at DESC
        LIMIT 1
    `
        )
        .get(`task:${space.id}:quiet-check`) as { status: string; result: string | null } | undefined;
    const cronMessages = (
        getDb()
            .prepare(
                `
        SELECT COUNT(*) as cnt
        FROM messages
        WHERE space_id = ? AND sender_tg_id = 'system_cron'
    `
            )
            .get(space.id) as { cnt: number }
    ).cnt;

    if (!sendResult.success || !sendResult.messageId?.startsWith('suppressed:')) {
        throw new Error(`Expected channel-off sends to be suppressed, got ${JSON.stringify(sendResult)}.`);
    }
    if (!taskRun || taskRun.status !== 'success' || taskRun.result !== 'skipped:channel-off') {
        throw new Error(`Expected assistant task to skip on channel-off, got ${JSON.stringify(taskRun)}.`);
    }
    if (cronMessages !== 0) {
        throw new Error('Channel-off task execution still persisted a system cron message.');
    }

    return buildPassed(
        'channel_mode_gate',
        title,
        'Channel-off mode suppresses background sends and skips assistant prompt tasks cleanly.',
        [
            `space_id=${space.id}`,
            'channel_mode=off',
            `send_result=${sendResult.messageId || 'missing'}`,
            `task_run=${taskRun.result || 'missing'}`,
            `cron_messages=${cronMessages}`,
        ]
    );
}

async function evaluateApprovalSinglePending(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Single pending approval resolves cleanly';
    const chatId = scenarioSpaceRef(context.runId, 'approval');
    const scope = {
        chatId,
        userId: '444',
        spaceId: `telegram:${chatId}`,
    };

    const prompt = requireToolApproval('browse_web', scope, 'Need to open example.com');
    const response = recordApprovalResponse(scope, 'да');
    const cachedGrant = requireToolApproval('browse_web', scope, 'Need to open example.com again');

    if (!prompt?.includes('browse_web')) {
        throw new Error(`Expected approval prompt for browse_web, got "${prompt}".`);
    }
    if (response.granted.join(',') !== 'browse_web' || response.denied.length > 0) {
        throw new Error(`Expected a single browse_web grant, got ${JSON.stringify(response)}.`);
    }
    if (cachedGrant !== null) {
        throw new Error(`Expected cached consent to skip a second prompt, got "${cachedGrant}".`);
    }

    return buildPassed(
        'approval_single_pending',
        title,
        'A single pending approval can be confirmed naturally and reused during its short consent TTL.',
        [
            `space_id=${scope.spaceId}`,
            'pending_action=browse_web',
            `granted=${response.granted.join(',')}`,
            `cached_grant=${cachedGrant === null}`,
        ]
    );
}

async function evaluateCrossChannelContinuation(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Continue the same space across channels';
    const space = ensureSpace('discord', scenarioSpaceRef(context.runId, 'continuity'), {
        kind: 'group_chat',
        title: 'Evaluator Continuity Space',
        assistant_pack_id: 'office',
    });

    seedResidentInSpace({
        spaceId: space.id,
        personId: '111',
        displayName: 'Alice',
        role: 'owner',
    });

    appendScenarioMessage({
        id: `${context.runId}-continuity-1`,
        spaceId: space.id,
        channel: 'discord',
        channelRef: 'ops-alpha',
        senderId: '111',
        content: 'Please keep the release checklist moving.',
    });
    appendScenarioMessage({
        id: `${context.runId}-continuity-2`,
        spaceId: space.id,
        channel: 'discord',
        channelRef: 'ops-beta',
        content: 'Checklist acknowledged. I will continue in the next thread.',
        isBot: true,
    });

    const composed = composeConversationContext({
        spaceId: space.id,
        senderId: '111',
        channelRef: 'ops-beta',
    });

    const historyText = composed.llmMessages
        .filter((message) => message.role !== 'system')
        .map((message) => message.content)
        .join('\n');
    const distinctChannels = (
        getDb()
            .prepare(
                `
        SELECT COUNT(DISTINCT chat_jid) as cnt
        FROM messages
        WHERE space_id = ?
    `
            )
            .get(space.id) as { cnt: number }
    ).cnt;

    if (!historyText.includes('Please keep the release checklist moving.')) {
        throw new Error('Cross-channel context missed the earlier user message.');
    }
    if (!historyText.includes('Checklist acknowledged. I will continue in the next thread.')) {
        throw new Error('Cross-channel context missed the later assistant message.');
    }
    if (!composed.systemPrompt.includes('Channel ref: ops-beta')) {
        throw new Error('Composed context did not reflect the active continuation channel.');
    }
    if (distinctChannels < 2) {
        throw new Error('Scenario setup did not persist multiple channel refs into one space.');
    }

    return buildPassed(
        'cross_channel_continuation',
        title,
        'A rebuilt prompt keeps shared history while switching the active channel reference.',
        [
            `space_id=${space.id}`,
            `distinct_channel_refs=${distinctChannels}`,
            'history_contains=Please keep the release checklist moving.',
            'history_contains=Checklist acknowledged. I will continue in the next thread.',
            'active_channel_ref=ops-beta',
        ]
    );
}

async function evaluateSessionHandoff(context: ScenarioContext): Promise<EvaluatorScenarioResult> {
    const title = 'Session handoff preserves state';
    const space = ensureSpace('telegram', scenarioSpaceRef(context.runId, 'handoff'), {
        kind: 'group_chat',
        title: 'Evaluator Handoff Space',
        assistant_pack_id: 'jeeves',
    });

    seedResidentInSpace({
        spaceId: space.id,
        personId: '222',
        displayName: 'Bob',
        role: 'owner',
    });
    rememberSpaceMemory(space.id, 'note', 'carry the deployment state forward');

    appendScenarioMessage({
        id: `${context.runId}-handoff-1`,
        spaceId: space.id,
        channel: 'telegram',
        channelRef: space.external_ref,
        senderId: '222',
        content: 'We already approved staging deploy.',
    });
    appendScenarioMessage({
        id: `${context.runId}-handoff-2`,
        spaceId: space.id,
        channel: 'telegram',
        channelRef: space.external_ref,
        content: 'Understood. I will preserve that state.',
        isBot: true,
    });

    const firstSession = composeConversationContext({
        spaceId: space.id,
        senderId: '222',
        channelRef: space.external_ref,
    });

    appendScenarioMessage({
        id: `${context.runId}-handoff-3`,
        spaceId: space.id,
        channel: 'telegram',
        channelRef: space.external_ref,
        senderId: '222',
        content: 'Resume from where we left off and prepare prod next.',
    });

    const secondSession = composeConversationContext({
        spaceId: space.id,
        senderId: '222',
        channelRef: space.external_ref,
    });

    const secondHistory = secondSession.llmMessages
        .filter((message) => message.role !== 'system')
        .map((message) => message.content)
        .join('\n');

    if (!firstSession.systemPrompt.includes('carry the deployment state forward')) {
        throw new Error('Initial session context missed the stored space memory.');
    }
    if (!secondSession.systemPrompt.includes('carry the deployment state forward')) {
        throw new Error('Handoff session lost the stored space memory.');
    }
    if (!secondHistory.includes('We already approved staging deploy.')) {
        throw new Error('Handoff session lost the earlier conversation state.');
    }
    if (!secondHistory.includes('Resume from where we left off and prepare prod next.')) {
        throw new Error('Handoff session missed the resumed user turn.');
    }
    if (secondSession.llmMessages.length < firstSession.llmMessages.length) {
        throw new Error('Handoff session did not preserve or extend the prior context window.');
    }

    return buildPassed(
        'session_handoff',
        title,
        'A new context build preserves earlier history and durable memory for the same space.',
        [
            `space_id=${space.id}`,
            'memory_contains=carry the deployment state forward',
            'history_contains=We already approved staging deploy.',
            'history_contains=Resume from where we left off and prepare prod next.',
            `first_session_messages=${firstSession.llmMessages.length}`,
            `second_session_messages=${secondSession.llmMessages.length}`,
        ]
    );
}

export async function runMinimalEvaluator(): Promise<EvaluatorReport> {
    const startedAt = new Date().toISOString();
    const context: ScenarioContext = { runId: makeRunId() };

    const scenarios = await Promise.all([
        runScenario(
            'space_bootstrap_and_pack_attach',
            'Create space and attach pack',
            evaluateSpaceBootstrapAndPackAttach,
            context
        ),
        runScenario(
            'setup_facade_bootstrap',
            'Setup facade bootstraps a new space',
            evaluateSetupFacadeBootstrap,
            context
        ),
        runScenario('memory_isolation', 'Memory stays isolated between spaces', evaluateMemoryIsolation, context),
        runScenario('tool_policy_block', 'Tool policy blocks dangerous capability', evaluateToolPolicyBlock, context),
        runScenario('channel_mode_gate', 'Channel mode gates background execution', evaluateChannelModeGate, context),
        runScenario(
            'approval_single_pending',
            'Single pending approval resolves cleanly',
            evaluateApprovalSinglePending,
            context
        ),
        runScenario(
            'cross_channel_continuation',
            'Continue the same space across channels',
            evaluateCrossChannelContinuation,
            context
        ),
        runScenario('session_handoff', 'Session handoff preserves state', evaluateSessionHandoff, context),
    ]);

    const passed = scenarios.filter((scenario) => scenario.status === 'passed').length;
    const failed = scenarios.filter((scenario) => scenario.status === 'failed').length;
    const skipped = scenarios.filter((scenario) => scenario.status === 'skipped').length;

    return {
        ok: failed === 0,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        total: scenarios.length,
        passed,
        failed,
        skipped,
        scenarios,
    };
}

export function toCompactOperationalReport(report: EvaluatorReport): CompactOperationalReport {
    const failedScenarios = report.scenarios.filter((scenario) => scenario.status === 'failed');
    const passedIds = report.scenarios
        .filter((scenario) => scenario.status === 'passed')
        .map((scenario) => scenario.id);
    const failedIds = failedScenarios.map((scenario) => scenario.id);
    const skippedIds = report.scenarios
        .filter((scenario) => scenario.status === 'skipped')
        .map((scenario) => scenario.id);

    return {
        ok: report.ok,
        generated_at: report.finished_at,
        total: report.total,
        passed: report.passed,
        failed: report.failed,
        skipped: report.skipped,
        summary: compactSummary(report),
        failed_ids: failedIds,
        passed_ids: passedIds,
        skipped_ids: skippedIds,
        failures: failedScenarios.map((scenario) => ({
            id: scenario.id,
            title: scenario.title,
            severity: severityForScenario(scenario.id),
            summary: scenario.summary,
            evidence: scenario.evidence.slice(0, 3),
            error: scenario.error,
        })),
    };
}
