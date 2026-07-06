import { SandboxErrorResponse, SandboxPackToolRequest, SandboxPackToolResponse } from './sandbox-contract';

function getSandboxdUrl(): string {
    return process.env.SANDBOXD_URL || 'http://sandboxd:4100';
}

function getSandboxdToken(): string {
    return process.env.SANDBOXD_TOKEN || '';
}

export class SandboxClientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SandboxClientError';
    }
}

export async function runPackToolViaSandboxd(request: SandboxPackToolRequest): Promise<SandboxPackToolResponse> {
    const sandboxdToken = getSandboxdToken();
    if (!sandboxdToken || sandboxdToken === 'change-me') {
        throw new SandboxClientError('SANDBOXD_TOKEN must be configured with a strong non-default value.');
    }

    const timeoutMs = Math.max(5000, (request.sandbox?.timeout_ms || 15000) + 3000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${getSandboxdUrl()}/run-pack-tool`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${sandboxdToken}`,
            },
            body: JSON.stringify(request),
            signal: controller.signal,
        });

        const rawBody = await response.text();
        let payload: SandboxPackToolResponse | SandboxErrorResponse | null = null;
        try {
            payload = rawBody ? (JSON.parse(rawBody) as SandboxPackToolResponse | SandboxErrorResponse) : null;
        } catch {
            payload = null;
        }

        if (!response.ok || !payload || payload.ok !== true) {
            const errorMessage =
                payload && payload.ok === false
                    ? payload.error
                    : `sandboxd request failed with status ${response.status}`;
            throw new SandboxClientError(errorMessage);
        }

        return payload;
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            throw new SandboxClientError(`sandboxd request timed out after ${timeoutMs}ms.`);
        }

        if (error instanceof SandboxClientError) {
            throw error;
        }

        throw new SandboxClientError(error?.message || 'sandboxd request failed.');
    } finally {
        clearTimeout(timeout);
    }
}
