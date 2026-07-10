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
const LONG_RUNNING_TOOLS = new Set(['groceries_search', 'browse_web', 'webrun_execute', 'web']);

const LONG_TASK_MESSAGES = [
    '🔍 Looking into it now...',
    '⏳ Working on that...',
    '🔎 Gathering the relevant details...',
    '⚙️ Handling the request...',
];
const ADVISOR_TOOL_NAME = 'consult_advisor';
const MAX_ADVISOR_CONTEXT_TURNS = 8;

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

function buildExecutorSystemInstruction(systemInstruction?: string): string | undefined {
    const advisorEnabled = PIPI_ADVISOR_ENABLED && Boolean(GEMINI_ADVISOR_MODEL?.trim());
    const parts: string[] = [];

    if (systemInstruction?.trim()) {
        parts.push(systemInstruction.trim());
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

async function sendContextProgressMessage(context: RuntimeExecutionContext, text: string): Promise<void> {
    const runtime = await import('../channels/runtime');
    await runtime.sendContextTyping(context);
    await runtime.sendContextMessage(context, text);
}

async function notifyDailyCost(text: string): Promise<void> {
    const runtime = await import('../channels/runtime');
    await runtime.notifyPrimaryHousehold(text);
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
                const systemInstruction = buildExecutorSystemInstruction(originalSystemInstruction);
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
                const skillTools = registeredSkillTools.filter((tool) => !isCorePrimitiveBackingTool(tool.name));
                const allTools = advisorEnabled
                    ? [...skillTools, ...CORE_TOOLBOX_TOOL_DECLARATIONS, LIST_SKILLS_TOOL, ADVISOR_TOOL]
                    : [...skillTools, ...CORE_TOOLBOX_TOOL_DECLARATIONS, LIST_SKILLS_TOOL];
                addSpanAttributes({ 'app.llm.tool_declarations': allTools.length });
                addSpanAttributes({
                    'app.llm.backing_tool_declarations_hidden': registeredSkillTools.length - skillTools.length,
                });

                const trackTokens = (model: string, resp: any) => {
                    const inputTokens = resp?.usageMetadata?.promptTokenCount || 0;
                    const outputTokens = resp?.usageMetadata?.candidatesTokenCount || 0;
                    if (inputTokens > 0 || outputTokens > 0) {
                        logTokenUsage(model, inputTokens, outputTokens);
                    }
                };

                const baseConfig: any = {
                    systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
                    tools: [{ functionDeclarations: allTools }],
                    temperature: 0.7,
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
                        extra: { thinkingConfig: { thinkingBudget: 0 } },
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
                                        ollamaData.eval_count || 0
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

                const MAX_TOOL_ROUNDS = 3;
                let toolRounds = 0;

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
                        const msg = LONG_TASK_MESSAGES[Math.floor(Math.random() * LONG_TASK_MESSAGES.length)];
                        try {
                            await sendContextProgressMessage(context, msg);
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

                        functionResponseParts.push({
                            functionResponse: {
                                name: call.name,
                                response: { content: result },
                            },
                        });
                    }

                    conversationHistory.push({
                        role: 'model',
                        parts: response.functionCalls.map((c: any) => ({
                            functionCall: { name: c.name, args: c.args },
                        })),
                    });

                    conversationHistory.push({
                        role: 'user',
                        parts: functionResponseParts,
                    });

                    try {
                        response = await callGemini(usedModel, conversationHistory);
                        trackTokens(usedModel, response);
                    } catch (err: any) {
                        finalStatus = 'follow_up_failed';
                        logError('LLM', 'follow_up_call_failed', summarizeError(err));
                        const fallbackText = functionResponseParts
                            .map((p) => p.functionResponse.response.content)
                            .join('\n');
                        return { text: fallbackText };
                    }
                }

                addSpanAttributes({ 'app.llm.tool_rounds': toolRounds, 'app.llm.advisor_calls': advisorCalls });
                const textResponse =
                    response.text ||
                    'Модель завершила работу без финального текста. Попробуй переформулировать запрос.';

                const dailyCost = getDailyTokenCost();
                if (dailyCost.cost_usd >= 1.8 && dailyCost.cost_usd < 2.0) {
                    setTimeout(() => {
                        void notifyDailyCost(
                            `Кстати, сегодня уже $${dailyCost.cost_usd.toFixed(2)} потратил на разговоры. Если так пойдёт, дойдём до $2 — буду вынужден намекнуть на экономию.`
                        );
                    }, 2000);
                } else if (dailyCost.cost_usd >= 2.0) {
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
