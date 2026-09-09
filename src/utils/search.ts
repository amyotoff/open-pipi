import { LLM_CONFIG } from '../config';
import { generateLLM } from '../core/llm-gateway';
import { guardLLMCall } from '../core/healthcheck';
import { logTokenUsage } from '../db';
import { reportOperationalFailure, reportOperationalRecovery } from './failure-monitor';

export interface SearchResult {
    title: string;
    link: string;
    snippet: string;
}

/** Search is a separate capability: native Gemini grounding by default, or explicit OpenRouter web search. */
async function search(query: string) {
    const blocked = guardLLMCall();
    if (blocked) throw new Error(blocked);
    const response = await generateLLM({
        provider: LLM_CONFIG.searchProvider,
        model: LLM_CONFIG.searchModel,
        messages: [{ role: 'user', content: `Search the web for current evidence and cite sources: ${query}` }],
        webSearch: true,
        temperature: 0.1,
    });
    logTokenUsage(
        LLM_CONFIG.searchModel,
        response.usage.inputTokens,
        response.usage.outputTokens,
        undefined,
        response.usage.costUsd
    );
    // Never fabricate a search URL to make an ungrounded model answer look sourced.
    if (!response.sources.length) throw new Error('Web search returned no cited sources.');
    reportOperationalRecovery('search');
    return response;
}

export async function searchWeb(query: string): Promise<SearchResult[]> {
    try {
        const response = await search(query);
        return response.sources.slice(0, 5).map((source) => ({
            title: source.title,
            link: source.url,
            snippet: response.text.substring(0, 300),
        }));
    } catch (error: any) {
        reportOperationalFailure('search', error.message);
        return [];
    }
}

export async function searchAndSummarize(query: string): Promise<string> {
    try {
        const response = await search(query);
        const sources = response.sources.slice(0, 5).map((source) => `• ${source.title}: ${source.url}`);
        return `${response.text}\n\nИсточники:\n${sources.join('\n')}`;
    } catch (error: any) {
        reportOperationalFailure('search', error.message);
        return `Ошибка поиска: ${error.message || 'не удалось выполнить веб-поиск.'}`;
    }
}
