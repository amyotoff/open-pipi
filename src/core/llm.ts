import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { SpanKind } from '@opentelemetry/api';
import {
    GEMINI_API_KEY,
    GEMINI_EXECUTOR_MODEL,
    GEMINI_ADVISOR_MODEL,
    OLLAMA_URL,
    OLLAMA_MODEL,
    PIPI_ADVISOR_ENABLED,
    PIPI_ADVISOR_MAX_CALLS_PER_TURN,
} from '../config';
import { logEvent, logTokenUsage, getDailyTokenCost } from '../db';
import { guardLLMCall, reportGeminiResult, isOllamaHealthy } from './healthcheck';
import { reportOperationalFailure, reportOperationalRecovery } from '../utils/failure-monitor';
import { logError, logInfo, logWarn, summarizeError, summarizeText } from '../utils/logging';
import { RuntimeExecutionContext } from './runtime-context';
import { CORE_TOOLBOX_TOOL_DECLARATIONS, handleCoreToolboxTool, isCorePrimitiveBackingTool } from './coretoolbox';
import { executeToolCall } from './tool-executor';
import {
    addSpanAttributes,
    addSpanEvent,
    recordActiveSpanException,
    recordLlmRequest,
    withSpan,
} from '../observability';

// Tools that take a long time and warrant a "working on it" heads-up
const LONG_RUNNING_TOOLS = new Set(['groceries_search', 'browse_web', 'webrun_execute', 'web', 'family_delegate']);

