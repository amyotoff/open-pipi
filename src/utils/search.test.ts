import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchAndSummarize, searchWeb } from './search';
import { generateLLM } from '../core/llm-gateway';
import { guardLLMCall } from '../core/healthcheck';
import { logTokenUsage } from '../db';

vi.mock('../config', () => ({ LLM_CONFIG: { searchProvider: 'openrouter', searchModel: 'search/model' } }));
vi.mock('../core/llm-gateway', () => ({ generateLLM: vi.fn() }));
vi.mock('../core/healthcheck', () => ({ guardLLMCall: vi.fn(() => null) }));
vi.mock('../db', () => ({ logTokenUsage: vi.fn() }));
vi.mock('./failure-monitor', () => ({ reportOperationalFailure: vi.fn(), reportOperationalRecovery: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const reply = {
    text: 'Evidence.',
    sources: [{ title: 'Source', url: 'https://example.org' }],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 },
    toolCalls: [],
    message: { role: 'assistant' as const, content: 'Evidence.' },
};

describe('provider-neutral web search', () => {
    it('works with OpenRouter alone and accounts for search spend', async () => {
        vi.mocked(generateLLM).mockResolvedValue(reply);
        expect(await searchWeb('news')).toEqual([
            { title: 'Source', link: 'https://example.org', snippet: 'Evidence.' },
        ]);
        expect(generateLLM).toHaveBeenCalledWith(
            expect.objectContaining({ provider: 'openrouter', model: 'search/model', webSearch: true })
        );
        expect(logTokenUsage).toHaveBeenCalledWith('search/model', 10, 5, undefined, 0.02);
        expect(await searchAndSummarize('news')).toContain('https://example.org');
    });
    it('does not disguise an uncited answer as a sourced search result', async () => {
        vi.mocked(generateLLM).mockResolvedValue({ ...reply, sources: [] });
        expect(await searchWeb('news')).toEqual([]);
        expect(await searchAndSummarize('news')).toContain('no cited sources');
    });
    it('respects the cost guard before sending a request', async () => {
        vi.mocked(guardLLMCall).mockReturnValueOnce('Daily budget exhausted');
        expect(await searchAndSummarize('news')).toContain('Daily budget exhausted');
        expect(generateLLM).not.toHaveBeenCalled();
    });
    it('returns a capability error if optional search credentials are missing', async () => {
        vi.mocked(generateLLM).mockRejectedValue(new Error('OPENROUTER_API_KEY is not configured'));
        expect(await searchAndSummarize('news')).toContain('OPENROUTER_API_KEY is not configured');
        expect(logTokenUsage).not.toHaveBeenCalled();
    });
});
