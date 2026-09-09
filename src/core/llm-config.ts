import { LLMProvider } from './llm-types';

export const LLM_KEY_ENV: Record<LLMProvider, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
};

export function resolveLlmProvider(value = 'openrouter'): LLMProvider {
    const provider = value.trim().toLowerCase();
    if (!Object.hasOwn(LLM_KEY_ENV, provider)) {
        throw new Error(`Unsupported LLM_PROVIDER: ${provider}. Use openrouter, openai, anthropic, or gemini.`);
    }
    return provider as LLMProvider;
}

/** Pure resolver so setup checks use exactly the same routing rules as runtime. */
export function resolveLlmConfig(env: NodeJS.ProcessEnv) {
    const provider = resolveLlmProvider(env.LLM_PROVIDER || 'openrouter');
    const defaults: Record<LLMProvider, [string, string]> = {
        openrouter: ['google/gemini-2.5-flash', 'anthropic/claude-sonnet-4.6'],
        openai: ['gpt-4.1-mini', 'gpt-4.1'],
        anthropic: ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
        gemini: ['gemini-2.5-flash', 'gemini-3-pro-preview'],
    };
    const executorModel =
        env.LLM_EXECUTOR_MODEL?.trim() ||
        (provider === 'gemini' && env.GEMINI_EXECUTOR_MODEL?.trim()) ||
        defaults[provider][0];
    const advisorModel =
        env.LLM_ADVISOR_MODEL?.trim() ||
        (provider === 'gemini' && env.GEMINI_ADVISOR_MODEL?.trim()) ||
        defaults[provider][1];
    const searchProvider = resolveLlmProvider(
        env.LLM_SEARCH_PROVIDER || (provider === 'gemini' ? 'gemini' : 'openrouter')
    );
    if (searchProvider !== 'openrouter' && searchProvider !== 'gemini') {
        throw new Error('LLM_SEARCH_PROVIDER must be openrouter or gemini.');
    }
    return {
        provider,
        apiKey: env[LLM_KEY_ENV[provider]]?.trim() || '',
        executorModel,
        advisorModel,
        visionModel: env.LLM_VISION_MODEL?.trim() || executorModel,
        searchProvider,
        searchModel: env.LLM_SEARCH_MODEL?.trim() || defaults[searchProvider][0],
    };
}