const ADVISOR_TOOL_NAME = 'consult_advisor';
const MAX_ADVISOR_CONTEXT_TURNS = 8;
const MAX_TOOL_ROUNDS = 4;
const sentDailyCostNotices = new Set<string>();
const MUTATION_KIND_PATTERNS: Array<{
    kind: string;
    toolPattern: RegExp;
    claimPatterns: RegExp[];
}> = [
    {
        kind: 'create',
        toolPattern: /(?:^|_)(?:add|create|apply|attach|link|request)(?:_|$)/i,
        claimPatterns: [
            /(?:^|[^\p{L}\p{N}_])(?:я\s+)?(?:добавил(?:а|и)?|создал(?:а|и)?|применил(?:а|и)?|прикрепил(?:а|и)?)\s+(?:задач[уи]|напоминани[ея]|проект|файл|документ|артефакт|запись|тикет|заявку|ссылку|настройк[уи]|пункт\s+в\s+(?:список|задачи)|товар\s+в\s+список)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])(?:задач(?:а|и)?|напоминани(?:е|я)|проекты?|файлы?|документы?|артефакты?|записи?|тикеты?|заявки?|ссылки?)\s+(?:добавлен[аоы]?|создан[аоы]?|прикреплен[аоы]?|прикреплён[аоы]?)(?=$|[^\p{L}\p{N}_])/iu,
            /\b(?:I(?:'ve| have)?\s+)?(?:added|created|applied|attached|linked)\s+(?:the\s+|a\s+)?(?:task|reminder|project|file|document|artifact|record|ticket|request|link|setting)\b/i,
        ],
    },
    {
        kind: 'update',
        toolPattern: /(?:^|_)(?:update|set|edit|mark|complete|pause|resume|open|close|resolve|upsert|learn)(?:_|$)/i,
        claimPatterns: [
            /(?:^|[^\p{L}\p{N}_])(?:я\s+)?(?:обновил(?:а|и)?|изменил(?:а|и)?|отметил(?:а|и)?|выполнил(?:а|и)?|закрыл(?:а|и)?|поставил(?:а|и)?|перен[её]с(?:ла|ли)?)\s+(?:статус|задач[уи]|напоминани[ея]|проект|файл|документ|артефакт|запись|роль|политику|настройк[уи]|пункт|товар|встречу|дедлайн)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])(?:статусы?|задач(?:а|и)?|напоминани(?:е|я)|проекты?|файлы?|документы?|артефакты?|записи?|роли?|политики?|настройки?|пункты?|товары?|встречи?|дедлайны?)\s+(?:обновлен[аоы]?|обновлён[аоы]?|изменен[аоы]?|изменён[аоы]?|отмечен[аоы]?|выполнен[аоы]?)(?=$|[^\p{L}\p{N}_])/iu,
            /\b(?:I(?:'ve| have)?\s+)?(?:updated|changed|edited|marked|completed|closed|moved|paused|resumed)\s+(?:the\s+|a\s+)?(?:status|task|reminder|project|file|document|artifact|record|role|policy|setting|item|meeting|deadline)\b/i,
        ],
    },
    {
        kind: 'delete',
        toolPattern: /(?:^|_)(?:delete|remove|clear|cancel|detach|unlink|archive)(?:_|$)/i,
        claimPatterns: [
            /(?:^|[^\p{L}\p{N}_])(?:я\s+)?(?:удалил(?:а|и)?|очистил(?:а|и)?|отменил(?:а|и)?|архивировал(?:а|и)?)\s+(?:все\s+)?(?:задач[уи]|напоминани[ея]|проект|файл|документ|артефакт|запись|сообщени[ея]|список|пункт|товар|встречу)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])(?:задач(?:а|и)?|напоминани(?:е|я)|проекты?|файлы?|документы?|артефакты?|записи?|сообщени(?:е|я)|списки?|пункты?|товары?|встречи?)\s+(?:удален[аоы]?|удалён[аоы]?|очищен[аоы]?|отменен[аоы]?|отменён[аоы]?)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])истори[яю]\s+сообщений[^.!?\n]{0,80}\s(?:удален[аоы]?|удалён[аоы]?|очищен[аоы]?)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])(?:список\s+(?:задач|дел|напоминаний)\s+(?:теперь\s+)?пуст)(?=$|[^\p{L}\p{N}_])/iu,
            /\b(?:I(?:'ve| have)?\s+)?(?:deleted|removed|cleared|cancelled|canceled|detached|unlinked|archived)\s+(?:the\s+|a\s+)?(?:task|reminder|project|file|document|artifact|record|message|list|item|meeting)\b/i,
        ],
    },
    {
        kind: 'save',
        toolPattern: /(?:^|_)(?:remember|save|write|append|record|log)(?:_|$)/i,
        claimPatterns: [
            /(?:^|[^\p{L}\p{N}_])(?:я\s+)?(?:сохранил(?:а|и)?|записал(?:а|и)?|зафиксировал(?:а|и)?|запомнил(?:а|и)?|сохранен[оаы]?|сохранён[оаы]?|записан[оаы]?|зафиксирован[оаы]?)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])(?:я\s+)?(?:завершил(?:а|и)?\s+сбор|собрал(?:а|и)?|структурировал(?:а|и)?)\s+(?:данные|транскрипт(?:ы|ов)?|инициативы|решения|контекст)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])(?:все\s+)?(?:данные|транскрипты|инициативы|решения)\s+(?:собраны|структурированы|сохранены|зафиксированы)(?=$|[^\p{L}\p{N}_])/iu,
            /\b(?:I(?:'ve| have)?\s+)?(?:saved|wrote|written|recorded|logged|remembered)\b/i,
        ],
    },
    {
        kind: 'schedule',
        toolPattern: /(?:^|_)(?:schedule|remind|reminder|task_create|set_reminder)(?:_|$)/i,
        claimPatterns: [
            /(?:^|[^\p{L}\p{N}_])(?:я\s+)?(?:установил(?:а|и)?|запланировал(?:а|и)?|назначил(?:а|и)?)\s+(?:новое\s+)?(?:напоминание|задачу|встречу)(?=$|[^\p{L}\p{N}_])/iu,
            /(?:^|[^\p{L}\p{N}_])(?:напоминание|задача|встреча)\s+(?:успешно\s+)?(?:установлен[оа]?|создан[оа]?|запланирован[оа]?|назначен[оа]?)(?=$|[^\p{L}\p{N}_])/iu,
            /\b(?:I(?:'ve| have)?\s+)?(?:set|scheduled)\s+(?:the\s+|a\s+)?(?:reminder|task|meeting)\b/i,
        ],
    },
    {
        kind: 'send',
        toolPattern: /(?:^|_)(?:send|message|notify|call)(?:_|$)/i,
        claimPatterns: [
            /(?:^|[^\p{L}\p{N}_])(?:я\s+)?(?:отправил(?:а|и)?|послал(?:а|и)?|уведомил(?:а|и)?|позвонил(?:а|и)?|отправлен[оаы]?)(?=$|[^\p{L}\p{N}_])/iu,
            /\b(?:I(?:'ve| have)?\s+)?(?:sent|notified|called)\b/i,
        ],
    },
];
const TOOL_RESULT_FAILURE_PATTERN =
    /\b(?:error executing|no handler found|approval required|blocked|requires\b|permission|denied|not found|could not|couldn't|cannot|can't|failed|failure|unavailable|disabled|invalid|unknown|no changes?|nothing (?:was )?(?:changed|deleted|removed|updated))\b/i;
const MUTATION_REQUEST_PATTERN =
    /(?:^|[^\p{L}\p{N}_])(?:удал(?:и|ить|ил)|очист(?:и|ить|ил)|обнов(?:и|ить|ил)|созда(?:й|ть|л)|установ(?:и|ить|ил)|зафиксир(?:уй|овать|овал)|отмет(?:ь|ить|ил)|добав(?:ь|ить|ил)|сохран(?:и|ить|ил)|отправ(?:ь|ить|ил)|измен(?:и|ить|ил)|перен(?:еси|ести|ес|ёс)|закр(?:ой|ыть|ыл)|выполн(?:и|ить|ил)|напомни|поставь|запиши|delete|clear|update|create|set|record|mark|add|save|send|change|move|close|complete|schedule|cancel)(?=$|[^\p{L}\p{N}_])/iu;

let ai: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
    if (!ai) {
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }
    return ai;
}

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

const LIST_SKILLS_TOOL: FunctionDeclaration = {
    name: 'list_skills',
    description: 'List all currently loaded skills and their capabilities.',
    parameters: { type: Type.OBJECT, properties: {} },
};

const ADVISOR_TOOL: FunctionDeclaration = {
    name: ADVISOR_TOOL_NAME,
    description:
        'Ask the stronger advisor model for strategic guidance on a hard subproblem. Use sparingly and only when you are materially uncertain about the best next step.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            question: {
                type: Type.STRING,
                description: 'A focused question about the difficult part of the task.',
            },
            current_plan: {
                type: Type.STRING,
                description: 'Optional summary of your current plan, hypothesis, or intended next step.',
            },
            known_constraints: {
                type: Type.STRING,
                description: 'Optional constraints, risks, or findings that the advisor should account for.',
            },
        },
        required: ['question'],
    },
};

