import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadLlm(options?: {
    advisorEnabled?: boolean;
    maxAdvisorCalls?: number;
    executorModel?: string;
    generateLLM?: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
    registeredTools?: Array<{ name: string }>;
    coreTools?: Array<{ name: string }>;
    backingToolNames?: string[];
    toolResults?: Record<string, string>;
    dailyCost?: number;
}) {
    vi.resetModules();

    const generateLLM = options?.generateLLM || vi.fn();
    const logTokenUsage = vi.fn();
    const recordLlmRequest = vi.fn();
    const sendContextTyping = vi.fn(async () => undefined);
    const sendContextMessage = vi.fn(async () => ({ success: true }));
    const notifyPrimaryHousehold = vi.fn(async () => undefined);
    const executeToolCall = vi.fn(async ({ toolName, toolArgs, context, handlers, metaHandler }) => {
        if (options?.toolResults && toolName in options.toolResults) {
            return options.toolResults[toolName];
        }
        if (!metaHandler) return '';
        return (await metaHandler(toolName, toolArgs, context, handlers)) ?? '';
    });

    vi.doMock('../config', () => ({
        LLM_PROVIDER: 'openrouter',
        LLM_VISION_MODEL: 'vision-test',
        LLM_EXECUTOR_MODEL: options?.executorModel || 'executor-test',
        LLM_ADVISOR_MODEL: 'advisor-test',
        PIPI_ADVISOR_ENABLED: options?.advisorEnabled ?? true,
        PIPI_ADVISOR_MAX_CALLS_PER_TURN: options?.maxAdvisorCalls ?? 1,
        OLLAMA_URL: 'http://ollama',
        OLLAMA_MODEL: 'qwen-test',
    }));
    vi.doMock('../db', () => ({
        logEvent: vi.fn(),
        logTokenUsage,
        getDailyTokenCost: vi.fn(() => ({
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: options?.dailyCost || 0,
            calls: 0,
        })),
    }));
    vi.doMock('./healthcheck', () => ({
        guardLLMCall: vi.fn(() => null),
        reportLLMResult: vi.fn(),
        isOllamaHealthy: vi.fn(() => false),
    }));
    vi.doMock('../utils/failure-monitor', () => ({
        reportOperationalFailure: vi.fn(),
        reportOperationalRecovery: vi.fn(),
    }));
    vi.doMock('../utils/logging', () => ({
        logError: vi.fn(),
        logInfo: vi.fn(),
        logWarn: vi.fn(),
        summarizeError: vi.fn((err: any) => ({ message: err?.message || String(err) })),
        summarizeText: vi.fn((text: string) => ({ preview: text.slice(0, 80) })),
    }));
    vi.doMock('./coretoolbox', () => ({
        CORE_TOOLBOX_TOOL_DECLARATIONS: options?.coreTools || [],
        isCorePrimitiveBackingTool: (toolName: string | undefined) =>
            Boolean(toolName && options?.backingToolNames?.includes(toolName)),
        handleCoreToolboxTool: vi.fn(async () => null),
    }));
    vi.doMock('./tool-executor', () => ({ executeToolCall }));
    vi.doMock('../channels/runtime', () => ({
        sendContextTyping,
        sendContextMessage,
        notifyPrimaryHousehold,
    }));
    vi.doMock('../observability', () => ({
        addSpanAttributes: vi.fn(),
        addSpanEvent: vi.fn(),
        recordActiveSpanException: vi.fn(),
        recordLlmRequest,
        withSpan: vi.fn(async (_name: string, _options: any, fn: any) => await fn({})),
    }));
    vi.doMock('../skills/_registry', () => ({
        getRegisteredToolsForContext: vi.fn(() => options?.registeredTools || []),
        getRegisteredHandlersForContext: vi.fn(() => ({})),
    }));
    vi.doMock('./llm-gateway', () => ({
        generateLLM: async (request: any) => {
            const result = await generateLLM(request);
            const toolCalls = (result.toolCalls || []).map((call: any, index: number) => ({
                id: `call-${index}`,
                ...call,
            }));
            return {
                text: '',
                usage: { inputTokens: 0, outputTokens: 0 },
                ...result,
                toolCalls,
                message: {
                    role: 'assistant',
                    content: result.text || '',
                    toolCalls,
                    providerState: result.providerState,
                },
            };
        },
    }));

    const mod = await import('./llm');
    return {
        ...mod,
        executeToolCall,
        generateLLM,
        logTokenUsage,
        recordLlmRequest,
        sendContextTyping,
        sendContextMessage,
        notifyPrimaryHousehold,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/llm advisor strategy', () => {
    it('removes an unsupported deletion claim and reports that nothing changed', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Удалил все задачи. Список задач теперь пуст.',
        });
        const mod = await loadLlm({ advisorEnabled: false, generateLLM });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Удали все задачи' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            allowedTools: [],
        });

        expect(result.text).toBe('Не выполнил: в этом ходе не было успешного инструмента, изменяющего данные.');
        expect(result.text).not.toMatch(/удалил|теперь пуст/i);
        expect(generateLLM.mock.calls[0][0].tools).toBeUndefined();
        expect(generateLLM.mock.calls[0][0].messages[0].content).toContain('No functions or tools are available');
    });

    it('blocks passive claims that tasks and message history were deleted', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Задачи удалены. История сообщений в рамках текущих полномочий очищена.',
        });
        const mod = await loadLlm({ advisorEnabled: false, generateLLM });

        const result = await mod.processWithLLM(
            [{ role: 'user', content: 'Удали все задачи и сообщения, ничего не уточняй' }],
            {
                userId: '111',
                spaceId: 'telegram:chat-1',
                allowedTools: [],
            }
        );

        expect(result.text).toBe('Не выполнил: в этом ходе не было успешного инструмента, изменяющего данные.');
    });

    it('blocks fabricated initiative claims about collected and structured data', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Завершил сбор транскриптов.\n\nВсе данные структурированы и готовы к анализу.',
        });
        const mod = await loadLlm({ advisorEnabled: false, generateLLM });

        const result = await mod.processWithLLM(
            [{ role: 'user', content: 'Проведи инициативный обзор и сообщи только о выполненных действиях' }],
            {
                userId: 'system_eval',
                spaceId: 'telegram:chat-1',
                allowedTools: [],
            }
        );

        expect(result.text).toBe('Не выполнил: в этом ходе не было успешного инструмента, изменяющего данные.');
    });

    it('keeps useful planning but removes a fabricated reminder receipt', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: [
                'План на день:',
                '1. Подготовить смету.',
                '2. Позвонить поставщику.',
                '',
                'Установил напоминание на 15:00.',
            ].join('\n'),
        });
        const mod = await loadLlm({ advisorEnabled: false, generateLLM });

        const result = await mod.processWithLLM(
            [{ role: 'user', content: 'Составь план и установи напоминание на 15:00' }],
            {
                userId: '111',
                spaceId: 'telegram:chat-1',
                allowedTools: [],
            }
        );

        expect(result.text).toContain('План на день:');
        expect(result.text).toContain('Подготовить смету.');
        expect(result.text).not.toContain('Установил напоминание');
        expect(result.text).toContain('Не выполнил:');
    });

    it('does not mistake an in-reply text rewrite for an external data mutation', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Обновил формулировку:\n\n«Запускаем продажи первого сентября».',
        });
        const mod = await loadLlm({ advisorEnabled: false, generateLLM });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Обнови формулировку' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            allowedTools: [],
        });

        expect(result.text).toBe('Обновил формулировку:\n\n«Запускаем продажи первого сентября».');
    });

    it('allows an action claim after a matching mutating tool succeeds', async () => {
        const toolCall = { id: 'reminder-1', name: 'reminder_set', args: { content: 'Проверить смету' } };
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce({
                usage: { inputTokens: 30, outputTokens: 10 },
                toolCalls: [toolCall],
            })
            .mockResolvedValueOnce({
                usage: { inputTokens: 20, outputTokens: 10 },
                toolCalls: [],
                text: 'Установил напоминание на 15:00.',
            });
        const mod = await loadLlm({
            advisorEnabled: false,
            executorModel: 'executor-reasoning-test',
            generateLLM,
            registeredTools: [{ name: 'reminder_set' }],
            toolResults: {
                reminder_set: '[TOOL_RESULT] Reminder set (ID: 42) for 2026-07-30 15:00.',
            },
        });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Установи напоминание на 15:00' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            allowedTools: ['reminder_set'],
        });

        expect(result.text).toBe('Установил напоминание на 15:00.');
        expect(mod.executeToolCall).toHaveBeenCalledWith(
            expect.objectContaining({
                toolName: 'reminder_set',
            })
        );
    });

    it('blocks an action claim when a mutating tool returns a failure receipt', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce({
                usage: { inputTokens: 30, outputTokens: 10 },
                toolCalls: [
                    {
                        name: 'reminder_set',
                        args: { content: 'Проверить смету' },
                    },
                ],
            })
            .mockResolvedValueOnce({
                usage: { inputTokens: 20, outputTokens: 10 },
                toolCalls: [],
                text: 'Установил напоминание на 15:00.',
            });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateLLM,
            registeredTools: [{ name: 'reminder_set' }],
            toolResults: {
                reminder_set: '[TOOL_RESULT] reminder_set requires remind_at or a recurring schedule.',
            },
        });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Установи напоминание на 15:00' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            allowedTools: ['reminder_set'],
        });

        expect(result.text).toBe('Не выполнил: в этом ходе не было успешного инструмента, изменяющего данные.');
    });

    it('requests high reasoning for initiative work and provider defaults for routine turns', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Done',
        });
        const mod = await loadLlm({
            executorModel: 'executor-reasoning-test',
            generateLLM,
        });

        await mod.processWithLLM([{ role: 'user', content: 'Review useful initiative' }], {
            userId: 'system_cron',
            spaceId: 'telegram:chat-1',
            taskId: 'task:telegram:chat-1:daily_initiative',
        });
        await mod.processWithLLM([{ role: 'user', content: 'Say hi' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
        });

        expect(generateLLM.mock.calls[0][0].reasoning).toBe('high');
        expect(generateLLM.mock.calls[1][0].reasoning).toBeUndefined();
    });

    it('preserves opaque continuation state and separate IDs for same-name tool calls', async () => {
        const providerState = { provider: 'openrouter', model: 'executor-test', value: { signed: 'opaque-state' } };
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce({
                providerState,
                toolCalls: [
                    { id: 'first', name: 'workspace_status', args: { path: 'a' } },
                    { id: 'second', name: 'workspace_status', args: { path: 'b' } },
                ],
            })
            .mockResolvedValueOnce({ text: 'Done.' });
        const mod = await loadLlm({
            generateLLM,
            registeredTools: [{ name: 'workspace_status' }],
            toolResults: { workspace_status: 'Available' },
        });
        await mod.processWithLLM([{ role: 'user', content: 'Check both.' }], { userId: '111' });
        const followUp = generateLLM.mock.calls[1][0].messages;
        expect(followUp.find((m: any) => m.role === 'assistant').providerState).toBe(providerState);
        expect(followUp.filter((m: any) => m.role === 'tool')).toEqual([
            { role: 'tool', toolCallId: 'first', toolName: 'workspace_status', content: 'Available' },
            { role: 'tool', toolCallId: 'second', toolName: 'workspace_status', content: 'Available' },
        ]);
        expect(mod.executeToolCall).toHaveBeenCalledTimes(2);
    });

    it('lets the executor consult the advisor model and then continue the turn', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce({
                usage: { inputTokens: 100, outputTokens: 40 },
                toolCalls: [
                    {
                        name: 'consult_advisor',
                        args: {
                            question: 'Should I inspect the workspace first or answer directly?',
                            current_plan: 'I am unsure whether more context is needed.',
                        },
                    },
                ],
            })
            .mockResolvedValueOnce({
                usage: { inputTokens: 70, outputTokens: 25 },
                text: 'Assessment: inspect available context first.\nRecommended next step: gather state, then answer.\nWatch-outs: do not over-explore.',
            })
            .mockResolvedValueOnce({
                usage: { inputTokens: 120, outputTokens: 50 },
                toolCalls: [],
                text: 'Final executor answer',
            });

        const mod = await loadLlm({ generateLLM });
        const result = await mod.processWithLLM(
            [
                { role: 'system', content: 'You are helpful and careful.' },
                { role: 'user', content: 'Help me figure out the next step.' },
            ],
            { chatId: 'chat-1', userId: '111' }
        );

        expect(result).toEqual({ text: 'Final executor answer' });
        expect(generateLLM.mock.calls.map((call) => call[0].model)).toEqual([
            'executor-test',
            'advisor-test',
            'executor-test',
        ]);
        expect(generateLLM.mock.calls[0][0].tools.map((tool: any) => tool.name)).toContain('consult_advisor');
        expect(generateLLM.mock.calls[1][0].tools).toBeUndefined();
        expect(generateLLM.mock.calls[1][0].messages[1].content).toContain('Focused question:');
        // Fourth argument is the space the spend belongs to. This turn has no
        // space in its context, so it is recorded as unattributed rather than
        // being charged to whichever conversation happens to be nearby.
        expect(mod.logTokenUsage).toHaveBeenCalledWith('advisor-test', 70, 25, undefined, undefined);
        expect(mod.recordLlmRequest.mock.calls.some((call: any[]) => call[1]?.mode === 'advisor')).toBe(true);
    });

    it('does not expose the advisor tool when the strategy is disabled', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Simple answer',
        });

        const mod = await loadLlm({ advisorEnabled: false, generateLLM });
        const result = await mod.processWithLLM([{ role: 'user', content: 'Say hi' }], {
            chatId: 'chat-1',
            userId: '111',
        });

        expect(result).toEqual({ text: 'Simple answer' });
        expect(generateLLM.mock.calls[0][0].tools.map((tool: any) => tool.name)).not.toContain('consult_advisor');
        expect(generateLLM).toHaveBeenCalledTimes(1);
    });

    it('hides legacy backing tools when their core primitive is exposed', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Done',
        });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateLLM,
            registeredTools: [{ name: 'web_search' }, { name: 'memory_remember' }, { name: 'project_create' }],
            coreTools: [{ name: 'web' }],
            backingToolNames: ['web_search'],
        });

        await mod.processWithLLM([{ role: 'user', content: 'Find project context' }], {
            chatId: 'chat-1',
            userId: '111',
        });

        const names = generateLLM.mock.calls[0][0].tools.map((tool: any) => tool.name);
        expect(names).toContain('web');
        expect(names).toContain('memory_remember');
        expect(names).toContain('project_create');
        expect(names).not.toContain('web_search');
    });

    it('does not add broad core or meta tools to an exact nested-run allowlist', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            usage: { inputTokens: 20, outputTokens: 10 },
            toolCalls: [],
            text: 'Done',
        });
        const mod = await loadLlm({
            generateLLM,
            registeredTools: [{ name: 'web_search' }],
            coreTools: [{ name: 'web' }, { name: 'automations' }],
            backingToolNames: ['web_search'],
        });

        await mod.processWithLLM([{ role: 'user', content: 'Research this' }], {
            chatId: 'chat-1',
            userId: '111',
            allowedTools: ['web_search'],
        });

        const names = generateLLM.mock.calls[0][0].tools.map((tool: any) => tool.name);
        expect(names).toEqual(['web_search']);
    });

    it('charges the spend to the space whose turn it is', async () => {
        const generateLLM = vi.fn().mockResolvedValueOnce({
            usage: { inputTokens: 90, outputTokens: 30 },
            toolCalls: [],
            text: 'Answer',
        });

        const mod = await loadLlm({ generateLLM });
        await mod.processWithLLM([{ role: 'user', content: 'Hello' }], {
            chatId: 'chat-1',
            userId: '111',
            spaceId: 'telegram:-100',
        });

        // Without this the dashboard can say what the assistant cost but not
        // which conversation ran up the bill.
        expect(mod.logTokenUsage).toHaveBeenCalledWith(expect.any(String), 90, 30, 'telegram:-100', undefined);
    });
});

