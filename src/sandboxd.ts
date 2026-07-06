import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import {
    addSpanAttributes,
    initializeOpenTelemetry,
    recordActiveSpanException,
    shutdownOpenTelemetry,
    withSpan,
} from './observability';
import { SandboxErrorResponse, SandboxPackToolRequest } from './core/sandbox-contract';

const APP_VERSION = process.env.npm_package_version || '2.5.0';
const SANDBOXD_PORT = Number(process.env.SANDBOXD_PORT || 4100);
const SANDBOXD_TOKEN = process.env.SANDBOXD_TOKEN || '';
const SANDBOXD_MAX_IN_FLIGHT = Math.max(1, Number(process.env.SANDBOXD_MAX_IN_FLIGHT || 2));

let activeRuns = 0;
let server: Server | null = null;
let shuttingDown = false;

function sendError(res: Response, status: number, error: string): void {
    const body: SandboxErrorResponse = { ok: false, error };
    res.status(status).json(body);
}

function verifyAuth(req: Request, res: Response, next: () => void): void {
    if (!SANDBOXD_TOKEN) {
        sendError(res, 500, 'sandboxd token is not configured.');
        return;
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${SANDBOXD_TOKEN}`) {
        sendError(res, 401, 'Unauthorized.');
        return;
    }

    next();
}

function tryAcquireExecutionSlot(): boolean {
    if (activeRuns >= SANDBOXD_MAX_IN_FLIGHT) {
        return false;
    }

    activeRuns += 1;
    return true;
}

function releaseExecutionSlot(): void {
    activeRuns = Math.max(0, activeRuns - 1);
}

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[SANDBOXD] Received ${signal}, shutting down gracefully...`);

    if (server) {
        await new Promise<void>((resolve) => {
            server?.close(() => resolve());
        });
    }

    try {
        await shutdownOpenTelemetry();
    } catch (error) {
        console.error('[SANDBOXD] Failed to flush OpenTelemetry cleanly:', error);
    } finally {
        process.exit(0);
    }
}

async function startSandboxd(): Promise<void> {
    await initializeOpenTelemetry({
        serviceName: 'open-pipi-sandboxd',
        serviceNamespace: 'open-pipi',
        serviceVersion: APP_VERSION,
    });

    const [{ default: express }, sandboxRunner] = await Promise.all([
        import('express'),
        import('./core/sandbox-runner'),
    ]);
    const { assertSandboxRunnerConfig, runPackToolInSandbox, SandboxRunnerError } = sandboxRunner;

    if (!SANDBOXD_TOKEN || SANDBOXD_TOKEN === 'change-me') {
        throw new Error('SANDBOXD_TOKEN must be set to a strong non-default value.');
    }

    assertSandboxRunnerConfig();

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '512kb' }));

    app.get('/health', (_req, res) => {
        res.json({ ok: true, active_runs: activeRuns, max_in_flight: SANDBOXD_MAX_IN_FLIGHT });
    });

    app.post('/run-pack-tool', verifyAuth, async (req, res) => {
        const body = req.body as SandboxPackToolRequest | undefined;
        if (!body?.tool_name || !body?.project_root || !body?.relative_tool_path) {
            sendError(res, 400, 'tool_name, project_root, and relative_tool_path are required.');
            return;
        }

        if (!tryAcquireExecutionSlot()) {
            sendError(res, 429, `sandboxd is at capacity (${SANDBOXD_MAX_IN_FLIGHT} active run(s)).`);
            return;
        }

        await withSpan(
            'sandboxd.run_pack_tool',
            {
                attributes: {
                    tool_name: body.tool_name,
                    project_root: body.project_root,
                },
            },
            async () => {
                try {
                    const result = await runPackToolInSandbox(body);
                    addSpanAttributes({ 'app.sandboxd.status': 'ok' });
                    res.json(result);
                } catch (error: any) {
                    const message =
                        error instanceof SandboxRunnerError
                            ? error.message
                            : error?.message || 'sandboxd execution failed.';
                    recordActiveSpanException(error, { 'app.sandboxd.status': 'error' });
                    sendError(res, 400, message);
                } finally {
                    releaseExecutionSlot();
                }
            }
        );
    });

    server = app.listen(SANDBOXD_PORT, () => {
        console.log(`[SANDBOXD] Listening on ${SANDBOXD_PORT}`);
    });
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

startSandboxd().catch(async (error) => {
    console.error('[SANDBOXD] Fatal error:', error);
    try {
        await shutdownOpenTelemetry();
    } finally {
        process.exit(1);
    }
});
