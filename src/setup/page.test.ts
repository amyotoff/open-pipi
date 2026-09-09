import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import type { SetupSafeStatus } from './service';
import { renderSetupPage } from './page';

function setupStatus(overrides: Partial<SetupSafeStatus> = {}): SetupSafeStatus {
    return {
        phase: 'ai',
        metadata: { profilePresent: false },
        provider: {
            status: 'missing',
            kind: 'openrouter',
            model: 'google/gemini-2.5-flash',
            configured: false,
            validated: false,
        },
        telegram: { status: 'missing', configured: false, validated: false, webhookConflict: false },
        owners: { existing: false, count: 0, status: 'missing' },
        pairing: { active: false },
        profile: { initialPack: 'jeeves', currentPack: 'jeeves' },
        runtime: {
            state: 'stopped',
            dataDir: '/private/data',
            background: false,
            message: 'Open PiPi is stopped.',
            dialogueVerified: false,
        },
        background: {
            supported: true,
            platform: 'darwin',
            explanation: 'PiPi is unavailable while this computer sleeps or is turned off.',
        },
        completed: false,
        ...overrides,
    };
}

describe('setup page', () => {
    it('presents the progressive private setup flow in English and Russian', () => {
        const html = renderSetupPage({ status: setupStatus(), csrfToken: 'csrf-test' });

        expect(html).toContain('PiPi starts as Jeeves — your personal assistant.');
        expect(html).toContain('PiPi начинает как Дживс — ваш личный ассистент.');
        expect(html).toContain('standing rules and role later');
        expect(html).toContain('постоянные правила и роль');
        expect(html).toContain('BotFather');
        expect(html).toContain('This is me');
        expect(html).toContain('Оставить работать в фоне');
        expect(html).toContain('cannot work while this computer is asleep or turned off');
    });

    it('keeps both credentials in private fields and posts through the protected local API', () => {
        const html = renderSetupPage({ status: setupStatus(), csrfToken: 'csrf-test' });

        expect(html.match(/type="password"/g)).toHaveLength(2);
        expect(html.match(/<form[^>]+method="post"[^>]+action="\/"/g)).toHaveLength(4);
        expect(html.match(/<fieldset disabled>/g)).toHaveLength(2);
        expect(html).toContain('JavaScript is required for private setup.');
        expect(html).toContain("'X-PiPi-CSRF':sessionToken");
        expect(html).toContain("request('/api/openrouter/key', { key:input.value })");
        expect(html).toContain("request('/api/telegram', { token:input.value })");
        expect(html).toContain("fetch('/api/status'");
        expect(html).not.toContain('Sign in with ChatGPT');
        expect(html).not.toContain('Sign in with Claude');
    });

    it('emits valid JavaScript for the complete inline setup client', () => {
        const html = renderSetupPage({ status: setupStatus(), csrfToken: 'csrf-test' });
        const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

        expect(script).toBeTruthy();
        if (!script) throw new Error('inline setup script is missing');
        expect(() => new Script(script)).not.toThrow();
    });

    it('keeps the owner card optional, bounded, and behind explicit consent', () => {
        const html = renderSetupPage({ status: setupStatus(), csrfToken: 'csrf-test' });

        expect(html).toContain('<details id="profile-card">');
        expect(html).toContain('Optional: tell PiPi a little about you');
        expect(html).toContain('maxlength="1204"');
        expect(html).toContain('maxlength="500"');
        expect(html).toContain('name="consent" required');
        expect(html).toContain("request('/api/profile'");
        expect(html).not.toContain("void request('/api/metadata'");
    });

    it('shows current character metadata without resetting a customized installation', () => {
        const html = renderSetupPage({
            status: setupStatus({
                profile: { initialPack: 'jeeves', currentPack: 'tutor', customized: true },
            }),
            csrfToken: 'csrf-test',
        });

        expect(html).toContain('"currentPack"');
        expect(html).toContain('tutor');
        expect(html).toContain('Your existing choice is preserved.');
        expect(html).not.toContain('/setup apply');
    });

    it('disables connection edits while running and hides completed owner pairing controls', () => {
        const html = renderSetupPage({
            status: setupStatus({
                owners: { existing: true, count: 1, status: 'ready' },
                runtime: {
                    state: 'ready',
                    dataDir: '/private/data',
                    background: false,
                    message: 'Ready.',
                    dialogueVerified: true,
                },
                metadata: { profilePresent: true, preferencesPending: true },
            }),
            csrfToken: 'csrf-test',
        });

        expect(html).toContain('Stop PiPi before changing AI, Telegram, or owner connection settings.');
        expect(html).toContain("document.querySelector('[data-action=pair]').hidden = ownerReady");
        expect(html).toContain("runtimeActive && kind !== 'runtime'");
        expect(html).toContain('Saved. Restart PiPi to apply these changes.');
    });

    it('escapes embedded state and the CSRF token before placing them in script source', () => {
        const html = renderSetupPage({
            status: setupStatus({
                issue: {
                    code: 'provider_auth',
                    message: '</script><script>globalThis.pwned=true</script>',
                    retryable: true,
                    target: 'ai',
                },
            }),
            csrfToken: '</script>',
        });

        expect(html).not.toContain('</script><script>globalThis.pwned=true</script>');
        expect(html).not.toContain('const sessionToken = "</script>"');
        expect(html).toContain('\\u003c/script\\u003e');
    });
});
