import type { Server } from 'node:http';
import type { Express, Request, Response } from 'express';
import { once } from 'node:events';
import fs from 'node:fs';
import { getToolLog, queryToolLogs, summarizeToolLogs, ToolLogQuery } from './db';
import { getBriefPagePath } from './core/brief-pages';
import { getHtmlArtifactPath } from './core/html-artifacts';
import { exchangeGoogleAuthCode, isGoogleOAuthConfigured } from './core/google-oauth';
import { PIPI_WEB_ENABLED, PIPI_WEB_HOST, PIPI_WEB_PORT, isLoopbackHost } from './config';

type StartApiServerOptions = {
    host?: string;
    port?: number;
    token?: string;
};

/**
 * One express app and one listener for the whole runtime.
 *
 * When the web client is on it owns the host and port, and the read-only
 * tool-log API rides along behind its bearer token. Two ports for one process
 * would be complexity with nothing to show for it.
 */
function resolveListenTarget(options: StartApiServerOptions): { host: string; port: number } {
    if (PIPI_WEB_ENABLED) {
        return { host: options.host || PIPI_WEB_HOST, port: options.port ?? PIPI_WEB_PORT };
    }
    return { host: options.host || DEFAULT_HOST, port: options.port ?? DEFAULT_PORT };
}

const DEFAULT_HOST = process.env.PIPI_API_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PIPI_API_PORT || 0);
const DEFAULT_TOKEN = process.env.PIPI_API_TOKEN || '';

let server: Server | null = null;

function parsePositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function verifyAuth(expectedToken: string) {
    return (req: Request, res: Response, next: () => void): void => {
        const authHeader = req.headers.authorization || '';
        if (authHeader !== `Bearer ${expectedToken}`) {
            res.status(401).json({ ok: false, error: 'Unauthorized.' });
            return;
        }
        next();
    };
}

function readToolLogQuery(req: Request): ToolLogQuery {
    return {
        space_id: typeof req.query.space_id === 'string' ? req.query.space_id : undefined,
        task_id: typeof req.query.task_id === 'string' ? req.query.task_id : undefined,
        tool_name: typeof req.query.tool_name === 'string' ? req.query.tool_name : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        started_after: typeof req.query.started_after === 'string' ? req.query.started_after : undefined,
        started_before: typeof req.query.started_before === 'string' ? req.query.started_before : undefined,
        limit: parsePositiveInt(req.query.limit, 50),
        offset: parsePositiveInt(req.query.offset, 0),
    };
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function createApiApp(token: string): Promise<Express> {
    const { default: express } = await import('express');
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', true);

    app.get('/health', (_req, res) => {
        res.json({ ok: true });
    });

    app.get('/briefs/:fileName', (req: Request, res: Response) => {
        const fileName = typeof req.params.fileName === 'string' ? req.params.fileName : '';
        const filePath = getBriefPagePath(fileName);
        if (!filePath || !fs.existsSync(filePath)) {
            res.status(404).send('Brief not found.');
            return;
        }

        res.setHeader('Cache-Control', 'private, max-age=300');
        res.sendFile(filePath);
    });

    app.get('/html/:fileName', (req: Request, res: Response) => {
        const fileName = typeof req.params.fileName === 'string' ? req.params.fileName : '';
        const filePath = getHtmlArtifactPath(fileName);
        if (!filePath || !fs.existsSync(filePath)) {
            res.status(404).send('HTML artifact not found.');
            return;
        }

        res.setHeader('Cache-Control', 'private, max-age=300');
        res.sendFile(filePath);
    });

    app.get('/oauth/google/callback', async (req: Request, res: Response) => {
        if (!isGoogleOAuthConfigured()) {
            res.status(503).send('<h2>Google OAuth is not configured on this server.</h2>');
            return;
        }

        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const error = typeof req.query.error === 'string' ? req.query.error : '';

        if (error) {
            res.status(400).send(`<h2>Authorization denied: ${escapeHtml(error)}</h2><p>You can close this tab.</p>`);
            return;
        }

        if (!code || !state) {
            res.status(400).send('<h2>Invalid callback: missing code or state.</h2>');
            return;
        }

        try {
            await exchangeGoogleAuthCode(code, state);
            res.send('<h2>Google Drive connected!</h2><p>You can close this tab and return to Telegram.</p>');
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            console.error('[OAUTH] Google callback error:', err);
            res.status(500).send(`<h2>Authorization failed.</h2><p>${escapeHtml(message)}</p>`);
        }
    });

    // Scoped to the tool-log routes, not the whole /api prefix.
    //
    // A blanket guard here would demand a bearer token for POST /api/auth/login,
    // which a browser can never supply — the web client could not sign in at
    // all. The tool-log routes keep exactly the protection they had.
    app.use('/api/tool-logs', verifyAuth(token));

    app.get('/api/tool-logs', (req, res) => {
        const filters = readToolLogQuery(req);
        const page = queryToolLogs(filters);
        const summary = summarizeToolLogs(filters);

        res.json({
            ok: true,
            filters: {
                ...filters,
                limit: page.limit,
                offset: page.offset,
            },
            page: {
                total: page.total,
                limit: page.limit,
                offset: page.offset,
                has_more: page.has_more,
            },
            summary,
            items: page.items,
        });
    });

    app.get('/api/tool-logs/:id', (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            res.status(400).json({ ok: false, error: 'Invalid tool log id.' });
            return;
        }

        const item = getToolLog(id);
        if (!item) {
            res.status(404).json({ ok: false, error: 'Tool log not found.' });
            return;
        }

        res.json({ ok: true, item });
    });

    if (PIPI_WEB_ENABLED) {
        const { mountWebClient, WEB_PUBLIC_DIR } = await import('./web/routes');
        await mountWebClient(app, {
            secureCookies: !isLoopbackHost(PIPI_WEB_HOST) && process.env.NODE_ENV === 'production',
        });
        app.use(express.static(WEB_PUBLIC_DIR, { index: 'index.html' }));
    }

    return app;
}

export async function startApiServer(options: StartApiServerOptions = {}): Promise<Server | null> {
    const { host, port } = resolveListenTarget(options);
    const token = options.token ?? DEFAULT_TOKEN;

    if (!Number.isFinite(port) || (options.port === undefined && port <= 0)) {
        return null;
    }

    // The tool-log routes still need their token; the web client brings its own
    // sessions and does not.
    if (!token && !PIPI_WEB_ENABLED) {
        throw new Error('PIPI_API_TOKEN must be set when PIPI_API_PORT is enabled.');
    }

    if (server) {
        return server;
    }

    const app = await createApiApp(token);
    const instance = app.listen(port, host);
    if (!instance.listening) {
        await once(instance, 'listening');
    }
    server = instance;

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[API] Listening on http://${host}:${actualPort}`);
    return server;
}

export async function stopApiServer(): Promise<void> {
    if (!server) return;

    const activeServer = server;
    server = null;
    await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
