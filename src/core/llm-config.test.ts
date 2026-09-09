import { describe, expect, it } from 'vitest';
import { LLM_KEY_ENV, resolveLlmConfig } from './llm-config';
import { LLMProvider } from './llm-types';

describe('LLM routing configuration', () => {
    it('defaults to OpenRouter even if a legacy Gemini key exists', () => {
        expect(resolveLlmConfig({ GEMINI_API_KEY: 'legacy' })).toMatchObject({
            provider: 'openrouter',
            apiKey: '',
            executorModel: 'google/gemini-2.5-flash',
            searchProvider: 'openrouter',
        });
    });
    it.each(['openrouter', 'openai', 'anthropic', 'gemini'] as LLMProvider[])(
        'selects only %s credentials',
        (provider) => {
            const config = resolveLlmConfig({
                LLM_PROVIDER: provider,
                [LLM_KEY_ENV[provider]]: ' key ',
                LLM_EXECUTOR_MODEL: 'executor',
                LLM_ADVISOR_MODEL: 'advisor',
                LLM_VISION_MODEL: 'vision',
            });
            expect(config).toMatchObject({
                provider,
                apiKey: 'key',
                executorModel: 'executor',
                advisorModel: 'advisor',
                visionModel: 'vision',
            });
        }
    );
    it('supports legacy model aliases only on explicit Gemini bypass', () => {
        const legacy = { GEMINI_EXECUTOR_MODEL: 'legacy-executor', GEMINI_ADVISOR_MODEL: 'legacy-advisor' };
        expect(resolveLlmConfig({ ...legacy, LLM_PROVIDER: 'gemini' })).toMatchObject({
            executorModel: 'legacy-executor',
            advisorModel: 'legacy-advisor',
            searchProvider: 'gemini',
        });
        expect(resolveLlmConfig(legacy).executorModel).toBe('google/gemini-2.5-flash');
        expect(
            resolveLlmConfig({ ...legacy, LLM_PROVIDER: 'gemini', LLM_EXECUTOR_MODEL: 'explicit' }).executorModel
        ).toBe('explicit');
    });
    it('keeps inference independent of the optional search route', () => {
        expect(
            resolveLlmConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'key', LLM_SEARCH_PROVIDER: 'gemini' })
        ).toMatchObject({ apiKey: 'key', searchProvider: 'gemini', searchModel: 'gemini-2.5-flash' });
    });
    it('rejects unsupported routes', () => {
        expect(() => resolveLlmConfig({ LLM_PROVIDER: 'unknown' })).toThrow('Unsupported LLM_PROVIDER');
        expect(() => resolveLlmConfig({ LLM_SEARCH_PROVIDER: 'anthropic' })).toThrow('LLM_SEARCH_PROVIDER');
    });
});
