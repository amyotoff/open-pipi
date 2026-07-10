import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadLlm(options?: {
    advisorEnabled?: boolean;
    maxAdvisorCalls?: number;
    generateContent?: ReturnType<typeof vi.fn>;
    registeredTools?: Array<{ name: string }>;
    coreTools?: Array<{ name: string }>;
    backingToolNames?: string[];
}) {
    vi.resetModules();

    const generateContent = options?.generateContent || vi.fn();
    const logTokenUsage = vi.fn();
    const recordLlmRequest = vi.fn();
    const executeToolCall = vi.fn(async ({ toolName, toolArgs, context, handlers, metaHandler }) => {
        if (!metaHandler) return '';
        return (await metaHandler(toolName, toolArgs, context, handlers)) ?? '';
    });

    vi.doMock('../config', () => ({
        GEMINI_API_KEY: 'test-key',
        GEMINI_EXECUTOR_MODEL: 'gemini-2.5-flash',
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
        expect(mod.logTokenUsage).toHaveBeenCalledWith('gemini-3-pro-preview', 70, 25);
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
});
