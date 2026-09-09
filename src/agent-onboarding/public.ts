import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

const ROUTE_FILES = {
    '/agent-onboarding/SKILL.md': 'SKILL.md',
    '/agent-onboarding/references/connect.md': 'references/connect.md',
    '/agent-onboarding/references/workflow.md': 'references/workflow.md',
} as const;

type DocumentRoute = keyof typeof ROUTE_FILES;

export interface AgentOnboardingPublicOptions {
    publicOrigin?: string;
}

function normalizePublicOrigin(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const url = new URL(value);
    if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error('publicOrigin must be an HTTP(S) origin');
    }
    if (url.pathname !== '/') throw new Error('publicOrigin must not contain a path');
    return url.origin;
}

function skillFile(relativePath: string): string {
    return readFileSync(join(__dirname, 'skills/open-pipi-onboarding', relativePath), 'utf8');
}

function absoluteOrRelative(origin: string | undefined, path: string): string {
    return origin ? new URL(path, origin).toString() : path;
}

function renderPage(origin: string | undefined): string {
    const skillUrl = absoluteOrRelative(origin, '/agent-onboarding/SKILL.md');
    const connectUrl = absoluteOrRelative(origin, '/agent-onboarding/references/connect.md');
    const workflowUrl = absoluteOrRelative(origin, '/agent-onboarding/references/workflow.md');
    const prompt = `Read ${skillUrl} and help me prepare Open PiPi onboarding. Show the preview first. Do not apply changes, start services, or ask for credentials.`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open PiPi agent onboarding</title><style>
:root{color-scheme:light dark;--bg:#f4f1e8;--ink:#17221c;--card:#fffdf6;--accent:#256b4b;--line:#b9c6b8}*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at top,#dcebd8,var(--bg) 50%);color:var(--ink);font:17px/1.55 system-ui,sans-serif}
main{max-width:760px;margin:auto;padding:64px 24px}article{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:clamp(24px,6vw,52px);box-shadow:0 18px 60px #163b2420}
h1{font:700 clamp(2.2rem,7vw,4.6rem)/.96 Georgia,serif;letter-spacing:-.04em;margin:.15em 0 .4em}.eyebrow{color:var(--accent);font-weight:750;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem}
.prompt{width:100%;min-height:132px;padding:16px;border:1px solid var(--line);border-radius:12px;background:#ffffffb8;color:#17221c;font:14px/1.5 ui-monospace,monospace}button{margin-top:10px;border:0;border-radius:999px;background:var(--accent);color:white;padding:12px 18px;font-weight:700;cursor:pointer}
a{color:var(--accent)}li{margin:.45em 0}.note{border-left:4px solid var(--accent);padding-left:14px;color:#405247}@media(prefers-color-scheme:dark){:root{--bg:#101612;--ink:#edf2ea;--card:#182019;--accent:#8ed0a9;--line:#3d5242}.prompt{background:#101612;color:#edf2ea}}
</style></head><body><main><article><div class="eyebrow">Experimental · local stdio</div><h1>Set up Open PiPi with your coding agent</h1>
<p>This guide helps an agent inspect local onboarding state and prepare a reviewable preview. Applying that preview remains a separate, human-only setup step.</p>
<h2>Agent prompt</h2><textarea id="prompt" class="prompt" readonly>${escapeHtml(prompt)}</textarea><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('prompt').value)">Copy prompt</button>
<noscript><p>The prompt above remains selectable without JavaScript.</p></noscript>
<h2>What happens</h2><ol><li>Your agent reads the skill and checks whether the local MCP server is connected.</li><li>It reads local onboarding state and prepares a preview.</li><li>You review the preview and use the private setup flow if you choose to apply it.</li></ol>
<p class="note">This experimental surface exposes no credential, approval, apply, startup, or remote MCP operation.</p>
<h2>Documentation</h2><ul><li><a href="${escapeHtml(skillUrl)}">Skill</a></li><li><a href="${escapeHtml(connectUrl)}">Connection guide</a></li><li><a href="${escapeHtml(workflowUrl)}">Workflow and errors</a></li></ul>
</article></main></body></html>`;
}

function escapeHtml(value: string): string {
    return value.replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
    );
}

function send(request: IncomingMessage, response: ServerResponse, contentType: string, body: string): void {
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'public, max-age=300');
    response.setHeader('ETag', etag);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.headers['if-none-match'] === etag) {
        response.statusCode = 304;
        response.end();
        return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(request.method === 'HEAD' ? undefined : body);
}

export function handleAgentOnboardingRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: AgentOnboardingPublicOptions = {}
): boolean {
    const rawPath = request.url?.split('?', 1)[0];
    if (!rawPath || (rawPath !== '/agent-onboarding' && !(rawPath in ROUTE_FILES))) return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD');
        response.end();
        return true;
    }
    const origin = normalizePublicOrigin(options.publicOrigin);
    if (rawPath === '/agent-onboarding') {
        send(request, response, 'text/html; charset=utf-8', renderPage(origin));
    } else {
        send(request, response, 'text/markdown; charset=utf-8', skillFile(ROUTE_FILES[rawPath as DocumentRoute]));
    }
    return true;
}
