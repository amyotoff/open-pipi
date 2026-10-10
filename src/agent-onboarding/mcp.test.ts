import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createOnboardingMcpServer } from './mcp';
import { createAgentOnboardingService } from './service';

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connectClient() {
    const dataDir = mkdtempSync(join(tmpdir(), 'open-pipi-mcp-'));
    const service = createAgentOnboardingService({ dataDir, now: () => new Date('2026-09-09T12:00:00.000Z') });
    const server = createOnboardingMcpServer(service);
    const client = new Client({ name: 'open-pipi-onboarding-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(async () => {
        await client.close();
        await server.close();
    });
    return { client, service };
}

function structuredContent(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeTypeOf('object');
    return result.structuredContent as Record<string, unknown>;
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
    const content = result.content as Array<{ type: string; text?: string }>;
    return content[0]?.text ?? '';
}

describe('experimental onboarding MCP server', () => {
    it('negotiates through the SDK and exposes only state and preview', async () => {
        const { client } = await connectClient();
        const tools = await client.listTools();

        expect(tools.tools.map((tool) => tool.name)).toEqual(['pipi_onboarding_state', 'pipi_onboarding_preview']);
        expect(tools.tools[0].annotations?.readOnlyHint).toBe(true);
        expect(tools.tools[1].annotations?.readOnlyHint).toBe(false);
        expect(tools.tools.some((tool) => /apply|approve|start|auth|credential/i.test(tool.name))).toBe(false);
    });

    it('reads state without changing it', async () => {
        const { client, service } = await connectClient();
        const before = service.readState();
        const result = await client.callTool({ name: 'pipi_onboarding_state', arguments: {} });

        expect(structuredContent(result)).toEqual(before);
        expect(service.readState()).toEqual(before);
    });

    it('persists a preview without applying it', async () => {
        const { client, service } = await connectClient();
        const result = await client.callTool({
            name: 'pipi_onboarding_preview',
            arguments: {
                language: 'en',
                timezone: 'Europe/Rome',
                facts: ['Prefers concise updates'],
                currentTask: 'Review onboarding',
            },
        });
        const preview = structuredContent(result);

        expect(preview.state).toBe('awaiting_confirmation');
        expect(service.readState(preview.previewId as string).state).toBe('awaiting_confirmation');
        expect(service.readState().ownerContext).toBeNull();
    });

    it('returns a safe protocol error for invalid or unknown inputs', async () => {
        const { client } = await connectClient();
        const invalid = await client.callTool({
            name: 'pipi_onboarding_preview',
            arguments: { language: 'en', timezone: 'Europe/Rome', displayName: 'must not be accepted' },
        });
        expect(invalid.isError).toBe(true);
        expect(firstText(invalid)).toContain('VALIDATION_FAILED');

        const unknown = await client.callTool({ name: 'pipi_onboarding_apply', arguments: {} });
        expect(unknown.isError).toBe(true);
        expect(firstText(unknown)).toContain('UNKNOWN_TOOL');
    });
});
