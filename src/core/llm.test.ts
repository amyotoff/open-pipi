import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadLlm(options?: {
    advisorEnabled?: boolean;
    maxAdvisorCalls?: number;
    executorModel?: string;
    generateContent?: ReturnType<typeof vi.fn>;
    registeredTools?: Array<{ name: string }>;
    coreTools?: Array<{ name: string }>;
    backingToolNames?: string[];
    toolResults?: Record<string, string>;
}) {
    vi.resetModules();

    const generateContent = options?.generateContent || vi.fn();
    const logTokenUsage = vi.fn();
    const recordLlmRequest = vi.fn();
    const executeToolCall = vi.fn(async ({ toolName, toolArgs, context, handlers, metaHandler }) => {
        if (options?.toolResults && toolName in options.toolResults) {
            return options.toolResults[toolName];
        }
        if (!metaHandler) return '';
        return (await metaHandler(toolName, toolArgs, context, handlers)) ?? '';
    });

    vi.doMock('../config', () => ({
        GEMINI_API_KEY: 'test-key',
        GEMINI_EXECUTOR_MODEL: options?.executorModel || 'gemini-2.5-flash',
        GEMINI_ADVISOR_MODEL: 'gemini-3-pro-preview',
        PIPI_ADVISOR_ENABLED: options?.advisorEnabled ?? true,
        PIPI_ADVISOR_MAX_CALLS_PER_TURN: options?.maxAdvisorCalls ?? 1,
        OLLAMA_URL: 'http://ollama',
        OLLAMA_MODEL: 'qwen-test',
    }));
    vi.doMock('../db', () => ({
        logEvent: vi.fn(),
        logTokenUsage,
        getDailyTokenCost: vi.fn(() => ({ input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 })),
    }));
    vi.doMock('./healthcheck', () => ({
        guardLLMCall: vi.fn(() => null),
        reportGeminiResult: vi.fn(),
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
    vi.doMock('@google/genai', () => ({
        GoogleGenAI: class {
            models = { generateContent };
        },
        Type: {
            OBJECT: 'object',
            STRING: 'string',
        },
    }));

    const mod = await import('./llm');
    return { ...mod, executeToolCall, generateContent, logTokenUsage, recordLlmRequest };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/llm advisor strategy', () => {
    it('removes an unsupported deletion claim and reports that nothing changed', async () => {
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            functionCalls: [],
            text: 'Удалил все задачи. Список задач теперь пуст.',
        });
        const mod = await loadLlm({ advisorEnabled: false, generateContent });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Удали все задачи' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            allowedTools: [],
        });

        expect(result.text).toBe('Не выполнил: в этом ходе не было успешного инструмента, изменяющего данные.');
        expect(result.text).not.toMatch(/удалил|теперь пуст/i);
    });

    it('keeps useful planning but removes a fabricated reminder receipt', async () => {
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            functionCalls: [],
            text: [
                'План на день:',
                '1. Подготовить смету.',
                '2. Позвонить поставщику.',
                '',
                'Установил напоминание на 15:00.',
            ].join('\n'),
        });
        const mod = await loadLlm({ advisorEnabled: false, generateContent });

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
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            functionCalls: [],
            text: 'Обновил формулировку:\n\n«Запускаем продажи первого сентября».',
        });
        const mod = await loadLlm({ advisorEnabled: false, generateContent });

        const result = await mod.processWithLLM([{ role: 'user', content: 'Обнови формулировку' }], {
            userId: '111',
            spaceId: 'telegram:chat-1',
            allowedTools: [],
        });

        expect(result.text).toBe('Обновил формулировку:\n\n«Запускаем продажи первого сентября».');
    });

    it('allows an action claim after a matching mutating tool succeeds', async () => {
        const functionCallPart = {
            functionCall: {
                name: 'reminder_set',
                args: { content: 'Проверить смету', remind_at: '2026-07-30T15:00:00+02:00' },
            },
            thoughtSignature: 'signed-reminder-state',
        };
        const generateContent = vi
            .fn()
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 },
                functionCalls: [functionCallPart.functionCall],
                candidates: [{ content: { role: 'model', parts: [functionCallPart] } }],
            })
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
                functionCalls: [],
                text: 'Установил напоминание на 15:00.',
            });
        const mod = await loadLlm({
            advisorEnabled: false,
            executorModel: 'gemini-3-flash-preview',
            generateContent,
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
        const generateContent = vi
            .fn()
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 },
                functionCalls: [
                    {
                        name: 'reminder_set',
                        args: { content: 'Проверить смету' },
                    },
                ],
            })
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
                functionCalls: [],
                text: 'Установил напоминание на 15:00.',
            });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateContent,
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

    it('uses high thinking for Gemini 3 initiative work and keeps routine turns minimal', async () => {
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            functionCalls: [],
            text: 'Done',
        });
        const mod = await loadLlm({
            executorModel: 'gemini-3-flash-preview',
            generateContent,
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

        expect(generateContent.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'high' });
        expect(generateContent.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
    });

    it('preserves Gemini 3 thought signatures across tool-call rounds', async () => {
        const functionCallPart = {
            functionCall: {
                name: 'atelier_list_requests',
                args: { scope: 'pack' },
            },
            thoughtSignature: 'signed-thought-state',
        };
        const generateContent = vi
            .fn()
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 },
                functionCalls: [functionCallPart.functionCall],
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [functionCallPart],
                        },
                    },
                ],
            })
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10 },
                functionCalls: [],
                text: 'NO_REQUEST: existing capabilities are sufficient',
            });
        const mod = await loadLlm({
            executorModel: 'gemini-3-flash-preview',
            generateContent,
            registeredTools: [{ name: 'atelier_list_requests' }],
        });

        await mod.processWithLLM([{ role: 'user', content: 'Run the private review' }], {
            userId: 'system_self_review',
            spaceId: 'telegram:chat-1',
            taskId: 'system:atelier-self-review:2026-07-29T12:00:00.000Z',
            allowedTools: ['atelier_list_requests'],
        });

        expect(generateContent.mock.calls[1][0].contents).toContainEqual({
            role: 'model',
            parts: [functionCallPart],
        });
    });

    it('lets the executor consult the advisor model and then continue the turn', async () => {
        const generateContent = vi
            .fn()
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40 },
                functionCalls: [
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
                usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 25 },
                text: 'Assessment: inspect available context first.\nRecommended next step: gather state, then answer.\nWatch-outs: do not over-explore.',
            })
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 50 },
                functionCalls: [],
                text: 'Final executor answer',
            });

        const mod = await loadLlm({ generateContent });
        const result = await mod.processWithLLM(
            [
                { role: 'system', content: 'You are helpful and careful.' },
                { role: 'user', content: 'Help me figure out the next step.' },
            ],
            { chatId: 'chat-1', userId: '111' }
        );

        expect(result).toEqual({ text: 'Final executor answer' });
        expect(generateContent.mock.calls.map((call) => call[0].model)).toEqual([
            'gemini-2.5-flash',
            'gemini-3-pro-preview',
            'gemini-2.5-flash',
        ]);
        expect(
            generateContent.mock.calls[0][0].config.tools[0].functionDeclarations.map((tool: any) => tool.name)
        ).toContain('consult_advisor');
        expect(generateContent.mock.calls[1][0].config.tools).toBeUndefined();
        expect(generateContent.mock.calls[1][0].contents[0].parts[0].text).toContain('Focused question:');
        // Fourth argument is the space the spend belongs to. This turn has no
        // space in its context, so it is recorded as unattributed rather than
        // being charged to whichever conversation happens to be nearby.
        expect(mod.logTokenUsage).toHaveBeenCalledWith('gemini-3-pro-preview', 70, 25, undefined);
        expect(mod.recordLlmRequest.mock.calls.some((call: any[]) => call[1]?.mode === 'advisor')).toBe(true);
    });

    it('does not expose the advisor tool when the strategy is disabled', async () => {
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            functionCalls: [],
            text: 'Simple answer',
        });

        const mod = await loadLlm({ advisorEnabled: false, generateContent });
        const result = await mod.processWithLLM([{ role: 'user', content: 'Say hi' }], {
            chatId: 'chat-1',
            userId: '111',
        });

        expect(result).toEqual({ text: 'Simple answer' });
        expect(
            generateContent.mock.calls[0][0].config.tools[0].functionDeclarations.map((tool: any) => tool.name)
        ).not.toContain('consult_advisor');
        expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it('hides legacy backing tools when their core primitive is exposed', async () => {
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            functionCalls: [],
            text: 'Done',
        });
        const mod = await loadLlm({
            advisorEnabled: false,
            generateContent,
            registeredTools: [{ name: 'web_search' }, { name: 'memory_remember' }, { name: 'project_create' }],
            coreTools: [{ name: 'web' }],
            backingToolNames: ['web_search'],
        });

        await mod.processWithLLM([{ role: 'user', content: 'Find project context' }], {
            chatId: 'chat-1',
            userId: '111',
        });

        const names = generateContent.mock.calls[0][0].config.tools[0].functionDeclarations.map(
            (tool: any) => tool.name
        );
        expect(names).toContain('web');
        expect(names).toContain('memory_remember');
        expect(names).toContain('project_create');
        expect(names).not.toContain('web_search');
    });

    it('does not add broad core or meta tools to an exact nested-run allowlist', async () => {
        const generateContent = vi.fn().mockResolvedValue({
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
            functionCalls: [],
            text: 'Done',
        });
        const mod = await loadLlm({
            generateContent,
            registeredTools: [{ name: 'web_search' }],
            coreTools: [{ name: 'web' }, { name: 'automations' }],
            backingToolNames: ['web_search'],
        });

        await mod.processWithLLM([{ role: 'user', content: 'Research this' }], {
            chatId: 'chat-1',
            userId: '111',
            allowedTools: ['web_search'],
        });

        const names = generateContent.mock.calls[0][0].config.tools[0].functionDeclarations.map(
            (tool: any) => tool.name
        );
        expect(names).toEqual(['web_search']);
    });

    it('charges the spend to the space whose turn it is', async () => {
        const generateContent = vi.fn().mockResolvedValueOnce({
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 30 },
            functionCalls: [],
            text: 'Answer',
        });

        const mod = await loadLlm({ generateContent });
        await mod.processWithLLM([{ role: 'user', content: 'Hello' }], {
            chatId: 'chat-1',
            userId: '111',
            spaceId: 'telegram:-100',
        });

        // Without this the dashboard can say what the assistant cost but not
        // which conversation ran up the bill.
        expect(mod.logTokenUsage).toHaveBeenCalledWith(expect.any(String), 90, 30, 'telegram:-100');
    });
});
