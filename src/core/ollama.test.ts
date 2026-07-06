import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadOllama(options?: {
    available?: boolean;
    generateOk?: boolean;
    generateThrows?: boolean;
    tagsThrows?: boolean;
    emptyResponse?: boolean;
}) {
    vi.resetModules();
    const logTokenUsage = vi.fn();
    const processWithLLM = vi.fn(async () => ({ text: 'Gemini fallback text' }));
    const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/tags')) {
            if (options?.tagsThrows) {
                throw new Error('connect ECONNREFUSED');
            }
            return { ok: options?.available ?? true };
        }

        if (options?.generateThrows) {
            throw new Error('socket hang up');
        }

        if (options?.generateOk === false) {
            return { ok: false, status: 500 };
        }

        return {
            ok: true,
            json: async () => ({
                response: options?.emptyResponse ? '' : 'Ollama says hello',
                prompt_eval_count: options?.emptyResponse ? 0 : 10,
                eval_count: options?.emptyResponse ? 0 : 5,
                total_duration: 123000000,
            }),
        };
    });

    vi.doMock('../config', () => ({
        OLLAMA_URL: 'http://ollama',
        OLLAMA_MODEL: 'qwen-test',
    }));
    vi.doMock('../db', () => ({ logTokenUsage }));
    vi.doMock('./llm', () => ({ processWithLLM }));
    global.fetch = fetchMock as any;

    const mod = await import('./ollama');
    return { ...mod, logTokenUsage, processWithLLM, fetchMock };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('core/ollama', () => {
    it('returns Ollama output when available', async () => {
        const mod = await loadOllama({ available: true, generateOk: true });
        const result = await mod.processWithOllama('Hello');

        expect(result).toEqual({ text: 'Ollama says hello', fromOllama: true });
        expect(mod.logTokenUsage).toHaveBeenCalled();
    });

    it('caches successful availability checks', async () => {
        const mod = await loadOllama({ available: true, generateOk: true });

        expect(await mod.isOllamaAvailable()).toBe(true);
        expect(await mod.isOllamaAvailable()).toBe(true);

        expect(mod.fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to Gemini when Ollama generation fails', async () => {
        const mod = await loadOllama({ available: true, generateOk: false });
        const result = await mod.processWithOllama('Hello');

        expect(result).toEqual({ text: 'Gemini fallback text', fromOllama: false });
        expect(mod.processWithLLM).toHaveBeenCalled();
    });

    it('falls back when Ollama is unavailable before generation', async () => {
        const mod = await loadOllama({ available: false });
        const result = await mod.processWithOllama('Hello', 'System prompt');

        expect(result).toEqual({ text: 'Gemini fallback text', fromOllama: false });
        expect(mod.processWithLLM).toHaveBeenCalledWith(
            [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: 'Hello' },
            ],
            { chatId: 'ollama_fallback', userId: 'ollama_fallback' }
        );
    });

    it('falls back when availability check throws or generation crashes', async () => {
        const unavailable = await loadOllama({ tagsThrows: true });
        expect(await unavailable.isOllamaAvailable()).toBe(false);

        const crashing = await loadOllama({ available: true, generateThrows: true });
        const result = await crashing.processWithOllama('Hello');
        expect(result).toEqual({ text: 'Gemini fallback text', fromOllama: false });
    });

    it('returns empty Ollama text without logging token usage when counts are zero', async () => {
        const mod = await loadOllama({ available: true, generateOk: true, emptyResponse: true });
        const result = await mod.processWithOllama('Hello');

        expect(result).toEqual({ text: '', fromOllama: true });
        expect(mod.logTokenUsage).not.toHaveBeenCalled();
    });
});
