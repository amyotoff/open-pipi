import { describe, expect, it } from 'vitest';
import { renderOnboardingLanding } from './public-page';

const repository = 'https://github.com/amyotoff/open-pipi';

describe('agent onboarding experiment landing', () => {
    it('renders accessible client and scenario contracts with the official repository visible', () => {
        const html = renderOnboardingLanding('https://install.example.test');
        expect(html).toContain('id="client"');
        expect(html).toContain('for="client"');
        expect(html).toContain('value="claude-code"');
        expect(html).toContain('value="codex"');
        expect(html).toContain('value="antigravity"');
        expect(html).toContain('id="scenario"');
        for (const scenario of ['macos', 'linux', 'windows', 'rpi', 'vps', 'update']) {
            expect(html).toContain(`value="${scenario}"`);
        }
        expect(html).toContain(`id="repository-link" href="${repository}">${repository}</a>`);
        expect(html).toContain('id="prompt"');
        expect(html).toContain('id="copy"');
        expect(html).toContain('id="copy-status"');
        expect(html).toContain('id="skill-link"');
        expect(html).toContain('id="language"');
    });

    it('keeps the no-JavaScript handoff honest and uses absolute instruction URLs in the initial prompt', () => {
        const configured = renderOnboardingLanding('https://install.example.test');
        expect(configured).toContain('https://install.example.test/agent-onboarding/SKILL.md');
        expect(configured).toContain('https://install.example.test/agent-onboarding/SKILL.txt');
        expect(configured).toMatch(/<noscript>[\s\S]*Codex, Claude Code или Antigravity/);
        expect(configured).toMatch(/<noscript>[\s\S]*https:\/\/github\.com\/amyotoff\/open-pipi/);

        const unconfigured = renderOnboardingLanding();
        const textarea = unconfigured.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1] || '';
        expect(textarea).not.toContain('/blob/main/');
        expect(textarea).toContain('полный адрес');
        expect(textarea).toContain(repository);
        expect(textarea).not.toContain('attacker.invalid');
    });
});
