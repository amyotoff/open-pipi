import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SetupSafeError, SetupSafeStatus, SetupService, SetupServiceError } from './service';
import { AgentOnboardingError, type AgentOnboardingService } from '../agent-onboarding/service';
import { renderAgentOnboardingReviewPage } from '../agent-onboarding/review-page';

export type SetupPageRenderer = (input: { status: SetupSafeStatus; csrfToken: string }) => string;

export type SetupServerOptions = {
    service: SetupService;
    renderSetupPage: SetupPageRenderer;
    host?: '127.0.0.1';
    port?: number;
    randomBytes?: (size: number) => Uint8Array;
    onboarding?: AgentOnboardingService;
};

export type SetupServer = {
    /** One-use local bootstrap URL. Treat it as ephemeral session authentication. */
    url: string;
    /** Safe, non-authenticating loopback origin for display and OAuth construction. */
    origin: string;
    port: number;
    close(): Promise<void>;
};

const MAX_BODY_BYTES = 16 * 1024;
const SESSION_COOKIE = 'pipi_setup_session';

class HttpSetupError extends Error {
    constructor(
        readonly status: number,
        readonly safe: SetupSafeError
    ) {
        super(safe.message);
    }
}

function randomToken(randomBytes: (size: number) => Uint8Array): string {
    return Buffer.from(randomBytes(32)).toString('base64url');
}

function equalSecret(left: string | undefined, right: string): boolean {
    if (!left) return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookie(header: string | undefined, name: string): string | undefined {
    for (const part of (header || '').split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) return rest.join('=');
    }
    return undefined;
}

function setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
    setSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
}

function sendText(response: ServerResponse, status: number, value: string): void {
    setSecurityHeaders(response);
    response.statusCode = status;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(value);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        throw new HttpSetupError(415, {
            code: 'content_type',
            message: 'This setup request must use JSON.',
            action: 'Refresh the setup page and try again.',
            retryable: true,
            target: 'setup',
        });
    }

    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        throw new HttpSetupError(413, {
            code: 'request_too_large',
            message: 'The setup request is too large.',
            action: 'Use the short private fields on this page.',
            retryable: false,
            target: 'setup',
        });
    }

    const chunks: Buffer[] = [];
    let received = 0;
    for await (const raw of request) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
            throw new HttpSetupError(413, {
                code: 'request_too_large',
                message: 'The setup request is too large.',
                action: 'Use the short private fields on this page.',
                retryable: false,
                target: 'setup',
            });
        }
        chunks.push(chunk);
    }

    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body');
        return parsed as Record<string, unknown>;
    } catch {
        throw new HttpSetupError(400, {
            code: 'invalid_json',
            message: 'The setup request is not valid JSON.',
            action: 'Refresh the setup page and try again.',
            retryable: true,
            target: 'setup',
        });
    }
}

function publicError(error: unknown): { status: number; error: SetupSafeError } {
    if (error instanceof HttpSetupError) return { status: error.status, error: error.safe };
    if (error instanceof SetupServiceError) {
        const conflict = [
            'operation_in_progress',
            'runtime_active',
            'owner_already_configured',
            'owner_candidate_mismatch',
            'owner_candidate_missing',
            'environment_conflict',
        ].includes(error.code);
        return {
            status: conflict ? 409 : error.retryable ? 503 : 400,
            error: {
                code: error.code,
                message: error.message,
                action: error.action,
                retryable: error.retryable,
                target: error.target,
            },
        };
    }
    return {
        status: 500,
        error: {
            code: 'internal_error',
            message: 'The local setup service could not complete this step.',
            action: 'Retry the step. If it keeps failing, restart pnpm setup.',
            retryable: true,
            target: 'setup',
        },
    };
}

function onboardingError(error: unknown): { status: number; error: Record<string, unknown> } {
    if (error instanceof HttpSetupError) return { status: error.status, error: error.safe };
    if (error instanceof AgentOnboardingError) {
        const status =
            error.code === 'PREVIEW_NOT_FOUND'
                ? 404
                : ['PREVIEW_EXPIRED', 'PREVIEW_HASH_MISMATCH', 'VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED'].includes(
                        error.code
                    )
                  ? 409
                  : error.code === 'LEDGER_UNAVAILABLE'
                    ? 503
                    : 400;
        const messages: Record<string, string> = {
            VALIDATION_FAILED: 'The confirmation request is invalid.',
            PREVIEW_NOT_FOUND: 'The onboarding preview was not found.',
            PREVIEW_EXPIRED: 'The onboarding preview has expired.',
            PREVIEW_HASH_MISMATCH: 'The onboarding preview no longer matches this confirmation.',
            VERSION_CONFLICT: 'The saved owner context changed after this preview was created.',
            IDEMPOTENCY_KEY_REUSED: 'This confirmation key was already used for a different request.',
            LEDGER_UNAVAILABLE: 'The local onboarding ledger is unavailable.',
        };
        return {
            status,
            error: {
                code: error.code,
                message: messages[error.code] || 'The onboarding request could not be completed.',
                retryable: error.code === 'LEDGER_UNAVAILABLE',
            },
        };
    }
    return {
        status: 500,
        error: {
            code: 'INTERNAL_ERROR',
            message: 'The local onboarding service could not complete this step.',
            retryable: true,
        },
    };
}

