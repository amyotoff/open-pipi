import { randomUUID } from 'node:crypto';
import { LLM_PROVIDER } from '../config';
import { LLM_KEY_ENV } from './llm-config';
import { LLMMessage, LLMRequest, LLMResponse, LLMToolCall, Schema } from './llm-types';

// Native fetch keeps the bus small: no agent framework or provider SDK in the application.
const ENDPOINTS = {
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};

function jsonSchema(schema: Schema = { type: 'object', properties: {} }): Schema {
    const result = { ...schema };
    if (schema.type) result.type = schema.type.toLowerCase();
    if (schema.properties)
        result.properties = Object.fromEntries(
            Object.entries(schema.properties).map(([key, value]) => [key, jsonSchema(value)])
        );
    if (schema.items) result.items = jsonSchema(schema.items);
    return result;
}

function parseArgs(value: unknown): Record<string, unknown> {
    let args: unknown;
    try {
        args = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        throw new Error('LLM returned invalid JSON tool arguments.');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('LLM returned invalid tool arguments; expected a JSON object.');
    }
    return args as Record<string, unknown>;
}

/** Exactly one request to the selected route. Retry/fallback policy stays in the caller. */
export async function generateLLM(request: LLMRequest): Promise<LLMResponse> {
    const provider = request.provider ?? LLM_PROVIDER;
    const apiKey = process.env[LLM_KEY_ENV[provider]]?.trim();
    if (!apiKey) throw new Error(`${LLM_KEY_ENV[provider]} is not configured for ${provider}.`);
    if (request.webSearch && provider !== 'openrouter' && provider !== 'gemini') {
        throw new Error(`Web search is not supported by the ${provider} adapter.`);
    }
    const system = request.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
    const history = request.messages.filter((m) => m.role !== 'system');
    const nativeState = (m: LLMMessage): any => {
        if (!m.providerState) return undefined;
        if (m.providerState.provider !== provider || m.providerState.model !== request.model) {
            throw new Error('Cannot change LLM route inside a signed conversation. Start a new turn.');
        }
        return m.providerState.value;
    };
    const tools = request.tools?.length
        ? request.tools.map((tool) => ({ ...tool, parameters: jsonSchema(tool.parameters) }))
        : undefined;
    let url: string = ENDPOINTS[provider];
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let body: Record<string, any>;

    if (provider === 'gemini') {
        url += `/${encodeURIComponent(request.model)}:generateContent`;
        headers['x-goog-api-key'] = apiKey;
        const nativeIds = new Set(
            history.flatMap((m) =>
                m.providerState
                    ? (nativeState(m) || []).map((p: any) => p.functionCall?.id)
                    : (m.toolCalls || []).map((c) => c.id)
            )
        );
        const contents: Array<{ role: string; parts: any[] }> = [];
        for (const m of history) {
            const role = m.role === 'assistant' ? 'model' : 'user';
            const parts =
                nativeState(m) ??
                (m.role === 'tool'
                    ? [
                          {
                              functionResponse: {
                                  id: nativeIds.has(m.toolCallId) ? m.toolCallId : undefined,
                                  name: m.toolName,
                                  response: { content: m.content },
                              },
                          },
                      ]
                    : [
                          ...(m.content ? [{ text: m.content }] : []),
                          ...(m.images || []).map((image) => ({ inlineData: image })),
                          ...(m.toolCalls || []).map((call) => ({ functionCall: call })),
                      ]);
            const last = contents.at(-1);
            if (last?.role === role) last.parts.push(...parts);
            else contents.push({ role, parts: [...parts] });
        }
        const isGemini3 = /^gemini-3(?:[.-]|$)/i.test(request.model);
        const high = request.reasoning === 'high';
        const pro = request.model.includes('pro');
        const thinkingConfig = isGemini3
            ? { thinkingLevel: high ? 'HIGH' : pro ? 'LOW' : 'MINIMAL' }
            : { thinkingBudget: high ? -1 : pro ? 128 : 0 };
        body = {
            contents,
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            toolConfig: request.toolChoice ? { functionCallingConfig: { mode: 'NONE' } } : undefined,
            tools: request.webSearch
                ? [{ googleSearch: {} }]
                : tools && [
                      {
                          functionDeclarations: tools.map(({ parameters, ...tool }) => ({
                              ...tool,
                              parametersJsonSchema: parameters,
                          })),
                      },
                  ],
            generationConfig: {
                temperature: request.temperature,
                maxOutputTokens: request.maxTokens,
                thinkingConfig: request.reasoning ? thinkingConfig : undefined,
            },
        };
    } else if (provider === 'anthropic') {
        headers = { ...headers, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
        const messages: Array<{ role: string; content: any[] }> = [];
        for (const m of history) {
            const role = m.role === 'assistant' ? 'assistant' : 'user';
            const content =
                nativeState(m) ??
                (m.role === 'tool'
                    ? [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
                    : [
                          ...(m.content ? [{ type: 'text', text: m.content }] : []),
                          ...(m.images || []).map((i) => ({
                              type: 'image',
                              source: { type: 'base64', media_type: i.mimeType, data: i.data },
                          })),
                          ...(m.toolCalls || []).map(({ id, name, args }) => ({
                              type: 'tool_use',
                              id,
                              name,
                              input: args,
                          })),
                      ]);
            const last = messages.at(-1);
            if (last?.role === role) last.content.push(...content);
            else messages.push({ role, content: [...content] });
        }
        body = {
            model: request.model,
            system: system || undefined,
            messages,
            max_tokens: request.maxTokens ?? 8192,
            tool_choice: request.toolChoice ? { type: 'none' } : undefined,
            temperature: request.temperature,
            tools: tools?.map(({ parameters, ...tool }) => ({ ...tool, input_schema: parameters })),
        };
    } else {
        headers.Authorization = `Bearer ${apiKey}`;
        const messages = request.messages.map((m) => {
            const state = nativeState(m);
            if (state) return state;
            if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
            return {
                role: m.role,
                content: m.images?.length
                    ? [
                          { type: 'text', text: m.content },
                          ...m.images.map((i) => ({
                              type: 'image_url',
                              image_url: { url: `data:${i.mimeType};base64,${i.data}` },
                          })),
                      ]
                    : m.content || null,
                tool_calls: m.toolCalls?.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
            };
        });
        const reasoningModel = /^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(request.model);
        body = {
            model: request.model,
            messages,
            tool_choice: request.toolChoice,
            temperature: provider === 'openai' && reasoningModel ? undefined : request.temperature,
            ...(provider === 'openai'
                ? { max_completion_tokens: request.maxTokens }
                : { max_tokens: request.maxTokens }),
            ...(provider === 'openrouter' && request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
            tools: request.webSearch
                ? [{ type: 'openrouter:web_search', parameters: { max_results: 5 } }]
                : tools?.map((tool) => ({ type: 'function', function: tool })),
            ...(request.webSearch ? { max_tool_calls: 3 } : {}),
        };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs ?? 45000),
    });
    // Do not echo upstream bodies: some providers include request data in errors.
    if (!res.ok)
        throw Object.assign(new Error(`${provider} request failed (HTTP ${res.status}).`), { status: res.status });
    const data = await res.json();
    if (data.error)
        throw Object.assign(new Error(`${provider} returned an inference error.`), {
            status: Number(data.error.code) || 502,
        });
    let text: string;
    let calls: Array<{ id?: string; name: string; args: unknown }>;
    let state: unknown;
    let finishReason: string | undefined;
    let usage: LLMResponse['usage'];
    let sources: LLMResponse['sources'] = [];
    if (provider === 'gemini') {
        const candidate = data.candidates?.[0];
        state = candidate?.content?.parts || [];
        text = (state as any[])
            .filter((p) => !p.thought && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
        calls = (state as any[]).filter((p) => p.functionCall).map((p) => p.functionCall);
        finishReason = candidate?.finishReason;
        usage = {
            inputTokens: data.usageMetadata?.promptTokenCount || 0,
            outputTokens:
                (data.usageMetadata?.candidatesTokenCount || 0) + (data.usageMetadata?.thoughtsTokenCount || 0),
        };
        sources = (candidate?.groundingMetadata?.groundingChunks || [])
            .filter((c: any) => c.web?.uri)
            .map((c: any) => ({ title: c.web.title || c.web.uri, url: c.web.uri }));
    } else if (provider === 'anthropic') {
        state = data.content || [];
        text = (state as any[])
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('');
        calls = (state as any[]).filter((p) => p.type === 'tool_use').map((p) => ({ ...p, args: p.input }));
        finishReason = data.stop_reason;
        usage = {
            inputTokens:
                (data.usage?.input_tokens || 0) +
                (data.usage?.cache_read_input_tokens || 0) +
                (data.usage?.cache_creation_input_tokens || 0),
            outputTokens: data.usage?.output_tokens || 0,
        };
    } else {
        const choice = data.choices?.[0];
        const message = choice?.message || { role: 'assistant', content: '' };
        // Keep signed reasoning/tool fields, but not output-only citations/refusals.
        state = {
            role: 'assistant',
            content: message.content,
            tool_calls: message.tool_calls,
            ...(provider === 'openrouter' ? { reasoning_details: message.reasoning_details } : {}),
        };
        text = typeof message.content === 'string' ? message.content : '';
        calls = (message.tool_calls || []).map((c: any) => ({
            id: c.id,
            name: c.function?.name,
            args: c.function?.arguments,
        }));
        finishReason = choice?.finish_reason;
        usage = {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
            costUsd:
                typeof data.usage?.cost === 'number' && Number.isFinite(data.usage.cost) && data.usage.cost >= 0
                    ? data.usage.cost
                    : undefined,
        };
        sources = (message.annotations || [])
            .filter((a: any) => a.url_citation?.url)
            .map((a: any) => ({ title: a.url_citation.title || a.url_citation.url, url: a.url_citation.url }));
    }
    const toolCalls: LLMToolCall[] = calls.map((c) => {
        if (
            typeof c.name !== 'string' ||
            !c.name.trim() ||
            (c.id !== undefined ? typeof c.id !== 'string' || !c.id.trim() : provider !== 'gemini')
        ) {
            throw new Error('LLM returned an invalid tool call.');
        }
        return { id: c.id || randomUUID(), name: c.name, args: parseArgs(c.args ?? {}) };
    });
    const message: LLMMessage = {
        role: 'assistant',
        content: text,
        toolCalls,
        providerState: { provider, model: request.model, value: state },
    };
    return { text, toolCalls, usage, finishReason, sources, message };
}
