import { beforeEach, describe, expect, it, vi } from 'vitest';

const classifyWithOllama = vi.fn();
vi.mock('./ollama', () => ({ classifyWithOllama }));
vi.mock('../config', () => ({ PIPI_LOCAL_ROUTING_ENABLED: true }));

beforeEach(() => classifyWithOllama.mockReset());

describe('core/local-triage', () => {
    it('routes obvious social messages without a model call', async () => {
        const { classifyMessageRoute } = await import('./local-triage');
        await expect(classifyMessageRoute('Спасибо!')).resolves.toEqual({ route: 'simple', source: 'rule_simple' });
        expect(classifyWithOllama).not.toHaveBeenCalled();
    });

    it('routes tool-shaped requests to the strong model without a local call', async () => {
        const { classifyMessageRoute } = await import('./local-triage');
        await expect(classifyMessageRoute('Сравни эти документы')).resolves.toEqual({
            route: 'complex',
            source: 'rule_complex',
        });
        expect(classifyWithOllama).not.toHaveBeenCalled();
    });

    it('uses local semantic triage and defaults safely to complex', async () => {
        const { classifyMessageRoute } = await import('./local-triage');
        classifyWithOllama.mockResolvedValueOnce('SIMPLE');
        await expect(classifyMessageRoute('Любопытная мысль')).resolves.toEqual({ route: 'simple', source: 'ollama' });

        classifyWithOllama.mockResolvedValueOnce(null);
        await expect(classifyMessageRoute('Неочевидная просьба')).resolves.toEqual({
            route: 'complex',
            source: 'safe_fallback',
        });
    });

    it('joins a group only on an explicit local YES', async () => {
        const { shouldJoinGroupConversation } = await import('./local-triage');
        classifyWithOllama.mockResolvedValueOnce('NO');
        await expect(shouldJoinGroupConversation('ок')).resolves.toBe(false);
        classifyWithOllama.mockResolvedValueOnce('YES');
        await expect(shouldJoinGroupConversation('The deadline moved but the plan is stale')).resolves.toBe(true);
    });
});
