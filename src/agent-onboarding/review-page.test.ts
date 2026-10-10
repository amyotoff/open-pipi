import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { renderAgentOnboardingReviewPage } from './review-page';
import type { AgentOnboardingState } from './service';

function pendingState(): AgentOnboardingState {
    return {
        schemaVersion: 1,
        state: 'awaiting_confirmation',
        ownerContext: null,
        preview: {
            schemaVersion: 1,
            previewId: 'synthetic-preview',
            previewHash: 'synthetic-hash',
            createdAt: '2026-09-09T10:00:00.000Z',
            expiresAt: '2026-09-09T10:30:00.000Z',
            baseRevision: null,
            ownerContext: { language: 'en', timezone: 'UTC' },
            diff: [],
            effects: { ownerContextWrite: true, runtimeCalls: false, providerCalls: false },
            state: 'awaiting_confirmation',
        },
    };
}

describe('agent onboarding review page', () => {
    it('reuses the same confirmation request after a lost response', async () => {
        const html = renderAgentOnboardingReviewPage({ state: pendingState(), csrfToken: 'synthetic-csrf' });
        const requests: unknown[] = [];
        let click: () => Promise<void> = async () => undefined;
        let removed = false;
        const button = {
            disabled: false,
            addEventListener: (_event: string, callback: () => Promise<void>) => {
                click = callback;
            },
            remove: () => {
                removed = true;
            },
        };
        const result = { textContent: '' };
        const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
        runInNewContext(script, {
            document: { getElementById: (id: string) => (id === 'confirm' ? button : result) },
            fetch: async (_url: string, options: { body: string }) => {
                requests.push(JSON.parse(options.body));
                if (requests.length === 1) throw new Error('Synthetic lost response');
                return { ok: true, json: async () => ({ result: { state: 'applied' } }) };
            },
        });
        await click();
        expect(button.disabled).toBe(false);
        await click();
        expect(requests).toHaveLength(2);
        expect(requests[0]).toEqual(requests[1]);
        expect(removed).toBe(true);
    });

    it('does not offer confirmation for an expired or already saved preview', () => {
        for (const stateName of ['expired', 'applied'] as const) {
            const state = pendingState();
            state.state = stateName;
            state.preview!.state = stateName;
            state.currentMatchesPreview = false;
            const html = renderAgentOnboardingReviewPage({ state, csrfToken: 'synthetic' });
            expect(html).not.toContain('id="confirm"');
            if (stateName === 'applied') expect(html).toContain('the current context has changed');
        }
    });

    it('shows the exact preview and escapes owner-controlled values', () => {
        const html = renderAgentOnboardingReviewPage({
            csrfToken: '</script><script>bad()</script>',
            state: {
                schemaVersion: 1,
                state: 'awaiting_confirmation',
                ownerContext: null,
                preview: {
                    schemaVersion: 1,
                    previewId: 'preview_<unsafe>',
                    previewHash: 'hash_123',
                    createdAt: '2026-09-09T10:00:00.000Z',
                    expiresAt: '2026-09-09T10:30:00.000Z',
                    baseRevision: null,
                    ownerContext: {
                        language: 'en',
                        timezone: 'Europe/Rome',
                        facts: ['<img src=x onerror=bad()>'],
                        currentTask: 'Plan',
                    },
                    diff: [{ field: 'facts', before: [], after: ['<b>private</b>'] }],
                    effects: { ownerContextWrite: true, runtimeCalls: false, providerCalls: false },
                    state: 'awaiting_confirmation',
                },
            },
        });

        expect(html).toContain('preview_&lt;unsafe&gt;');
        expect(html).toContain('&lt;img src=x onerror=bad()&gt;');
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('</script><script>bad()');
        expect(html).toContain('runtimeCalls');
        expect(html).toContain('Confirm and save');
    });
});
