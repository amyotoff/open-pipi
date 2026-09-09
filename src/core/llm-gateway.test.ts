import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateLLM } from './llm-gateway';
import { LLMMessage, LLMProvider, LLMRequest } from './llm-types';

vi.mock('../config', () => ({ LLM_PROVIDER: 'openrouter' }));
const fetchMock = vi.fn();
const request: LLMRequest = {
    model: 'vendor/model',
    messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Check two paths.' },
    ],
    tools: [
        {
            name: 'lookup',
            parameters: {
                type: 'OBJECT',
                properties: {
                    STRING: { type: 'ARRAY', items: { type: 'STRING', enum: ['UPPER'] } },
                },
            },
        },
    ],
};
const chatReply = (message: Record<string, unknown> = { content: 'Hello' }) => ({
    choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0123 },
});
const respond = (data: unknown, status = 200) =>
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(data), { status }));
const sent = (index = 0) => JSON.parse(fetchMock.mock.calls[index][1].body);
const results = (calls: Array<{ id: string; name: string }>): LLMMessage[] =>
    calls.map((c) => ({
        role: 'tool',
        toolCallId: c.id,
        toolName: c.name,
        content: `Result for ${c.id}`,
    }));

beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    for (const name of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
        vi.stubEnv(name, `test-${name}`);
    }
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

