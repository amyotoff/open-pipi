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
    const defaultNativeProvider = provider === 'openrouter' ? 'gemini' : provider;
    const toolsProvider = resolveLlmProvider(env.LLM_TOOLS_PROVIDER || defaultNativeProvider);
    const visionProvider = resolveLlmProvider(env.LLM_VISION_PROVIDER || defaultNativeProvider);
    const searchProvider = resolveLlmProvider(env.LLM_SEARCH_PROVIDER || 'gemini');
    if (searchProvider !== 'openrouter' && searchProvider !== 'gemini') {
        throw new Error('LLM_SEARCH_PROVIDER must be openrouter or gemini.');
    }
    const defaultModel = (selectedProvider: LLMProvider) =>
        (selectedProvider === 'gemini' && env.GEMINI_EXECUTOR_MODEL?.trim()) || defaults[selectedProvider][0];
    return {
        provider,
        apiKey: env[LLM_KEY_ENV[provider]]?.trim() || '',
        executorModel,
        advisorModel,
        toolsProvider,
        toolsModel:
            env.LLM_TOOLS_MODEL?.trim() || (toolsProvider === provider ? executorModel : defaultModel(toolsProvider)),
        visionProvider,
        visionModel:
            env.LLM_VISION_MODEL?.trim() ||
            (visionProvider === provider ? executorModel : defaultModel(visionProvider)),
        searchProvider,
        searchModel: env.LLM_SEARCH_MODEL?.trim() || defaultModel(searchProvider),
    };
}