function requireString(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    if (typeof value !== 'string') {
        throw new HttpSetupError(400, {
            code: 'invalid_input',
            message: 'A required setup value is missing.',
            action: 'Fill the private field and try again.',
            retryable: false,
            target: 'setup',
        });
    }
    return value;
}

function requireStringArray(body: Record<string, unknown>, key: string): string[] {
    const value = body[key];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new HttpSetupError(400, {
            code: 'invalid_input',
            message: 'The optional owner context is not valid.',
            action: 'Use up to five short facts and try again.',
            retryable: false,
            target: 'setup',
        });
    }
    return value;
}

export async function startSetupServer(options: SetupServerOptions): Promise<SetupServer> {
    const host = options.host || '127.0.0.1';
    if (host !== '127.0.0.1') throw new Error('Setup server must bind to 127.0.0.1.');
    const makeBytes = options.randomBytes || nodeRandomBytes;
    const bootstrapToken = randomToken(makeBytes);
    const sessionToken = randomToken(makeBytes);
    const csrfToken = randomToken(makeBytes);
    let bootstrapAvailable = true;
    let origin = '';
    let expectedHost = '';

    const server = createServer(async (request, response) => {
        try {
            if (!expectedHost || request.headers.host !== expectedHost) {
                throw new HttpSetupError(403, {
                    code: 'invalid_host',
                    message: 'This setup page only accepts its local address.',
                    action: 'Open the page from the pnpm setup command.',
                    retryable: false,
                    target: 'setup',
                });
            }
            const requestUrl = new URL(request.url || '/', origin);
            const hasSession = equalSecret(parseCookie(request.headers.cookie, SESSION_COOKIE), sessionToken);

            if (request.method === 'GET' && requestUrl.pathname === `/session/${bootstrapToken}`) {
                if (!bootstrapAvailable) {
                    sendText(response, 410, 'This setup link has already been used.');
                    return;
                }
                bootstrapAvailable = false;
                setSecurityHeaders(response);
                response.statusCode = 303;
                response.setHeader(
                    'set-cookie',
                    `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800`
                );
                response.setHeader('location', '/');
                response.end();
                return;
            }

            if (!hasSession) {
                throw new HttpSetupError(401, {
                    code: 'session_required',
                    message: 'This setup session is not authorized.',
                    action: 'Open the one-use page from pnpm setup.',
                    retryable: false,
                    target: 'setup',
                });
            }

            if (request.method === 'GET' && requestUrl.pathname === '/') {
                const status = await options.service.status({ includeEphemeral: true });
                setSecurityHeaders(response);
                response.statusCode = 200;
                response.setHeader('content-type', 'text/html; charset=utf-8');
                response.end(options.renderSetupPage({ status, csrfToken }));
                return;
            }
            if (request.method === 'GET' && requestUrl.pathname === '/api/status') {
                sendJson(response, 200, await options.service.status({ includeEphemeral: true }));
                return;
            }
            if (options.onboarding && request.method === 'GET' && requestUrl.pathname === '/agent-onboarding/review') {
                try {
                    const state = options.onboarding.readState(requestUrl.searchParams.get('previewId') || undefined);
                    setSecurityHeaders(response);
                    response.statusCode = 200;
                    response.setHeader('content-type', 'text/html; charset=utf-8');
                    response.end(renderAgentOnboardingReviewPage({ state, csrfToken }));
                } catch (error) {
                    const problem = onboardingError(error);
                    sendJson(response, problem.status, { error: problem.error });
                }
                return;
            }
            if (
                options.onboarding &&
                request.method === 'GET' &&
                requestUrl.pathname === '/api/agent-onboarding/state'
            ) {
                try {
                    sendJson(
                        response,
                        200,
                        options.onboarding.readState(requestUrl.searchParams.get('previewId') || undefined)
                    );
                } catch (error) {
                    const problem = onboardingError(error);
                    sendJson(response, problem.status, { error: problem.error });
                }
                return;
            }

            if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/setup/openrouter/callback/')) {
                const state = requestUrl.pathname.slice('/api/setup/openrouter/callback/'.length);
                const code = requestUrl.searchParams.get('code') || '';
                try {
                    await options.service.completeOpenRouterOAuth(state, code);
                    setSecurityHeaders(response);
                    response.statusCode = 303;
                    response.setHeader('location', '/?oauth=connected');
                    response.end();
                } catch {
                    setSecurityHeaders(response);
                    response.statusCode = 303;
                    response.setHeader('location', '/?oauth=retry');
                    response.end();
                }
                return;
            }

            if (request.method !== 'POST') {
                throw new HttpSetupError(404, {
                    code: 'not_found',
                    message: 'This setup route does not exist.',
                    action: 'Refresh the setup page.',
                    retryable: false,
                    target: 'setup',
                });
            }
            if (request.headers.origin !== origin) {
                throw new HttpSetupError(403, {
                    code: 'invalid_origin',
                    message: 'The setup request came from a different origin.',
                    action: 'Use the setup page opened by pnpm setup.',
                    retryable: false,
                    target: 'setup',
                });
            }
            const csrfHeader = Array.isArray(request.headers['x-pipi-csrf'])
                ? request.headers['x-pipi-csrf'][0]
                : request.headers['x-pipi-csrf'];
            if (!equalSecret(csrfHeader, csrfToken)) {
                throw new HttpSetupError(403, {
                    code: 'invalid_session_token',
                    message: 'The setup request is missing its session token.',
                    action: 'Refresh the setup page and try again.',
                    retryable: true,
                    target: 'setup',
                });
            }

            const body = await readJsonBody(request);
            if (requestUrl.pathname === '/api/agent-onboarding/confirm') {
                if (!options.onboarding) {
                    throw new HttpSetupError(404, {
                        code: 'not_found',
                        message: 'This setup route does not exist.',
                        action: 'Refresh the setup page.',
                        retryable: false,
                        target: 'setup',
                    });
                }
                try {
                    const result = options.onboarding.confirmAndApply({
                        previewId: requireString(body, 'previewId'),
                        previewHash: requireString(body, 'previewHash'),
                        idempotencyKey: requireString(body, 'idempotencyKey'),
                    });
                    sendJson(response, 200, { result });
                } catch (error) {
                    const problem = onboardingError(error);
                    sendJson(response, problem.status, { error: problem.error });
                }
                return;
            }
            let state: SetupSafeStatus;
            let extra: Record<string, unknown> = {};
            switch (requestUrl.pathname) {
                case '/api/metadata':
                    state = await options.service.setMetadata({
                        ...(body.language === undefined ? {} : { language: requireString(body, 'language') }),
                        ...(body.timezone === undefined ? {} : { timezone: requireString(body, 'timezone') }),
                    });
                    break;
                case '/api/profile':
                    if (body.consent !== true) {
                        throw new HttpSetupError(400, {
                            code: 'profile_consent_required',
                            message: 'Owner consent is required before saving optional context.',
                            action: 'Review the optional details and select the consent box.',
                            retryable: false,
                            target: 'setup',
                        });
                    }
                    state = await options.service.setMetadata({
                        language: requireString(body, 'language'),
                        timezone: requireString(body, 'timezone'),
                        profile: {
                            facts: requireStringArray(body, 'facts'),
                            currentTask: requireString(body, 'currentTask'),
                        },
                    });
                    break;
                case '/api/openrouter/oauth': {
                    const oauth = await options.service.beginOpenRouterOAuth(origin);
                    state = await options.service.status({ includeEphemeral: true });
                    extra = { authorizationUrl: oauth.authorizationUrl };
                    break;
                }
                case '/api/openrouter/key':
                    state = await options.service.setManualOpenRouterKey(requireString(body, 'key'));
                    break;
                case '/api/telegram':
                    state = await options.service.setTelegramToken(requireString(body, 'token'));
                    break;
                case '/api/pairing/start':
                    state = await options.service.beginOwnerPairing();
                    break;
                case '/api/pairing/confirm':
                    state = await options.service.confirmOwner(requireString(body, 'candidateId'));
                    break;
                case '/api/pairing/cancel':
                    state = await options.service.cancelOwnerPairing();
                    break;
                case '/api/connections/validate':
                    state = await options.service.validateConnections();
                    break;
                case '/api/runtime/start': {
                    const mode = requireString(body, 'mode');
                    if (mode !== 'foreground' && mode !== 'background') {
                        throw new HttpSetupError(400, {
                            code: 'invalid_runtime_mode',
                            message: 'Choose foreground or background runtime mode.',
                            action: 'Refresh the setup page and try again.',
                            retryable: false,
                            target: 'runtime',
                        });
                    }
                    state = await options.service.startRuntime(mode);
                    break;
                }
                case '/api/runtime/stop':
                    state = await options.service.stopRuntime();
                    break;
                case '/api/retry': {
                    const target = body.target;
                    state =
                        target === 'owner'
                            ? await options.service.beginOwnerPairing()
                            : await options.service.validateConnections();
                    break;
                }
                default:
                    throw new HttpSetupError(404, {
                        code: 'not_found',
                        message: 'This setup route does not exist.',
                        action: 'Refresh the setup page.',
                        retryable: false,
                        target: 'setup',
                    });
            }
            sendJson(response, 200, { state, ...extra });
        } catch (error) {
            const problem = publicError(error);
            let state: SetupSafeStatus | undefined;
            try {
                state = await options.service.status({ includeEphemeral: true });
            } catch {}
            sendJson(response, problem.status, { error: problem.error, ...(state ? { state } : {}) });
        }
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port || 0, host);
    });

    const address = server.address() as AddressInfo;
    expectedHost = `${host}:${address.port}`;
    origin = `http://${expectedHost}`;

    return {
        url: `${origin}/session/${bootstrapToken}`,
        origin,
        port: address.port,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
