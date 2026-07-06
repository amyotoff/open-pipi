import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY } from '../config';
import { reportOperationalFailure, reportOperationalRecovery } from './failure-monitor';

let ai: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
    if (!ai) {
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }
    return ai;
}

export interface SearchResult {
    title: string;
    link: string;
    snippet: string;
}

/**
 * Fast web search using Gemini's native Google Search grounding.
 * Returns a synthesized answer + source list.
 * No CAPTCHA, no scraping — uses the actual Google Search index.
 */
export async function searchWeb(query: string): Promise<SearchResult[]> {
    try {
        const response = await getGeminiClient().models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: query }] }],
            config: {
                tools: [{ googleSearch: {} }],
                temperature: 0.1,
            },
        });

        const text = response.text || '';
        const groundingMeta = (response as any).candidates?.[0]?.groundingMetadata;
        const sources: SearchResult[] = [];

        // Extract grounding sources
        if (groundingMeta?.groundingChunks) {
            for (const chunk of groundingMeta.groundingChunks) {
                if (chunk.web?.uri) {
                    sources.push({
                        title: chunk.web.title || chunk.web.uri,
                        link: chunk.web.uri,
                        snippet: text.substring(0, 300), // main answer as snippet for first source
                    });
                }
            }
        }

        // If no sources extracted but we have a text answer, wrap it
        if (sources.length === 0 && text) {
            sources.push({
                title: `Google Search: ${query}`,
                link: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
                snippet: text,
            });
        }

        reportOperationalRecovery('search');
        return sources.slice(0, 5);
    } catch (error: any) {
        console.error('[SEARCH] Gemini grounding search failed:', error.message);
        reportOperationalFailure('search', error.message);
        return [];
    }
}

/**
 * Search and return a synthesized text answer (for use in handlers).
 */
export async function searchAndSummarize(query: string): Promise<string> {
    try {
        const response = await getGeminiClient().models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: query }] }],
            config: {
                tools: [{ googleSearch: {} }],
                temperature: 0.1,
            },
        });

        const text = response.text || 'Не удалось найти информацию.';
        const groundingMeta = (response as any).candidates?.[0]?.groundingMetadata;
        const sources: string[] = [];

        if (groundingMeta?.groundingChunks) {
            for (const chunk of groundingMeta.groundingChunks) {
                if (chunk.web?.uri) {
                    sources.push(`• ${chunk.web.title || chunk.web.uri}: ${chunk.web.uri}`);
                }
            }
        }

        const sourceBlock = sources.length > 0 ? `\n\nИсточники:\n${sources.slice(0, 5).join('\n')}` : '';

        reportOperationalRecovery('search');
        return text + sourceBlock;
    } catch (error: any) {
        console.error('[SEARCH] Gemini grounding failed:', error.message);
        reportOperationalFailure('search', error.message);
        return `Ошибка поиска: ${error.message || 'не удалось выполнить веб-поиск.'}`;
    }
}