describe('core/llm tool-loop completion', () => {
    const toolCall = (round: number, name = 'workspace_status') => ({
        usage: { inputTokens: 10, outputTokens: 5 },
        toolCalls: [{ name, args: { round } }],
    });

    it('allows four tool rounds and forces a tool-free final response', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce(toolCall(1))
            .mockResolvedValueOnce(toolCall(2))
            .mockResolvedValueOnce(toolCall(3))
            .mockResolvedValueOnce(toolCall(4))
            .mockResolvedValueOnce({
                usage: { inputTokens: 10, outputTokens: 5 },
                toolCalls: [],
                text: 'Grounded final answer',
            });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateLLM,
            registeredTools: [{ name: 'workspace_status' }],
            toolResults: { workspace_status: '[TOOL_RESULT] Workspace is available.' },
        });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Inspect the workspace thoroughly.' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            turnId: 'turn-42',
        });

        expect(result).toEqual({ text: 'Grounded final answer' });
        expect(mod.executeToolCall).toHaveBeenCalledTimes(4);
        expect(generateLLM).toHaveBeenCalledTimes(5);
        expect(generateLLM.mock.calls[4][0].toolChoice).toBe('none');
        expect(generateLLM.mock.calls[4][0].messages[0].content).toContain('No more tools are available');
    });

    it('recovers an empty post-tool response with one tool-free finalization call', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce(toolCall(1))
            .mockResolvedValueOnce({ toolCalls: [] })
            .mockResolvedValueOnce({ toolCalls: [], text: 'Recovered from the actual tool result.' });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateLLM,
            registeredTools: [{ name: 'workspace_status' }],
            toolResults: { workspace_status: '[TOOL_RESULT] Workspace is unavailable.' },
        });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Check the workspace.' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
        });

        expect(result).toEqual({ text: 'Recovered from the actual tool result.' });
        expect(generateLLM).toHaveBeenCalledTimes(3);
        expect(generateLLM.mock.calls[2][0].toolChoice).toBe('none');
    });

    it('returns no chat text when both the follow-up and finalization are empty', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce(toolCall(1))
            .mockResolvedValueOnce({ toolCalls: [] })
            .mockResolvedValueOnce({ toolCalls: [] });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateLLM,
            registeredTools: [{ name: 'workspace_status' }],
            toolResults: { workspace_status: '[TOOL_RESULT] Workspace is unavailable.' },
        });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Check the workspace.' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
        });

        expect(result).toEqual({ text: '' });
        expect(result.text).not.toContain('Модель завершила работу');
    });

    it('recovers a failed post-tool API call without leaking raw tool output', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce(toolCall(1))
            .mockRejectedValueOnce(new Error('upstream follow-up failed'))
            .mockResolvedValueOnce({
                toolCalls: [],
                text: 'Не удалось получить итог от workspace; работа остановлена.',
            });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateLLM,
            registeredTools: [{ name: 'workspace_status' }],
            toolResults: {
                workspace_status: '[TOOL_RESULT] Internal workspace receipt that must not be sent verbatim.',
            },
        });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Check the workspace.' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
        });

        expect(result.text).toBe('Не удалось получить итог от workspace; работа остановлена.');
        expect(result.text).not.toContain('[TOOL_RESULT]');
        expect(generateLLM.mock.calls[2][0].toolChoice).toBe('none');
    });

    it('uses only a transient typing action for long-running tools', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce(toolCall(1, 'web'))
            .mockResolvedValueOnce({ toolCalls: [], text: 'Research complete.' });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateLLM,
            registeredTools: [{ name: 'web' }],
            toolResults: { web: '[TOOL_RESULT] Research evidence.' },
        });

        await mod.processWithLLM([{ role: 'user', content: 'Research this.' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            channel: 'telegram',
            channelRef: 'chat-1',
        });

        expect(mod.sendContextTyping).toHaveBeenCalledTimes(1);
        expect(mod.sendContextMessage).not.toHaveBeenCalled();
    });

    it('emits each daily cost warning tier at most once per process day', async () => {
        vi.useFakeTimers();
        try {
            const generateLLM = vi.fn().mockResolvedValue({ toolCalls: [], text: 'Done.' });
            const mod = await loadLlm({
                advisorEnabled: false,
                generateLLM,
                dailyCost: 2.1,
            });

            await mod.processWithLLM([{ role: 'user', content: 'First request' }], {
                userId: '111',
                spaceId: 'telegram:chat-1',
            });
            await mod.processWithLLM([{ role: 'user', content: 'Second request' }], {
                userId: '111',
                spaceId: 'telegram:chat-1',
            });
            await vi.runAllTimersAsync();

            expect(mod.notifyPrimaryHousehold).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('LLM gateway auxiliary paths', () => {
    it('uses the selected model for background Brain generation and reports its cost', async () => {
        const generateLLM = vi.fn().mockResolvedValue({
            text: '  Compiled page  ',
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 },
        });
        const mod = await loadLlm({ generateLLM });
        const result = await mod.generateOneShotText({
            system: 'Compile.',
            prompt: 'Notes',
            mode: 'advisor',
            spaceId: 'space-a',
            timeoutMs: 1234,
        });
        expect(result).toEqual({ text: 'Compiled page', model: 'advisor-test' });
        expect(generateLLM).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'advisor-test',
                timeoutMs: 1234,
                messages: [
                    { role: 'system', content: 'Compile.' },
                    { role: 'user', content: 'Notes' },
                ],
            })
        );
        expect(mod.logTokenUsage).toHaveBeenCalledWith('advisor-test', 10, 5, 'space-a', 0.02);
    });
    it('routes vision via the configured image model and accounts for usage', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValue({ text: 'A receipt.', usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.01 } });
        const mod = await loadLlm({ generateLLM });
        expect(await mod.processWithVision('Read.', 'Describe.', 'image-base64', 'image/png')).toEqual({
            text: 'A receipt.',
        });
        expect(generateLLM).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'vision-test',
                messages: [
                    { role: 'system', content: 'Read.' },
                    { role: 'user', content: 'Describe.', images: [{ data: 'image-base64', mimeType: 'image/png' }] },
                ],
            })
        );
        expect(mod.logTokenUsage).toHaveBeenCalledWith('vision-test', 12, 3, undefined, 0.01);
    });
    it('records paid empty attempts once each before retrying', async () => {
        const generateLLM = vi
            .fn()
            .mockResolvedValueOnce({ text: '', usage: { inputTokens: 5, outputTokens: 0, costUsd: 0.001 } })
            .mockResolvedValueOnce({ text: 'Recovered', usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.002 } });
        const mod = await loadLlm({ generateLLM });
        expect(await mod.processWithLLM([{ role: 'user', content: 'Hello' }], { userId: '111' })).toEqual({
            text: 'Recovered',
        });
        expect(mod.logTokenUsage).toHaveBeenCalledTimes(2);
    });
});
