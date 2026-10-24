import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgentOnboardingService, type AgentOnboardingPreview, type AgentOnboardingState } from './service';
import { readOwnerContext } from '../setup/owner-context';
import { startSetupServer } from '../setup/server';
import type { SetupService } from '../setup/service';

describe('onboarding process smoke', () => {
    it('previews over stdio, confirms through the private session, and recovers from a new MCP process', async () => {
        const scratchRoot = path.join(process.cwd(), '.tmp');
        fs.mkdirSync(scratchRoot, { recursive: true });
        const dataDir = fs.mkdtempSync(path.join(scratchRoot, 'onboarding-smoke-'));
        const clients: Client[] = [];
        const connect = async () => {
            const client = new Client({ name: 'open-pipi-onboarding-smoke', version: '1.0.0' });
            clients.push(client);
            await client.connect(
                new StdioClientTransport({
                    command: process.execPath,
                    args: [
                        '-r',
                        'ts-node/register',
                        path.join(process.cwd(), 'src/scripts/agent-onboarding.ts'),
                        'mcp',
                        '--data-dir',
                        dataDir,
                    ],
                    cwd: process.cwd(),
                    stderr: 'pipe',
                })
            );
            return client;
        };
        let server: Awaited<ReturnType<typeof startSetupServer>> | undefined;
        try {
            const client = await connect();
            const tools = await client.listTools();
            expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
                'pipi_onboarding_preview',
                'pipi_onboarding_state',
            ]);
            const draft = {
                language: 'ru',
                timezone: 'Europe/Rome',
                facts: ['Synthetic pilot: prefers short replies'],
                currentTask: 'Plan a synthetic demo week',
            };
            const reply = await client.callTool({ name: 'pipi_onboarding_preview', arguments: draft });
            expect(reply.isError).not.toBe(true);
            const preview = reply.structuredContent as unknown as AgentOnboardingPreview;
            expect(preview.state).toBe('awaiting_confirmation');
            expect(readOwnerContext(dataDir)).toBeNull();
            const forbidden = await client.callTool({
                name: 'pipi_onboarding_apply',
                arguments: { previewId: preview.previewId, approved: true },
            });
            expect(forbidden.isError).toBe(true);
            expect(readOwnerContext(dataDir)).toBeNull();

            // Only status is needed from setup in this provider-free fixture. All proposal,
            // file storage, HTTP session/Origin/CSRF, and MCP behavior are real application code.
            const setup = { status: async () => ({ phase: 'ai' }) } as unknown as SetupService;
            let csrf = '';
            server = await startSetupServer({
                service: setup,
                onboarding: createAgentOnboardingService({ dataDir }),
                renderSetupPage: ({ csrfToken }) => {
                    csrf = csrfToken;
                    return '<p>Synthetic smoke fixture</p>';
                },
            });
            const reviewPath = `/agent-onboarding/review?previewId=${preview.previewId}`;
            expect((await fetch(`${server.origin}${reviewPath}`)).status).toBe(401);
            const bootstrap = await fetch(server.url, { redirect: 'manual' });
            const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
            await fetch(`${server.origin}/`, { headers: { cookie } });
            const review = await fetch(`${server.origin}${reviewPath}`, { headers: { cookie } });
            expect(review.status).toBe(200);
            expect(review.headers.get('cache-control')).toBe('no-store');
            expect(await review.text()).toContain(draft.facts[0]);
            expect(readOwnerContext(dataDir)).toBeNull();

            const input = {
                previewId: preview.previewId,
                previewHash: preview.previewHash,
                idempotencyKey: 'synthetic-smoke-confirmation',
            };
            const confirm = () =>
                fetch(`${server!.origin}/api/agent-onboarding/confirm`, {
                    method: 'POST',
                    headers: {
                        cookie,
                        origin: server!.origin,
                        'x-pipi-csrf': csrf,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify(input),
                });
            const response = await confirm();
            expect(response.status).toBe(200);
            const applied = await response.json();
            expect(readOwnerContext(dataDir)).toMatchObject(draft);
            expect(await (await confirm()).json()).toEqual(applied);
            const savedRevision = readOwnerContext(dataDir)!.revision;

            await client.close();
            const resumed = await connect();
            const read = await resumed.callTool({
                name: 'pipi_onboarding_state',
                arguments: { previewId: preview.previewId },
            });
            const state = read.structuredContent as unknown as AgentOnboardingState;
            expect(state.state).toBe('applied');
            expect(state.ownerContext?.revision).toBe(savedRevision);
        } finally {
            await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
            await server?.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
