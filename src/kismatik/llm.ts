import { LLM_CONFIG } from '../config';
import { guardLLMCall } from '../core/healthcheck';
import { generateLLM } from '../core/llm-gateway';
import { logTokenUsage } from '../db';

export type KismatikLlm = (input: { system: string; user: string; maxTokens?: number }) => Promise<string>;

const defaultLlm: KismatikLlm = async ({ system, user, maxTokens }) => {
    const blocked = guardLLMCall();
    if (blocked) throw new Error(blocked);
    const response = await generateLLM({
        provider: LLM_CONFIG.provider,
        model: LLM_CONFIG.executorModel,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
        temperature: 0.2,
        maxTokens: maxTokens ?? 1200,
        timeoutMs: 45_000,
    });
    logTokenUsage(
        LLM_CONFIG.executorModel,
        response.usage.inputTokens,
        response.usage.outputTokens,
        undefined,
        response.usage.costUsd
    );
    return response.text;
};

let current: KismatikLlm = defaultLlm;

export function kismatikLlm(): KismatikLlm {
    return current;
}

export function setKismatikLlmForTest(llm: KismatikLlm | null): void {
    current = llm ?? defaultLlm;
}

/** Models wrap JSON in fences or prose; take the first balanced object or array. */
export function parseJsonLoose<T>(text: string): T | null {
    const cleaned = text.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.search(/[[{]/);
    if (start < 0) return null;
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    const end = cleaned.lastIndexOf(close);
    if (end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
        return null;
    }
}
