import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, makeDbModuleMock } from '../test-helpers/mock-db';

let db: Database.Database;

async function loadModule<T>(modulePath: string, setupMocks: () => void): Promise<T> {
    vi.resetModules();
    vi.doMock('../db', () => makeDbModuleMock(db));
    setupMocks();
    return (await import(modulePath)) as T;
}

beforeEach(() => {
    db = createTestDb();
});

afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('External-facing skills', () => {
    it('browsing skill enforces approval and can read a page with safe mocks', async () => {
        const requireToolApproval = vi
            .fn()
            .mockReturnValueOnce('[TOOL_RESULT] approval required')
            .mockReturnValueOnce(null);
        const searchAndSummarize = vi.fn(async () => 'Search summary');
        const assertSafeBrowserUrl = vi.fn(async (url: string) => url);
        const newPage = vi.fn(async () => ({
            setDefaultNavigationTimeout: vi.fn(),
            goto: vi.fn(),
            evaluate: vi.fn(async () => 'Useful article text'),
            close: vi.fn(),
        }));
        const withBrowserContext = vi.fn(async (action: any) => action({ newPage }));

        const { default: skill } = await loadModule<any>('./browsing.skill', () => {
            vi.doMock('../utils/approvals', () => ({ requireToolApproval }));
            vi.doMock('../utils/search', () => ({ searchAndSummarize }));
            vi.doMock('../utils/browser', () => ({ assertSafeBrowserUrl, withBrowserContext }));
        });

        expect(await skill.handlers.web_search({ query: 'rome restaurants' })).toContain('Search summary');
        expect(await skill.handlers.browse_web({ url: 'https://example.com' }, { chatId: 'c', userId: 'u' })).toContain(
            'approval required'
        );
        expect(await skill.handlers.browse_web({ url: 'https://example.com' }, { chatId: 'c', userId: 'u' })).toContain(
            '<WEB_CONTENT>'
        );
    });

    it('webrun skill enforces approval and can complete a mocked research loop', async () => {
        const requireToolApproval = vi
            .fn()
            .mockReturnValueOnce('[TOOL_RESULT] approval required')
            .mockReturnValue(null);
        const searchAndSummarize = vi.fn(async () => 'Grounded search result');
        const assertSafeBrowserUrl = vi.fn(async (url: string) => url);
        const withBrowserContext = vi.fn(async (action: any) =>
            action({
                newPage: async () => ({
                    setExtraHTTPHeaders: vi.fn(),
                    setViewportSize: vi.fn(),
                    setDefaultNavigationTimeout: vi.fn(),
                    goto: vi.fn(),
                    waitForTimeout: vi.fn(),
                    evaluate: vi.fn(async () => 'Full page text'),
                    close: vi.fn(),
                }),
            })
        );

        const generateContent = vi
            .fn()
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
                functionCalls: [
                    { name: 'web_search', args: { query: 'best espresso rome' } },
                    { name: 'read_page', args: { url: 'https://example.com' } },
                ],
            })
            .mockResolvedValueOnce({
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
                functionCalls: [],
                text: 'Final report with links',
            });

        const { default: skill } = await loadModule<any>('./webrun.skill', () => {
            vi.doMock('../utils/approvals', () => ({ requireToolApproval }));
            vi.doMock('../utils/search', () => ({ searchAndSummarize }));
            vi.doMock('../utils/browser', () => ({ assertSafeBrowserUrl, withBrowserContext }));
            vi.doMock('../config', () => ({ GEMINI_API_KEY: 'test-key' }));
            vi.doMock('@google/genai', () => ({
                GoogleGenAI: class {
                    models = { generateContent };
                },
                Type: { OBJECT: 'object', STRING: 'string' },
            }));
        });

        expect(
            await skill.handlers.webrun_execute({ task: 'Find the best espresso bar' }, { chatId: 'c', userId: 'u' })
        ).toContain('approval required');
        expect(
            await skill.handlers.webrun_execute({ task: 'Find the best espresso bar' }, { chatId: 'c', userId: 'u' })
        ).toContain('Final report with links');
        expect(generateContent).toHaveBeenCalledTimes(2);
    });
});
