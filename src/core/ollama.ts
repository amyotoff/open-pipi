import { OLLAMA_URL, OLLAMA_MODEL } from '../config';
import { logTokenUsage } from '../db';

let ollamaAvailable: boolean | null = null;
let lastCheck = 0;
const CHECK_INTERVAL_MS = 60_000; // Re-check availability every 60s

/** Fast local generation for routing decisions. Never falls back to a paid model. */
export async function classifyWithOllama(prompt: string, timeoutMs: number = 2000): Promise<string | null> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt,
                stream: false,
                options: { temperature: 0 },
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) return null;

        const data = await res.json();
        const inputTokens = data.prompt_eval_count || 0;
        const outputTokens = data.eval_count || 0;
        if (inputTokens > 0 || outputTokens > 0) {
            logTokenUsage(`ollama:${OLLAMA_MODEL}:triage`, inputTokens, outputTokens);
        }
        return typeof data.response === 'string' ? data.response.trim() : null;
    } catch {
        return null;
    }
}

export async function isOllamaAvailable(): Promise<boolean> {
    const now = Date.now();
    if (ollamaAvailable !== null && now - lastCheck < CHECK_INTERVAL_MS) {
        return ollamaAvailable;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const res = await fetch(`${OLLAMA_URL}/api/tags`, {
            signal: controller.signal,
        });
        clearTimeout(timeout);

        ollamaAvailable = res.ok;
        lastCheck = now;

        if (ollamaAvailable) {
            console.log(`[OLLAMA] Available at ${OLLAMA_URL}, model: ${OLLAMA_MODEL}`);
        }
        return ollamaAvailable;
    } catch {
        ollamaAvailable = false;
        lastCheck = now;
        return false;
    }
}

export async function processWithOllama(
    prompt: string,
    systemPrompt?: string
): Promise<{ text: string; fromOllama: boolean }> {
    const available = await isOllamaAvailable();

    if (!available) {
        console.log('[OLLAMA] Not available, falling back to Gemini');
        return fallbackToGemini(prompt, systemPrompt);
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const body: any = {
            model: OLLAMA_MODEL,
            prompt,
            stream: false,
        };
        if (systemPrompt) {
            body.system = systemPrompt;
        }

        const res = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            console.warn(`[OLLAMA] HTTP ${res.status}, falling back to Gemini`);
            return fallbackToGemini(prompt, systemPrompt);
        }

        const data = await res.json();
        const text = data.response || '';

        // Log token usage with $0 cost
        const inputTokens = data.prompt_eval_count || 0;
        const outputTokens = data.eval_count || 0;
        if (inputTokens > 0 || outputTokens > 0) {
            logTokenUsage(`ollama:${OLLAMA_MODEL}`, inputTokens, outputTokens);
        }

        console.log(
            `[OLLAMA] Generated ${outputTokens} tokens in ${data.total_duration ? Math.round(data.total_duration / 1e6) + 'ms' : '?'}`
        );

        return { text, fromOllama: true };
    } catch (err: any) {
        console.warn(`[OLLAMA] Error: ${err.message}, falling back to Gemini`);
        ollamaAvailable = false; // Mark as unavailable for CHECK_INTERVAL
        return fallbackToGemini(prompt, systemPrompt);
    }
}

async function fallbackToGemini(prompt: string, systemPrompt?: string): Promise<{ text: string; fromOllama: boolean }> {
    const { processWithLLM } = await import('./llm');
    const messages: any[] = [];

    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const result = await processWithLLM(messages, { chatId: 'ollama_fallback', userId: 'ollama_fallback' });
    return { text: result.text, fromOllama: false };
}
