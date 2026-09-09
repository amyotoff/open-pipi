import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { AgentOnboardingError, type AgentOnboardingService } from './service';

const STATE_TOOL = 'pipi_onboarding_state';
const PREVIEW_TOOL = 'pipi_onboarding_preview';

const stateInputSchema = {
    type: 'object' as const,
    properties: { previewId: { type: 'string' as const, minLength: 1 } },
    additionalProperties: false,
};

const previewInputSchema = {
    type: 'object' as const,
    properties: {
        language: { type: 'string' as const, minLength: 1 },
        timezone: { type: 'string' as const, minLength: 1 },
        facts: { type: 'array' as const, items: { type: 'string' as const } },
        currentTask: { type: 'string' as const },
    },
    required: ['language', 'timezone'],
    additionalProperties: false,
};

function structured(value: Record<string, unknown>) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    };
}

function toolError(error: unknown) {
    const known = error instanceof AgentOnboardingError;
    const payload = {
        error: {
            code: known ? error.code : 'INTERNAL_ERROR',
            message: known ? error.message : 'Open PiPi onboarding operation failed',
        },
    };
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        isError: true,
    };
}

function readPreviewId(argumentsValue: unknown): string | undefined {
    if (argumentsValue === undefined) return undefined;
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
        throw new AgentOnboardingError('VALIDATION_FAILED', 'Input must be an object');
    }
    const entries = Object.entries(argumentsValue);
    if (entries.some(([key]) => key !== 'previewId')) {
        throw new AgentOnboardingError('VALIDATION_FAILED', 'Unknown input field');
    }
    const previewId = (argumentsValue as { previewId?: unknown }).previewId;
    if (previewId !== undefined && (typeof previewId !== 'string' || previewId.length === 0)) {
        throw new AgentOnboardingError('VALIDATION_FAILED', 'previewId must be a non-empty string');
    }
    return previewId;
}

export function createOnboardingMcpServer(service: AgentOnboardingService): Server {
    const server = new Server(
        { name: 'open-pipi-onboarding', version: '0.1.0' },
        {
            capabilities: { tools: {} },
            instructions:
                'Read local owner onboarding state and create reviewable previews. This server cannot approve, apply, start services, authenticate, or accept credentials.',
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: STATE_TOOL,
                title: 'Read Open PiPi onboarding state',
                description: 'Read local owner-context onboarding state. Does not check runtime readiness.',
                inputSchema: stateInputSchema,
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            },
            {
                name: PREVIEW_TOOL,
                title: 'Preview Open PiPi owner context',
                description: 'Validate and persist a local, non-applying owner-context preview for human review.',
                inputSchema: previewInputSchema,
                annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            },
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            if (request.params.name === STATE_TOOL) {
                return structured(
                    service.readState(readPreviewId(request.params.arguments)) as unknown as Record<string, unknown>
                );
            }
            if (request.params.name === PREVIEW_TOOL) {
                return structured(service.preview(request.params.arguments) as unknown as Record<string, unknown>);
            }
            return {
                content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'UNKNOWN_TOOL' } }) }],
                isError: true,
            };
        } catch (error) {
            return toolError(error);
        }
    });

    return server;
}