describe('LLM gateway contract', () => {
    it.each([
        'anthropic/claude-sonnet-4.6',
        'openai/gpt-4.1',
        'google/gemini-2.5-flash',
        'qwen/qwen3',
        'meta-llama/llama',
    ])('routes arbitrary model %s through OpenRouter by default', async (model) => {
        respond(chatReply());
        const response = await generateLLM({ ...request, model });
        expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-OPENROUTER_API_KEY');
        expect(sent().model).toBe(model);
        expect(sent().messages).toEqual(request.messages);
        expect(sent().tools[0].function.parameters.properties.STRING).toEqual({
            type: 'array',
            items: { type: 'string', enum: ['UPPER'] },
        });
        expect(response.text).toBe('Hello');
        expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.0123 });
    });

    it.each(['openrouter', 'openai'] as LLMProvider[])(
        'preserves same-name tool IDs and continuation state for %s',
        async (provider) => {
            const tool_calls = ['a', 'b'].map((id) => ({
                id,
                type: 'function',
                function: { name: 'lookup', arguments: JSON.stringify({ path: id }) },
            }));
            const reasoning_details = [{ type: 'reasoning.encrypted', data: 'signed-state' }];
            respond(chatReply({ content: 'Checking.', tool_calls, reasoning_details }));
            const first = await generateLLM({ ...request, provider });
            respond(chatReply());
            await generateLLM({
                ...request,
                provider,
                toolChoice: 'none',
                messages: [...request.messages, first.message, ...results(first.toolCalls)],
            });
            expect(first.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
            expect(sent(1).messages[2].tool_calls).toEqual(tool_calls);
            expect(sent(1).messages[2].reasoning_details).toEqual(
                provider === 'openrouter' ? reasoning_details : undefined
            );
            expect(sent(1).messages.slice(3)).toEqual(
                ['a', 'b'].map((id) => ({ role: 'tool', tool_call_id: id, content: `Result for ${id}` }))
            );
            expect(sent(1).tool_choice).toBe('none');
            if (provider === 'openai') {
                expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
                expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-OPENAI_API_KEY');
            }
        }
    );

    it('uses Anthropic system, tool_use/tool_result, signed blocks and cache-inclusive token counts', async () => {
        const content = [
            { type: 'thinking', thinking: 'internal', signature: 'signature' },
            { type: 'text', text: 'Checking.' },
            ...['a', 'b'].map((id) => ({ type: 'tool_use', id, name: 'lookup', input: { path: id } })),
        ];
        respond({
            content,
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
        });
        const first = await generateLLM({ ...request, provider: 'anthropic' });
        respond({ content: [{ type: 'text', text: 'Done' }] });
        await generateLLM({
            ...request,
            provider: 'anthropic',
            toolChoice: 'none',
            messages: [...request.messages, first.message, ...results(first.toolCalls)],
        });
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
            'x-api-key': 'test-ANTHROPIC_API_KEY',
            'anthropic-version': '2023-06-01',
        });
        expect(sent().system).toBe('Be helpful.');
        expect(sent().max_tokens).toBeGreaterThan(0);
        expect(sent().tools[0].input_schema.type).toBe('object');
        expect(first.text).toBe('Checking.');
        expect(first.usage).toEqual({ inputTokens: 15, outputTokens: 5 });
        expect(sent(1).messages[1].content).toEqual(content);
        expect(sent(1).messages[2].content.map((p: any) => p.tool_use_id)).toEqual(['a', 'b']);
        expect(sent(1).tool_choice).toEqual({ type: 'none' });
    });

    it.each([true, false])('round-trips Gemini signed parts with native IDs present=%s', async (hasIds) => {
        const parts = [
            { text: 'private', thought: true, thoughtSignature: 'reasoning-signature' },
            { text: 'Checking.' },
            ...['a', 'b'].map((id) => ({
                functionCall: { ...(hasIds ? { id } : {}), name: 'lookup', args: { path: id } },
                thoughtSignature: `signature-${id}`,
            })),
        ];
        respond({
            candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 },
        });
        const first = await generateLLM({
            ...request,
            provider: 'gemini',
            model: 'gemini-3-flash-preview',
            reasoning: 'high',
        });
        respond({ candidates: [{ content: { parts: [{ text: 'Done' }] } }] });
        await generateLLM({
            ...request,
            provider: 'gemini',
            model: 'gemini-3-flash-preview',
            toolChoice: 'none',
            messages: [...request.messages, first.message, ...results(first.toolCalls)],
        });
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent'
        );
        expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('test-GEMINI_API_KEY');
        expect(first.text).toBe('Checking.');
        expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 12 });
        expect(new Set(first.toolCalls.map((c) => c.id)).size).toBe(2);
        expect(sent().generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
        expect(sent(1).contents[1].parts).toEqual(parts);
        expect(sent(1).contents[2].parts.map((p: any) => p.functionResponse.id)).toEqual(
            hasIds ? ['a', 'b'] : [undefined, undefined]
        );
        expect(sent(1).toolConfig.functionCallingConfig.mode).toBe('NONE');
        expect(parts).toHaveLength(4); // adapter does not mutate the original response
    });

    it.each(['openrouter', 'openai', 'anthropic', 'gemini'] as LLMProvider[])(
        'encodes vision inputs for %s',
        async (provider) => {
            respond(
                provider === 'gemini' ? { candidates: [] } : provider === 'anthropic' ? { content: [] } : chatReply()
            );
            await generateLLM({
                model: 'vision-model',
                provider,
                messages: [
                    { role: 'user', content: 'Describe.', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] },
                ],
            });
            if (provider === 'gemini')
                expect(sent().contents[0].parts[1].inlineData).toEqual({ data: 'aGVsbG8=', mimeType: 'image/png' });
            else if (provider === 'anthropic')
                expect(sent().messages[0].content[1].source).toEqual({
                    type: 'base64',
                    data: 'aGVsbG8=',
                    media_type: 'image/png',
                });
            else expect(sent().messages[0].content[1].image_url.url).toBe('data:image/png;base64,aGVsbG8=');
        }
    );

    it('does not send unsupported sampling parameters to direct OpenAI reasoning models', async () => {
        respond(chatReply());
        await generateLLM({ ...request, provider: 'openai', model: 'gpt-5', temperature: 0.3, maxTokens: 1024 });
        expect(sent().temperature).toBeUndefined();
        expect(sent().max_completion_tokens).toBe(1024);
        expect(sent().max_tokens).toBeUndefined();
    });

    it('extracts OpenRouter citations and bounds server search calls', async () => {
        respond(
            chatReply({
                content: 'Found.',
                annotations: [{ url_citation: { url: 'https://example.org', title: 'Source' } }],
            })
        );
        const response = await generateLLM({ ...request, webSearch: true });
        expect(sent().tools).toEqual([{ type: 'openrouter:web_search', parameters: { max_results: 5 } }]);
        expect(sent().max_tool_calls).toBe(3);
        expect(response.sources).toEqual([{ url: 'https://example.org', title: 'Source' }]);
    });

    it('supports optional Gemini grounding through the same source contract', async () => {
        respond({
            candidates: [
                {
                    content: { parts: [{ text: 'Found' }] },
                    groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.org', title: 'Source' } }] },
                },
            ],
        });
        const response = await generateLLM({ ...request, provider: 'gemini', webSearch: true });
        expect(sent().tools).toEqual([{ googleSearch: {} }]);
        expect(response.sources[0]).toEqual({ url: 'https://example.org', title: 'Source' });
    });

    it.each(['{broken', '[]', '"text"'])('rejects malformed tool arguments %s before execution', async (args) => {
        respond(
            chatReply({ tool_calls: [{ id: 'a', type: 'function', function: { name: 'lookup', arguments: args } }] })
        );
        await expect(generateLLM(request)).rejects.toThrow(/invalid.*arguments/);
    });

    it('rejects missing IDs and names instead of executing an uncorrelated tool', async () => {
        respond(chatReply({ tool_calls: [{ function: { arguments: '{}' } }] }));
        await expect(generateLLM(request)).rejects.toThrow('invalid tool call');
    });

    it.each([
        { id: 7, name: 'lookup' },
        { id: 'a', name: 3 },
        { id: '', name: 'lookup' },
    ])('rejects invalid tool identity %j', async ({ id, name }) => {
        respond(chatReply({ tool_calls: [{ id, function: { name, arguments: '{}' } }] }));
        await expect(generateLLM(request)).rejects.toThrow('invalid tool call');
    });

    it('never silently falls back to another credential or provider', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', '');
        await expect(generateLLM(request)).rejects.toThrow('OPENROUTER_API_KEY');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([{ provider: 'anthropic' as const }, { model: 'another/model' }])(
        'rejects continuation under a different route %j',
        async (override) => {
            respond(chatReply());
            const first = await generateLLM(request);
            await expect(
                generateLLM({ ...request, ...override, messages: [...request.messages, first.message] })
            ).rejects.toThrow('Cannot change LLM route');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        }
    );

    it('preserves HTTP status without echoing upstream error bodies', async () => {
        respond({ error: { message: 'sensitive request echo' } }, 429);
        await expect(generateLLM(request)).rejects.toMatchObject({
            status: 429,
            message: 'openrouter request failed (HTTP 429).',
        });
    });

    it('treats in-band HTTP 200 errors as failures', async () => {
        respond({ error: { code: 503, message: 'sensitive request echo' } });
        await expect(generateLLM(request)).rejects.toMatchObject({
            status: 503,
            message: 'openrouter returned an inference error.',
        });
    });

    it('aborts the underlying request at the deadline', async () => {
        fetchMock.mockImplementationOnce(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
                })
        );
        await expect(generateLLM({ ...request, timeoutMs: 10 })).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('returns an explicit empty response and omits tools for a tool-free request', async () => {
        respond(chatReply({ content: null }));
        const response = await generateLLM({ ...request, tools: [] });
        expect(response.text).toBe('');
        expect(response.toolCalls).toEqual([]);
        expect(sent().tools).toBeUndefined();
    });

    it('rejects unsupported native search before making a request', async () => {
        await expect(generateLLM({ ...request, provider: 'anthropic', webSearch: true })).rejects.toThrow(
            'not supported'
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
