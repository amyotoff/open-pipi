import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { renderOnboardingLanding } from './public-page';

export const ONBOARDING_DOCUMENT_FILES = {
    '/agent-onboarding/SKILL.md': 'SKILL.md',
    '/agent-onboarding/SKILL.txt': 'SKILL.md',
    '/agent-onboarding/references/install.md': 'references/install.md',
    '/agent-onboarding/references/connect.md': 'references/connect.md',
    '/agent-onboarding/references/workflow.md': 'references/workflow.md',
    '/agent-onboarding/references/troubleshooting.md': 'references/troubleshooting.md',
} as const;

export interface AgentOnboardingPublicOptions {
    publicOrigin?: string;
    sourceCommit?: string;
}

export type PublicDocument = { contentType: string; body: string };

function normalizePublicOrigin(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const url = new URL(value);
    if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
    )
        throw new Error('publicOrigin must be an HTTP(S) origin');
    return url.origin;
}

/** The same explicit public allowlist backs local HTTP and the Cloudflare artifact. */
export function getOnboardingPublicDocument(
    route: string,
    options: AgentOnboardingPublicOptions = {}
): PublicDocument | undefined {
    if (options.sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(options.sourceCommit)) {
        throw new Error('sourceCommit must be a full Git commit');
    }
    const origin = normalizePublicOrigin(options.publicOrigin);
    if (route === '/' || route === '/agent-onboarding' || route === '/agent-onboarding/') {
        return { contentType: 'text/html; charset=utf-8', body: renderOnboardingLanding(origin) };
    }
    if (Object.hasOwn(ONBOARDING_DOCUMENT_FILES, route)) {
        const file = ONBOARDING_DOCUMENT_FILES[route as keyof typeof ONBOARDING_DOCUMENT_FILES];
        return {
            contentType: route.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
            body: readFileSync(join(__dirname, 'skills/open-pipi-onboarding', file), 'utf8'),
        };
    }
    if (route === '/agent-onboarding/release.json') {
        return {
            contentType: 'application/json; charset=utf-8',
            body:
                JSON.stringify(
                    {
                        schemaVersion: 1,
                        repository: 'https://github.com/amyotoff/open-pipi.git',
                        sourceCommit: options.sourceCommit ?? null,
                        releaseKind: options.sourceCommit ? 'experimental' : 'development',
                    },
                    null,
                    2
                ) + '\n',
        };
    }
    const asset =
        route === '/agent-onboarding/onboarding.css'
            ? 'onboarding.css'
            : route === '/agent-onboarding/onboarding.js'
              ? 'onboarding.js'
              : undefined;
    if (asset) {
        return {
            contentType: asset.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            body: readFileSync(join(__dirname, 'assets', asset), 'utf8'),
        };
    }
    return undefined;
}

export const PUBLIC_ONBOARDING_HEADERS = {
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function handleAgentOnboardingRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: AgentOnboardingPublicOptions = {}
): boolean {
    const route = request.url?.split('?', 1)[0];
    if (!route) return false;
    const document = getOnboardingPublicDocument(route, options);
    if (!document) return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD');
        response.end();
        return true;
    }
    const etag = `"${createHash('sha256').update(document.body).digest('base64url')}"`;
    response.setHeader('Content-Type', document.contentType);
    for (const [key, value] of Object.entries(PUBLIC_ONBOARDING_HEADERS)) response.setHeader(key, value);
    response.setHeader('ETag', etag);
    if (request.headers['if-none-match'] === etag) {
        response.statusCode = 304;
        response.end();
        return true;
    }
    response.statusCode = 200;
    response.setHeader('Content-Length', Buffer.byteLength(document.body));
    response.end(request.method === 'HEAD' ? undefined : document.body);
    return true;
}
