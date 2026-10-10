import { describe, expect, it } from 'vitest';
import { parseOnboardingArguments, startOnboardingDocsServer } from './agent-onboarding';

describe('agent onboarding CLI', () => {
    it('requires an explicit installation data directory for MCP and rejects extra options', () => {
        expect(() => parseOnboardingArguments(['mcp'], '/repo')).toThrow();
        expect(parseOnboardingArguments(['mcp', '--data-dir', '.tmp/pilot'], '/repo')).toEqual({
            mode: 'mcp',
            dataDir: '/repo/.tmp/pilot',
        });
        expect(() => parseOnboardingArguments(['mcp', '--data-dir', 'data', '--token', 'value'], '/repo')).toThrow();
        expect(() => parseOnboardingArguments(['serve', '--port', '99999'], '/repo')).toThrow();
        expect(() => parseOnboardingArguments(['serve', '--port', '0', '--port', '1'], '/repo')).toThrow();
    });

    it('accepts only explicit safe public origins, never credentials or an arbitrary path', () => {
        expect(parseOnboardingArguments(['serve', '--public-origin', 'https://pipi.test'], '/repo')).toEqual({
            mode: 'serve',
            port: 8787,
            publicOrigin: 'https://pipi.test',
        });
        for (const origin of [
            'https://name:secret@pipi.test',
            'https://pipi.test/path',
            'https://pipi.test/?token=value',
            'http://pipi.test',
            'javascript:alert(1)',
        ]) {
            expect(() => parseOnboardingArguments(['serve', '--public-origin', origin], '/repo')).toThrow();
        }
    });

    it('serves public instructions on loopback and exposes no setup API or remote MCP', async () => {
        const server = await startOnboardingDocsServer({ port: 0 });
        try {
            const response = await fetch(server.url);
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/html');
            expect(await response.text()).toContain('PiPi');
            const origin = new URL(server.url).origin;
            for (const route of ['/api/status', '/api/agent-onboarding/confirm', '/mcp']) {
                expect((await fetch(`${origin}${route}`)).status).toBe(404);
            }
        } finally {
            await server.close();
        }
    });
});
