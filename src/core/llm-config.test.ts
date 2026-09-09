import { describe, expect, it } from 'vitest';
import { LLM_KEY_ENV, resolveLlmConfig } from './llm-config';
import { LLMProvider } from './llm-types';

describe('LLM routing configuration', () => {
    it('defaults to OpenRouter even if a legacy Gemini key exists', () => {
        expect(resolveLlmConfig({ GEMINI_API_KEY: 'legacy' })).toMatchObject({
            provider: 'openrouter',
            apiKey: '',
            executorModel: 'google/gemini-2.5-flash',
            toolsProvider: 'gemini',
            toolsModel: 'gemini-2.5-flash',
            visionProvider: 'gemini',
            visionModel: 'gemini-2.5-flash',
            searchProvider: 'gemini',
            searchModel: 'gemini-2.5-flash',
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
            expect(config.toolsProvider).toBe(provider === 'openrouter' ? 'gemini' : provider);
            expect(config.visionProvider).toBe(provider === 'openrouter' ? 'gemini' : provider);
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
    it('uses Gemini-native capability routes while OpenRouter remains the text bus', () => {
        expect(resolveLlmConfig({ OPENROUTER_API_KEY: 'router', GEMINI_API_KEY: 'gemini' })).toMatchObject({
            provider: 'openrouter',
            executorModel: 'google/gemini-2.5-flash',
            advisorModel: 'anthropic/claude-sonnet-4.6',
            toolsProvider: 'gemini',
            toolsModel: 'gemini-2.5-flash',
            visionProvider: 'gemini',
            visionModel: 'gemini-2.5-flash',
            searchProvider: 'gemini',
            searchModel: 'gemini-2.5-flash',
        });
    });
    it('inherits a direct text model override for same-provider tools and vision only', () => {
        expect(
            resolveLlmConfig({
                LLM_PROVIDER: 'openai',
                OPENAI_API_KEY: 'key',
                LLM_EXECUTOR_MODEL: 'gpt-4.1-nano',
            })
        ).toMatchObject({
            executorModel: 'gpt-4.1-nano',
            toolsProvider: 'openai',
            toolsModel: 'gpt-4.1-nano',
            visionProvider: 'openai',
            visionModel: 'gpt-4.1-nano',
            searchProvider: 'gemini',
            searchModel: 'gemini-2.5-flash',
        });
    });
    it('keeps default Gemini capabilities native when OpenRouter text uses a namespaced override', () => {
        expect(
            resolveLlmConfig({
                OPENROUTER_API_KEY: 'router',
                GEMINI_API_KEY: 'gemini',
                LLM_EXECUTOR_MODEL: 'openai/gpt-4.1-mini',
            })
        ).toMatchObject({
            executorModel: 'openai/gpt-4.1-mini',
            toolsProvider: 'gemini',
            toolsModel: 'gemini-2.5-flash',
            visionProvider: 'gemini',
            visionModel: 'gemini-2.5-flash',
            searchProvider: 'gemini',
            searchModel: 'gemini-2.5-flash',
        });
    });
    it('inherits the OpenRouter executor only for explicitly OpenRouter capability routes', () => {
        expect(
            resolveLlmConfig({
                OPENROUTER_API_KEY: 'router',
                LLM_EXECUTOR_MODEL: 'anthropic/claude-sonnet-4.6',
                LLM_TOOLS_PROVIDER: 'openrouter',
                LLM_VISION_PROVIDER: 'openrouter',
            })
        ).toMatchObject({
            toolsModel: 'anthropic/claude-sonnet-4.6',
            visionModel: 'anthropic/claude-sonnet-4.6',
            searchProvider: 'gemini',
            searchModel: 'gemini-2.5-flash',
        });
        expect(
            resolveLlmConfig({
                OPENROUTER_API_KEY: 'router',
                LLM_EXECUTOR_MODEL: 'anthropic/claude-sonnet-4.6',
                LLM_TOOLS_PROVIDER: 'openrouter',
                LLM_TOOLS_MODEL: 'openai/gpt-4.1-mini',
                LLM_VISION_PROVIDER: 'openrouter',
                LLM_VISION_MODEL: 'google/gemini-2.5-flash',
            })
        ).toMatchObject({
            toolsModel: 'openai/gpt-4.1-mini',
            visionModel: 'google/gemini-2.5-flash',
        });
    });
    it('keeps capability overrides independent and uses native model namespaces', () => {
        expect(
            resolveLlmConfig({
                OPENROUTER_API_KEY: 'router',
                LLM_TOOLS_PROVIDER: 'anthropic',
                LLM_TOOLS_MODEL: 'claude-sonnet-4-6',
                LLM_VISION_PROVIDER: 'openai',
                LLM_VISION_MODEL: 'gpt-4.1-mini',
                LLM_SEARCH_PROVIDER: 'openrouter',
                LLM_SEARCH_MODEL: 'perplexity/sonar',
            })
        ).toMatchObject({
            provider: 'openrouter',
            toolsProvider: 'anthropic',
            toolsModel: 'claude-sonnet-4-6',
            visionProvider: 'openai',
            visionModel: 'gpt-4.1-mini',
            searchProvider: 'openrouter',
            searchModel: 'perplexity/sonar',
        });
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