function trimAdvisorText(value: string | undefined, maxLength: number): string {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function serializeConversationPart(part: any): string {
    if (typeof part?.text === 'string') {
        return trimAdvisorText(part.text, 800);
    }

    if (part?.functionCall?.name) {
        return trimAdvisorText(
            `[tool_call] ${part.functionCall.name} ${JSON.stringify(part.functionCall.args || {})}`,
            800
        );
    }

    if (part?.functionResponse?.name) {
        return trimAdvisorText(
            `[tool_result] ${part.functionResponse.name}: ${part.functionResponse.response?.content || ''}`,
            1200
        );
    }

    return '';
}

function renderAdvisorConversationSnippet(conversationHistory: any[]): string {
    return conversationHistory
        .slice(-MAX_ADVISOR_CONTEXT_TURNS)
        .map((turn) => {
            const role = turn.role === 'model' ? 'ASSISTANT' : 'USER';
            const body = (turn.parts || []).map(serializeConversationPart).filter(Boolean).join('\n');
            return body ? `${role}:\n${body}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

function buildExecutorSystemInstruction(
    systemInstruction?: string,
    noToolsAvailable: boolean = false
): string | undefined {
    const advisorEnabled = PIPI_ADVISOR_ENABLED && Boolean(GEMINI_ADVISOR_MODEL?.trim());
    const parts: string[] = [];

    if (systemInstruction?.trim()) {
        parts.push(systemInstruction.trim());
    }

    parts.push(
        [
            'Execution integrity policy:',
            '- Never say or imply that you changed data, created or cancelled a reminder, updated a status, saved memory or a file, deleted anything, or sent a message unless a successful tool result in this same turn proves that exact action happened.',
            '- A plan, intention, recommendation, or remembered conversation is not execution. Clearly distinguish proposed work from completed work.',
            '- If the required tool was unavailable, blocked, failed, or was not called, say briefly that the action was not completed. Never manufacture a success receipt.',
        ].join('\n')
    );

    if (noToolsAvailable) {
        parts.push(
            [
                'Tool availability for this turn:',
                '- No functions or tools are available in this turn. Do not attempt a function call.',
                '- You may still answer, draft, reason, or propose a plan. If the user asks for an external action, state briefly that it was not completed.',
            ].join('\n')
        );
    }

    if (advisorEnabled) {
        parts.push(
            [
                'Internal execution policy:',
                `- You are the executor model. Do the work yourself by default.`,
                `- If you hit a genuinely difficult ambiguity, conflicting evidence, or a high-stakes planning fork, you may call "${ADVISOR_TOOL_NAME}" for strategy.`,
                `- Keep advisor questions focused and concrete, and use the advisor at most ${PIPI_ADVISOR_MAX_CALLS_PER_TURN} time(s) for this user turn.`,
                '- Do not use the advisor for routine drafting, simple lookups, or cosmetic rewrites.',
                '- After receiving advisor guidance, continue the task yourself and give the final answer in your own voice.',
            ].join('\n')
        );
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function inferMutationKinds(toolName: string, toolArgs?: any): Set<string> {
    const operation = typeof toolArgs?.operation === 'string' ? toolArgs.operation : '';
    const action = typeof toolArgs?.action === 'string' ? toolArgs.action : '';
    const subject = `${toolName} ${operation} ${action}`.trim();
    const kinds = new Set<string>();

    for (const candidate of MUTATION_KIND_PATTERNS) {
        if (candidate.toolPattern.test(subject)) {
            kinds.add(candidate.kind);
        }
    }

    return kinds;
}

function isSuccessfulMutationResult(result: string): boolean {
    const normalized = result.replace(/\s+/g, ' ').trim();
    if (!normalized || TOOL_RESULT_FAILURE_PATTERN.test(normalized)) return false;
    if (/\b(?:cleared|updated|removed|deleted|cancelled|canceled)\s+0\b/i.test(normalized)) return false;
    return true;
}

function findClaimedMutationKinds(text: string): Set<string> {
    const kinds = new Set<string>();

    for (const candidate of MUTATION_KIND_PATTERNS) {
        if (candidate.claimPatterns.some((pattern) => pattern.test(text))) {
            kinds.add(candidate.kind);
        }
    }

    return kinds;
}

function truthfulNonExecutionMessage(latestUserMessage: string): string {
    if (/[а-яё]/i.test(latestUserMessage)) {
        return 'Не выполнил: в этом ходе не было успешного инструмента, изменяющего данные.';
    }
    return 'Not completed: no data-changing tool succeeded in this turn.';
}

function enforceExecutionIntegrity(
    draft: string,
    latestUserMessage: string,
    successfulMutationKinds: Set<string>
): { text: string; guarded: boolean; removedSections: number } {
    const sections = draft.split(/(\n{2,})/);
    let removedSections = 0;

    const kept = sections.filter((section) => {
        if (/^\n{2,}$/.test(section)) return true;
        const claimedKinds = findClaimedMutationKinds(section);
        if (claimedKinds.size === 0) return true;

        const unsupported = [...claimedKinds].some((kind) => !successfulMutationKinds.has(kind));
        if (unsupported) {
            removedSections += 1;
            return false;
        }
        return true;
    });

    if (removedSections === 0) {
        return { text: draft, guarded: false, removedSections: 0 };
    }

    const sanitized = kept
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const requestedMutation = MUTATION_REQUEST_PATTERN.test(latestUserMessage);
    const notice = truthfulNonExecutionMessage(latestUserMessage);
    const text = requestedMutation ? [sanitized, notice].filter(Boolean).join('\n\n') : sanitized || notice;

    return { text, guarded: true, removedSections };
}

async function handleMetaTool(
    callName: string,
    args: any,
    context?: RuntimeExecutionContext,
    handlers?: Record<string, (args: any, context?: RuntimeExecutionContext) => Promise<string>>
): Promise<string | null> {
    if (callName === 'list_skills') {
        const { getRegisteredCapabilitiesForContext } = await import('../skills/_registry');
        const skills = getRegisteredCapabilitiesForContext(context);
        return skills.map((s: any) => `${s.skill}: ${s.description} (${s.tools.length} tools)`).join('\n');
    }
    if (callName === 'request_new_skill' || callName === 'clear_skill_requests') {
        const { getRegisteredHandlersForContext } = await import('../skills/_registry');
        const handlers = getRegisteredHandlersForContext(context);
        if (callName === 'request_new_skill' && handlers.atelier_request_capability) {
            return await handlers.atelier_request_capability(
                {
                    capability_gap: args.capability_gap || args.skill_name,
                    skill_name: args.skill_name,
                    user_title: args.user_title,
                    description: args.description,
                    user_request: args.user_request,
                    hardware_needed: args.hardware_needed,
                },
                context
            );
        }
        if (callName === 'clear_skill_requests' && handlers.atelier_clear_requests) {
            return await handlers.atelier_clear_requests({}, context);
        }
    }

    if (handlers) {
        const coreResult = await handleCoreToolboxTool(callName, args, context, handlers);
        if (coreResult !== null) {
            return coreResult;
        }
    }

    return null;
}

function tryOfflineFallback(_text: string): string | null {
    return null;
}

async function sendContextProgressSignal(context: RuntimeExecutionContext): Promise<void> {
    const runtime = await import('../channels/runtime');
    await runtime.sendContextTyping(context);
}

async function notifyDailyCost(text: string): Promise<void> {
    const runtime = await import('../channels/runtime');
    await runtime.notifyPrimaryHousehold(text);
}

function claimDailyCostNotice(tier: 'near_limit' | 'over_limit'): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}:${tier}`;
    if (sentDailyCostNotices.has(key)) return false;
    sentDailyCostNotices.add(key);

    for (const existing of sentDailyCostNotices) {
        if (!existing.startsWith(`${day}:`)) sentDailyCostNotices.delete(existing);
    }
    return true;
}

export async function processWithLLM(
    messages: LLMMessage[],
    context: RuntimeExecutionContext
): Promise<{ text: string }> {
    const latestUserMessage = messages.filter((message) => message.role === 'user').pop()?.content || '';
    return await withSpan(
        'llm.process',
        {
            attributes: {
                user_id: context.userId,
                space_id: context.spaceId,
                channel: context.channel,
                channel_ref: context.channelRef || context.chatId,
                task_id: context.taskId,
                message_count: messages.length,
                ...summarizeText(latestUserMessage),
            },
        },
        async () => {
            const startedMs = Date.now();
            let finalProvider = 'gemini';
            let finalModel = GEMINI_EXECUTOR_MODEL;
            let finalStatus = 'ok';

            try {
                logInfo('LLM', 'request_started', {
                    message_count: messages.length,
                    ...summarizeText(latestUserMessage),
                });

                const blocked = guardLLMCall();
                if (blocked) {
                    finalProvider = 'guard';
                    finalStatus = 'blocked';
                    addSpanAttributes({ 'app.llm.blocked': true, 'app.llm.block_reason': blocked });
                    logWarn('LLM', 'blocked_by_guard', { reason: blocked });
                    const offline = tryOfflineFallback(latestUserMessage);
                    if (offline) return { text: offline };
                    return { text: `LLM сейчас недоступен: ${blocked}` };
                }

                const originalSystemInstruction = messages.find((m) => m.role === 'system')?.content;
                const noToolsAvailable = Array.isArray(context.allowedTools) && context.allowedTools.length === 0;
                const systemInstruction = buildExecutorSystemInstruction(originalSystemInstruction, noToolsAvailable);
                const advisorEnabled = PIPI_ADVISOR_ENABLED && Boolean(GEMINI_ADVISOR_MODEL?.trim());
                addSpanAttributes({
                    'app.llm.executor_model': GEMINI_EXECUTOR_MODEL,
                    'app.llm.advisor_enabled': advisorEnabled,
                    'app.llm.advisor_model': advisorEnabled ? GEMINI_ADVISOR_MODEL : 'disabled',
                });

                const rawHistory = messages
                    .filter((m) => m.role !== 'system')
                    .map((m) => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: m.content }],
                    }));

                const conversationHistory: any[] = [];
                for (const msg of rawHistory) {
                    const last = conversationHistory[conversationHistory.length - 1];
                    if (last && last.role === msg.role) {
                        last.parts.push({ text: msg.parts[0].text });
                    } else {
                        conversationHistory.push({ role: msg.role, parts: [...msg.parts] });
                    }
                }

                if (conversationHistory.length === 0) {
                    conversationHistory.push({ role: 'user', parts: [{ text: 'Start.' }] });
                }

                const { getRegisteredToolsForContext, getRegisteredHandlersForContext } =
                    await import('../skills/_registry');
                const registeredSkillTools = getRegisteredToolsForContext(context);
                const hasExplicitToolAllowlist = Array.isArray(context.allowedTools);
                const skillTools = hasExplicitToolAllowlist
                    ? registeredSkillTools
                    : registeredSkillTools.filter((tool) => !isCorePrimitiveBackingTool(tool.name));
                const defaultTools = advisorEnabled
                    ? [...CORE_TOOLBOX_TOOL_DECLARATIONS, LIST_SKILLS_TOOL, ADVISOR_TOOL]
                    : [...CORE_TOOLBOX_TOOL_DECLARATIONS, LIST_SKILLS_TOOL];
                const additionalTools = hasExplicitToolAllowlist
                    ? defaultTools.filter((tool) => !!tool.name && context.allowedTools!.includes(tool.name))
                    : defaultTools;
                const allTools = [...skillTools, ...additionalTools];
                addSpanAttributes({ 'app.llm.tool_declarations': allTools.length });
                addSpanAttributes({
                    'app.llm.backing_tool_declarations_hidden': registeredSkillTools.length - skillTools.length,
                });

                const trackTokens = (model: string, resp: any) => {
                    const inputTokens = resp?.usageMetadata?.promptTokenCount || 0;
                    const outputTokens = resp?.usageMetadata?.candidatesTokenCount || 0;
                    if (inputTokens > 0 || outputTokens > 0) {
                        // Attributed to the space whose turn this is, so the
                        // dashboard can say which conversation costs money.
                        // Undefined for work that belongs to no conversation.
                        logTokenUsage(model, inputTokens, outputTokens, context.spaceId);
                    }
                };

                const isGemini3Executor = /^gemini-3(?:[.-]|$)/i.test(GEMINI_EXECUTOR_MODEL);
                const isDeepInitiativeTurn =
                    /(?:^|[:_-])daily_initiative(?:$|[:_-])/i.test(context.taskId || '') ||
                    (context.taskId || '').startsWith('system:atelier-self-review:');
                const baseConfig: any = {
                    systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
                    tools: allTools.length > 0 ? [{ functionDeclarations: allTools }] : undefined,
                    temperature: isDeepInitiativeTurn ? 0.4 : 0.3,
                    thinkingConfig: isGemini3Executor
                        ? { thinkingLevel: isDeepInitiativeTurn ? 'high' : 'minimal' }
                        : undefined,
                };

                const generateGemini = async (args: {
                    modelToUse: string;
                    contents: any[];
                    config: any;
                    mode: 'executor' | 'advisor';
                }) => {
                    return await withSpan(
                        'llm.gemini.generate_content',
                        {
                            kind: SpanKind.CLIENT,
                            attributes: {
                                provider: 'gemini',
                                model: args.modelToUse,
                                mode: args.mode,
                                history_turns: args.contents.length,
                                has_tools: Boolean(args.config?.tools),
                            },
                        },
                        async () => {
                            const requestPromise = getGeminiClient().models.generateContent({
                                model: args.modelToUse,
                                contents: args.contents,
                                config: args.config,
                            });

                            let timeoutId: ReturnType<typeof setTimeout>;
                            const timeoutPromise = new Promise((_, reject) => {
                                timeoutId = setTimeout(
                                    () => reject(new Error(`[TIMEOUT] ${args.modelToUse} did not respond within 45s`)),
                                    45000
                                );
                            });

                            const candidate: any = await Promise.race([requestPromise, timeoutPromise]);
                            clearTimeout(timeoutId!);
                            requestPromise.catch(() => {}); // suppress orphaned rejection if timeout won the race
                            addSpanAttributes({
                                'app.llm.finish_reason': candidate?.candidates?.[0]?.finishReason || 'N/A',
                                'app.llm.tool_calls': candidate?.functionCalls?.length || 0,
                                'app.llm.has_text': Boolean(candidate?.text),
                            });
                            return candidate;
                        }
                    );
                };

                const callGemini = async (modelToUse: string, contents: any[], extraConfig?: any) => {
                    const mergedConfig = extraConfig ? { ...baseConfig, ...extraConfig } : baseConfig;
                    return await generateGemini({
                        modelToUse,
                        contents,
                        config: mergedConfig,
                        mode: 'executor',
                    });
                };

                const attempts = [
                    { model: GEMINI_EXECUTOR_MODEL, label: GEMINI_EXECUTOR_MODEL },
                    {
                        model: GEMINI_EXECUTOR_MODEL,
                        label: `${GEMINI_EXECUTOR_MODEL}-nothink`,
                        extra: {
                            thinkingConfig: isGemini3Executor ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 },
                        },
                    },
                ];

                let response: any = null;
                let lastError: any = null;
                let usedModel = attempts[0].model;

                const isEmptyResponse = (resp: any): boolean => {
                    if (!resp) return true;
                    try {
                        const hasText = !!resp.text;
                        const hasTools = resp.functionCalls && resp.functionCalls.length > 0;
                        if (!hasText && !hasTools) {
                            const parts = resp.candidates?.[0]?.content?.parts;
                            logInfo('LLM', 'empty_response_parts', {
                                part_count: Array.isArray(parts) ? parts.length : 0,
                            });
                            return true;
                        }
                        return false;
                    } catch {
                        return true;
                    }
                };

                for (const att of attempts) {
                    try {
                        const candidate: any = await callGemini(att.model, conversationHistory, att.extra);

                        if (isEmptyResponse(candidate)) {
                            logWarn('LLM', 'empty_response', {
                                model: att.label,
                                finish_reason: candidate?.candidates?.[0]?.finishReason || 'N/A',
                            });
                            continue;
                        }

                        response = candidate;
                        usedModel = att.model;
                        finalModel = att.model;
                        addSpanAttributes({ 'app.llm.provider': 'gemini', 'app.llm.model': att.model });
                        logInfo('LLM', 'response_received', {
                            model: att.label,
                            has_text: Boolean(candidate?.text),
                            tool_calls: candidate?.functionCalls?.length || 0,
                            finish_reason: candidate?.candidates?.[0]?.finishReason || 'N/A',
                        });
                        break;
                    } catch (err: any) {
                        lastError = err;
                        const isRateLimit = err.status === 429 || err.message?.includes('429');

                        if (isRateLimit) {
                            const delay = 2000 + Math.random() * 1000;
                            addSpanEvent('llm.rate_limited', {
                                model: att.label,
                                retry_delay_ms: Math.round(delay),
                            });
                            logWarn('LLM', 'rate_limited', {
                                model: att.label,
                                retry_delay_ms: Math.round(delay),
                            });
                            await new Promise((r) => setTimeout(r, delay));
                        }

                        logWarn('LLM', 'attempt_failed', {
                            model: att.label,
                            ...summarizeError(err),
                        });
                    }
                }

                if (!response) {
                    logError('LLM', 'all_gemini_attempts_exhausted', summarizeError(lastError));
                    reportGeminiResult(false);

                    if (isOllamaHealthy()) {
                        try {
                            finalProvider = 'ollama';
                            finalModel = OLLAMA_MODEL;
                            logInfo('LLM', 'ollama_fallback_start', { model: OLLAMA_MODEL });
                            const ollamaPrompt = [
                                systemInstruction || '',
                                ...messages
                                    .filter((m) => m.role !== 'system')
                                    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`),
                            ].join('\n');

                            const controller = new AbortController();
                            const timeout = setTimeout(() => controller.abort(), 30000);

                            const ollamaRes = await withSpan(
                                'llm.ollama.generate',
                                {
                                    kind: SpanKind.CLIENT,
                                    attributes: {
                                        provider: 'ollama',
                                        model: OLLAMA_MODEL,
                                    },
                                },
                                async () => {
                                    return await fetch(`${OLLAMA_URL}/api/generate`, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            model: OLLAMA_MODEL,
                                            prompt: ollamaPrompt,
                                            stream: false,
                                        }),
                                        signal: controller.signal,
                                    });
                                }
                            );
                            clearTimeout(timeout);

                            if (ollamaRes.ok) {
                                const ollamaData = await ollamaRes.json();
                                const ollamaText = ollamaData.response?.trim();
                                if (ollamaText) {
                                    addSpanAttributes({ 'app.llm.provider': 'ollama', 'app.llm.model': OLLAMA_MODEL });
                                    logInfo('LLM', 'ollama_fallback_complete', summarizeText(ollamaText));
                                    logTokenUsage(
                                        OLLAMA_MODEL,
                                        ollamaData.prompt_eval_count || 0,
                                        ollamaData.eval_count || 0,
                                        context.spaceId
                                    );
                                    return { text: ollamaText };
                                }
                            }
                            logWarn('LLM', 'ollama_fallback_empty', { status: ollamaRes.status });
                        } catch (ollamaErr: any) {
                            logError('LLM', 'ollama_fallback_failed', summarizeError(ollamaErr));
                        }
                    }

                    finalStatus = 'upstream_unavailable';
                    finalProvider = finalProvider === 'ollama' ? 'ollama' : 'gemini';
                    const offline = tryOfflineFallback(latestUserMessage);
                    if (offline) return { text: offline };
                    reportOperationalFailure('llm', lastError?.message || 'all Gemini attempts exhausted');
                    return {
                        text: 'Сейчас не удалось получить ответ от модели. Проверь Gemini/Ollama и попробуй ещё раз.',
                    };
                }

                reportGeminiResult(true);
                reportOperationalRecovery('llm');
                logInfo('LLM', 'gemini_response_ready', {
                    has_text: Boolean(response?.text),
                    tool_calls: response?.functionCalls?.length || 0,
                    finish_reason: response?.candidates?.[0]?.finishReason || 'N/A',
                });

                trackTokens(usedModel, response);

                const handlers = getRegisteredHandlersForContext(context);
                let advisorCalls = 0;

                const consultAdvisor = async (args: any): Promise<string> => {
                    if (!advisorEnabled) {
                        return '[ADVISOR_NOTE] Advisor strategy is disabled for this runtime. Continue with your own reasoning.';
                    }

                    if (advisorCalls >= PIPI_ADVISOR_MAX_CALLS_PER_TURN) {
                        return '[ADVISOR_NOTE] Advisor budget for this turn is already used. Continue without another consultation.';
                    }

                    const question = trimAdvisorText(typeof args?.question === 'string' ? args.question : '', 1200);
                    if (!question) {
                        return '[ADVISOR_NOTE] Advisor needs a focused question. Continue with your own best plan.';
                    }

                    advisorCalls += 1;
                    const advisorStartedMs = Date.now();
                    let advisorStatus = 'ok';
                    const currentPlan = trimAdvisorText(
                        typeof args?.current_plan === 'string' ? args.current_plan : '',
                        1200
                    );
                    const knownConstraints = trimAdvisorText(
                        typeof args?.known_constraints === 'string' ? args.known_constraints : '',
                        1200
                    );
                    const recentConversation = renderAdvisorConversationSnippet(conversationHistory);

                    addSpanEvent('llm.advisor_consult_start', {
                        advisor_call: advisorCalls,
                        advisor_model: GEMINI_ADVISOR_MODEL,
                    });
                    logInfo('LLM', 'advisor_consult_start', {
                        advisor_call: advisorCalls,
                        advisor_model: GEMINI_ADVISOR_MODEL,
                        ...summarizeText(question),
                    });

                    const advisorPrompt = [
                        'The executor model is requesting strategic guidance for a difficult moment.',
                        `Latest user request:\n${trimAdvisorText(latestUserMessage, 1600) || 'N/A'}`,
                        originalSystemInstruction
                            ? `Relevant system instructions:\n${trimAdvisorText(originalSystemInstruction, 1800)}`
                            : '',
                        currentPlan ? `Executor plan so far:\n${currentPlan}` : '',
                        knownConstraints ? `Constraints and findings:\n${knownConstraints}` : '',
                        recentConversation ? `Recent conversation:\n${recentConversation}` : '',
                        `Focused question:\n${question}`,
                    ]
                        .filter(Boolean)
                        .join('\n\n');

                    try {
                        const advisorResponse: any = await generateGemini({
                            modelToUse: GEMINI_ADVISOR_MODEL,
                            contents: [{ role: 'user', parts: [{ text: advisorPrompt }] }],
                            config: {
                                systemInstruction: {
                                    parts: [
                                        {
                                            text: 'You are the internal advisor for another model. Give concise strategic guidance only. Do not address the end user, do not call tools, and do not solve the whole task end-to-end. Reply with three short sections: Assessment, Recommended next step, Watch-outs.',
                                        },
                                    ],
                                },
                                temperature: 0.2,
                            },
                            mode: 'advisor',
                        });

                        trackTokens(GEMINI_ADVISOR_MODEL, advisorResponse);
                        const advisorText = trimAdvisorText(advisorResponse?.text, 2400);

                        if (!advisorText) {
                            advisorStatus = 'empty';
                            logWarn('LLM', 'advisor_consult_empty', { advisor_model: GEMINI_ADVISOR_MODEL });
                            return '[ADVISOR_NOTE] Advisor returned no guidance. Continue with your own reasoning.';
                        }

                        addSpanEvent('llm.advisor_consult_complete', {
                            advisor_call: advisorCalls,
                            advisor_model: GEMINI_ADVISOR_MODEL,
                            ...summarizeText(advisorText),
                        });
                        logInfo('LLM', 'advisor_consult_complete', {
                            advisor_call: advisorCalls,
                            advisor_model: GEMINI_ADVISOR_MODEL,
                            ...summarizeText(advisorText),
                        });
                        return advisorText;
                    } catch (err: any) {
                        advisorStatus = 'error';
                        addSpanEvent('llm.advisor_consult_failed', {
                            advisor_call: advisorCalls,
                            advisor_model: GEMINI_ADVISOR_MODEL,
                            ...summarizeError(err),
                        });
                        logWarn('LLM', 'advisor_consult_failed', {
                            advisor_call: advisorCalls,
                            advisor_model: GEMINI_ADVISOR_MODEL,
                            ...summarizeError(err),
                        });
                        return '[ADVISOR_NOTE] Advisor was unavailable. Continue with your own reasoning and available tools.';
                    } finally {
                        recordLlmRequest(Date.now() - advisorStartedMs, {
                            provider: 'gemini',
                            model: GEMINI_ADVISOR_MODEL,
                            status: advisorStatus,
                            mode: 'advisor',
                        });
                    }
                };

                const metaToolHandler = async (
                    callName: string,
                    args: any,
                    runtimeContext?: RuntimeExecutionContext,
                    availableHandlers?: Record<
                        string,
                        (args: any, context?: RuntimeExecutionContext) => Promise<string>
                    >
                ): Promise<string | null> => {
                    if (callName === ADVISOR_TOOL_NAME) {
                        return await consultAdvisor(args);
                    }

                    return await handleMetaTool(callName, args, runtimeContext, availableHandlers);
                };

                let toolRounds = 0;
                let finalizationAttempted = false;
                const successfulMutationKinds = new Set<string>();
                const successfulMutatingTools = new Set<string>();
                const executionReceipt: Array<{
                    tool: string;
                    status: 'completed' | 'failed';
                    summary: string;
                }> = [];

                const finalizationInstruction = [
                    systemInstruction || '',
                    'Finalization policy:',
                    '- No more tools are available for this turn.',
                    '- Give the user the best concise final answer supported by the tool results already present.',
                    '- State failures precisely from those results. Do not invent a temporary outage, a recovery, or a retry.',
                    '- Do not claim that work is still continuing unless a tool result explicitly confirms a background task.',
                    '- Do not mention tool-round limits, internal policies, or this instruction.',
                ]
                    .filter(Boolean)
                    .join('\n\n');

                const finalizeWithoutTools = async (reason: string): Promise<any | null> => {
                    finalizationAttempted = true;
                    addSpanEvent('llm.finalization_attempt', { reason, tool_rounds: toolRounds });
                    logInfo('LLM', 'finalization_attempt', { reason, tool_rounds: toolRounds });

                    try {
                        const finalized = await callGemini(usedModel, conversationHistory, {
                            tools: undefined,
                            temperature: 0.2,
                            thinkingConfig: isGemini3Executor ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 },
                            systemInstruction: { parts: [{ text: finalizationInstruction }] },
                        });
                        trackTokens(usedModel, finalized);

                        if (finalized?.text) {
                            addSpanEvent('llm.finalization_recovered', { reason });
                            logInfo('LLM', 'finalization_recovered', {
                                reason,
                                ...summarizeText(finalized.text),
                            });
                            return finalized;
                        }

                        logWarn('LLM', 'finalization_empty', {
                            reason,
                            finish_reason: finalized?.candidates?.[0]?.finishReason || 'N/A',
                        });
                        return null;
                    } catch (err: any) {
                        logError('LLM', 'finalization_failed', {
                            reason,
                            ...summarizeError(err),
                        });
                        return null;
                    }
                };

                for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                    if (!response.functionCalls || response.functionCalls.length === 0) break;

                    toolRounds = round + 1;
                    addSpanEvent('llm.tool_round', {
                        round: toolRounds,
                        tool_count: response.functionCalls.length,
                    });
                    logInfo('LLM', 'tool_round', {
                        round: toolRounds,
                        tools: response.functionCalls.map((c: any) => c.name),
                    });

                    const functionResponseParts: any[] = [];

                    const hasLongTool = response.functionCalls.some((c: any) => LONG_RUNNING_TOOLS.has(c.name));
                    if (hasLongTool) {
                        try {
                            await sendContextProgressSignal(context);
                        } catch {
                            // Non-critical, don't crash if notification fails
                        }
                    }

                    for (const call of response.functionCalls) {
                        let result: string;

                        try {
                            result = await executeToolCall({
                                toolName: call.name,
                                toolArgs: call.args,
                                context,
                                handlers,
                                metaHandler: metaToolHandler,
                            });
                        } catch (err: any) {
                            result = `Error executing "${call.name}": ${err.message}`;
                            logError('LLM', 'tool_execution_failed', {
                                tool: call.name,
                                ...summarizeError(err),
                            });
                        }

                        const mutationKinds = inferMutationKinds(call.name, call.args);
                        if (mutationKinds.size > 0 && isSuccessfulMutationResult(result)) {
                            successfulMutatingTools.add(call.name);
                            for (const kind of mutationKinds) {
                                successfulMutationKinds.add(kind);
                            }
                        }

                        const normalizedResult = result.replace(/\s+/g, ' ').trim();
                        const toolSucceeded = isSuccessfulMutationResult(result);
                        executionReceipt.push({
                            tool: call.name,
                            status: toolSucceeded ? 'completed' : 'failed',
                            summary: toolSucceeded ? 'Completed successfully.' : normalizedResult.slice(0, 280),
                        });

                        functionResponseParts.push({
                            functionResponse: {
                                name: call.name,
                                response: { content: result },
                            },
                        });
                    }

                    const rawModelParts = response.candidates?.[0]?.content?.parts;
                    conversationHistory.push({
                        role: 'model',
                        // Gemini 3 attaches a thought_signature to function-call
                        // parts and requires that exact part on the follow-up
                        // request. Rebuilding only {name,args} silently drops it
                        // and makes every multi-round tool call fail with 400.
                        parts:
                            Array.isArray(rawModelParts) && rawModelParts.some((part: any) => part?.functionCall)
                                ? rawModelParts
                                : response.functionCalls.map((c: any) => ({
                                      functionCall: { name: c.name, args: c.args },
                                  })),
                    });

                    conversationHistory.push({
                        role: 'user',
                        parts: functionResponseParts,
                    });

                    try {
                        if (toolRounds === MAX_TOOL_ROUNDS) {
                            response = await finalizeWithoutTools('tool_budget_exhausted');
                        } else {
                            response = await callGemini(usedModel, conversationHistory);
                            trackTokens(usedModel, response);
                            if (
                                response &&
                                !response.text &&
                                (!response.functionCalls || response.functionCalls.length === 0)
                            ) {
                                response = await finalizeWithoutTools('empty_follow_up');
                            }
                        }
                    } catch (err: any) {
                        finalStatus = 'follow_up_failed';
                        logError('LLM', 'follow_up_call_failed', summarizeError(err));
                        response = await finalizeWithoutTools('follow_up_failed');
                    }

                    if (!response) {
                        break;
                    }
                }

                if (!response?.text && !finalizationAttempted) {
                    response = await finalizeWithoutTools(
                        response?.functionCalls?.length ? 'tool_budget_exhausted' : 'empty_follow_up'
                    );
                }

                addSpanAttributes({
                    'app.llm.tool_rounds': toolRounds,
                    'app.llm.advisor_calls': advisorCalls,
                    'app.llm.finalization_attempted': finalizationAttempted,
                });
                const draftResponse = response?.text || '';
                const guardedResponse = enforceExecutionIntegrity(
                    draftResponse,
                    latestUserMessage,
                    successfulMutationKinds
                );
                addSpanAttributes({
                    'app.llm.action_claim_guarded': guardedResponse.guarded,
                    'app.llm.action_claim_sections_removed': guardedResponse.removedSections,
                    'app.llm.successful_mutating_tools': successfulMutatingTools.size,
                });
                if (guardedResponse.guarded) {
                    logWarn('LLM', 'unsupported_action_claim_removed', {
                        removed_sections: guardedResponse.removedSections,
                        successful_mutating_tools: [...successfulMutatingTools],
                    });
                }
                const textResponse = guardedResponse.text;

                if (!textResponse) {
                    finalStatus = 'finalization_failed';
                    logEvent('llm_turn_failed', {
                        space_id: context.spaceId || null,
                        turn_id: context.turnId || context.taskId || null,
                        reason: finalizationAttempted ? 'finalization_failed' : 'empty_response',
                        tool_rounds: toolRounds,
                        tools: executionReceipt,
                    });
                    reportOperationalFailure('llm', 'finalization produced no user-facing text');
                    logWarn('LLM', 'reply_suppressed_after_finalization_failure', {
                        turn_id: context.turnId || context.taskId || null,
                        tool_rounds: toolRounds,
                        tool_count: executionReceipt.length,
                    });
                }

                const dailyCost = getDailyTokenCost();
                const isInternalTurn = context.userId.startsWith('system_');
                if (
                    !isInternalTurn &&
                    dailyCost.cost_usd >= 1.8 &&
                    dailyCost.cost_usd < 2.0 &&
                    claimDailyCostNotice('near_limit')
                ) {
                    setTimeout(() => {
                        void notifyDailyCost(
                            `Кстати, сегодня уже $${dailyCost.cost_usd.toFixed(2)} потратил на разговоры. Если так пойдёт, дойдём до $2 — буду вынужден намекнуть на экономию.`
                        );
                    }, 2000);
                } else if (!isInternalTurn && dailyCost.cost_usd >= 2.0 && claimDailyCostNotice('over_limit')) {
                    setTimeout(() => {
                        void notifyDailyCost(
                            `Всё, господа. $2 потрачено. Больше не разговариваю сегодня. Шучу. Но если серьёзно — может стоит притормозить?`
                        );
                    }, 2000);
                }

                return { text: textResponse };
            } catch (error: any) {
                finalStatus = 'runtime_error';
                recordActiveSpanException(error);
                logError('LLM', 'gemini_runtime_error', summarizeError(error));
                reportOperationalFailure('llm', error.message || 'unknown Gemini error');
                return {
                    text: 'Произошла ошибка при обработке запроса. Подробности записаны в лог; попробуй ещё раз через минуту.',
                };
            } finally {
                recordLlmRequest(Date.now() - startedMs, {
                    provider: finalProvider,
                    model: finalModel,
                    status: finalStatus,
                });
            }
        }
    );
}

export async function processWithVision(
    systemPrompt: string,
    userPrompt: string,
    base64Image: string,
    mimeType: string = 'image/jpeg'
): Promise<{ text: string }> {
    return await withSpan(
        'llm.vision.process',
        {
            attributes: {
                provider: 'gemini',
                model: 'gemini-2.5-flash',
                mime_type: mimeType,
                prompt_chars: userPrompt.length,
                image_base64_chars: base64Image.length,
            },
        },
        async () => {
            const startedMs = Date.now();
            let status = 'ok';

            try {
                logEvent('tool_call', { tool: 'vision_analyze', ok: true });

                const response = await withSpan(
                    'llm.vision.generate_content',
                    {
                        kind: SpanKind.CLIENT,
                        attributes: {
                            provider: 'gemini',
                            model: 'gemini-2.5-flash',
                            mime_type: mimeType,
                        },
                    },
                    async () => {
                        return await getGeminiClient().models.generateContent({
                            model: 'gemini-2.5-flash',
                            contents: [
                                {
                                    role: 'user',
                                    parts: [{ inlineData: { data: base64Image, mimeType } }, { text: userPrompt }],
                                },
                            ],
                            config: {
                                systemInstruction: { parts: [{ text: systemPrompt }] },
                                temperature: 0.7,
                            },
                        });
                    }
                );

                reportOperationalRecovery('vision');
                return { text: response.text || 'Не удалось извлечь осмысленный ответ из изображения.' };
            } catch (error: any) {
                status = 'error';
                recordActiveSpanException(error);
                logError('VISION', 'analysis_failed', summarizeError(error));
                logEvent('tool_call', { tool: 'vision_analyze', ok: false, error: error.message });
                reportOperationalFailure('vision', error.message);
                return { text: 'Не удалось обработать изображение. Попробуй ещё раз чуть позже.' };
            } finally {
                recordLlmRequest(Date.now() - startedMs, {
                    provider: 'gemini',
                    model: 'gemini-2.5-flash',
                    status,
                    mode: 'vision',
                });
            }
        }
    );
}
