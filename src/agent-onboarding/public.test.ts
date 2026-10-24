import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { handleAgentOnboardingRequest } from './public';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(publicOrigin?: string): Promise<string> {
    const server = createServer((request, response) => {
        if (!handleAgentOnboardingRequest(request, response, { publicOrigin })) {
            response.statusCode = 404;
            response.end('other route');
        }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    return `http://127.0.0.1:${address.port}`;
}

describe('agent onboarding public documents', () => {
    it('serves readable HTML without deriving links from Host', async () => {
        const base = await start();
        const response = await fetch(`${base}/agent-onboarding`, { headers: { Host: 'attacker.invalid' } });
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(html).toContain('MVP');
        expect(html).toContain('/agent-onboarding/SKILL.md');
        expect(html).not.toContain('attacker.invalid');
        expect(html).not.toMatch(/(?:api[_-]?key|bearer|token)\s*[:=]/i);
    });

    it('uses only a validated configured public origin', async () => {
        const base = await start('https://docs.example.test');
        const html = await fetch(`${base}/agent-onboarding`).then((response) => response.text());
        expect(html).toContain('https://docs.example.test/agent-onboarding/SKILL.md');
        expect(() =>
            handleAgentOnboardingRequest({ url: '/agent-onboarding', method: 'GET' } as never, {} as never, {
                publicOrigin: 'javascript:alert(1)',
            })
        ).toThrow('publicOrigin must be an HTTP(S) origin');
    });

    it('serves exact Markdown routes with HEAD, caching, and ETags', async () => {
        const base = await start();
        const first = await fetch(`${base}/agent-onboarding/SKILL.md`);
        const body = await first.text();
        const etag = first.headers.get('etag');

        expect(first.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
        expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
        expect(body).toContain('name: open-pipi-onboarding');
        expect(etag).toBeTruthy();

        const head = await fetch(`${base}/agent-onboarding/references/connect.md`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');

        const cached = await fetch(`${base}/agent-onboarding/SKILL.md`, { headers: { 'If-None-Match': etag! } });
        expect(cached.status).toBe(304);
    });

    it('fails closed outside the exact allowlist', async () => {
        const base = await start();
        expect((await fetch(`${base}/agent-onboarding/`)).status).toBe(200);
        expect((await fetch(`${base}/agent-onboarding/toString`)).status).toBe(404);
        expect((await fetch(`${base}/agent-onboarding/%2e%2e/private`)).status).toBe(404);
        const post = await fetch(`${base}/agent-onboarding/SKILL.md`, { method: 'POST' });
        expect(post.status).toBe(405);
        expect(post.headers.get('allow')).toBe('GET, HEAD');
    });

    it('offers identical plain text when an agent viewer cannot read Markdown', async () => {
        const base = await start();
        const markdown = await fetch(`${base}/agent-onboarding/SKILL.md`);
        const plain = await fetch(`${base}/agent-onboarding/SKILL.txt`);
        expect(plain.status).toBe(200);
        expect(plain.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(await plain.text()).toBe(await markdown.text());
        const head = await fetch(`${base}/agent-onboarding/SKILL.txt`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        expect((await fetch(`${base}/agent-onboarding/SKILL.txt`, { method: 'POST' })).status).toBe(405);
    });
});
