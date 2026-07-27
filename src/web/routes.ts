/**
 * The Web client's HTTP surface.
 *
 * Mounted on the same express app as the rest of the runtime, so there is one
 * listener and one shutdown path.
 *
 * Two rules run through every handler here:
 *
 * - Identity comes from the session, never from the request. A client that can
 *   name its own participant or space can read anyone's conversation.
 * - A person sees the spaces they are a member of and nothing else, which is
 *   the same rule every other surface already follows.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    ensureTransportBinding,
    getRecentMessagesForSpace,
    getResident,
    getSpace,
    isSpaceMember,
    listSpacesForParticipant,
} from '../db';
import { logInfo, logWarn } from '../utils/logging';
import { handleIncoming } from '../gateway/message-gateway';
import { buildIncomingMessageId } from '../transports/types';
import { WEB_TRANSPORT } from '../transports/web/adapter';
import { login, resolveSession, revokeSession, type AuthenticatedSession } from './auth';
import { publishSpaceActivity, subscribe } from './events';
import type { IncomingMessage } from '../transports/types';

const SESSION_COOKIE = 'pipi_session';
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 8_000;

export const WEB_PUBLIC_DIR = path.join(__dirname, 'public');

interface AuthedRequest extends Request {
    session?: AuthenticatedSession;
}

/** Express gives no cookie parsing by default, and one header is not worth a dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;

    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator === -1) continue;
        if (part.slice(0, separator).trim() !== name) continue;
        return decodeURIComponent(part.slice(separator + 1).trim());
    }

    return undefined;
}

function setSessionCookie(res: Response, session: AuthenticatedSession, secure: boolean): void {
    const attributes = [
        `${SESSION_COOKIE}=${encodeURIComponent(session.token)}`,
        'Path=/',
        'HttpOnly',
        // Lax keeps the cookie off cross-site form posts, which together with
        // the JSON-only rule below is enough CSRF protection for a LAN tool.
        'SameSite=Lax',
        `Expires=${new Date(session.expiresAt).toUTCString()}`,
        ...(secure ? ['Secure'] : []),
    ];
    res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res: Response): void {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireSession(req: AuthedRequest, res: Response, next: NextFunction): void {
    const session = resolveSession(readCookie(req.headers.cookie, SESSION_COOKIE));
    if (!session) {
        res.status(401).json({ ok: false, error: 'Not signed in.' });
        return;
    }

    req.session = session;
    next();
}

/**
 * State-changing requests must be JSON.
 *
 * A browser can cross-site POST a form, but not a JSON body with a custom
 * content type, so requiring one closes the CSRF hole that SameSite alone
 * leaves on older clients.
 */
function requireJsonBody(req: Request, res: Response, next: NextFunction): void {
    if (!req.is('application/json')) {
        res.status(415).json({ ok: false, error: 'Expected application/json.' });
        return;
    }
    next();
}

function clientKey(req: Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

export interface MountWebClientOptions {
    /** Set when the runtime sits behind TLS, so the cookie can demand it. */
    secureCookies?: boolean;
}

export async function mountWebClient(app: Express, options: MountWebClientOptions = {}): Promise<void> {
    const { default: express } = await import('express');
    const jsonBody = express.json({ limit: MAX_JSON_BODY_BYTES });

    // ==========================================
    // Auth
    // ==========================================

    app.post('/api/auth/login', requireJsonBody, jsonBody, (req: Request, res: Response) => {
        const username = typeof req.body?.username === 'string' ? req.body.username : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!username || !password) {
            res.status(400).json({ ok: false, error: 'Username and password are required.' });
            return;
        }

        const outcome = login({ username, password, throttleKey: `${clientKey(req)}:${username.toLowerCase()}` });
        if (!outcome.ok) {
            logWarn('WEB', 'login_failed', { reason: outcome.reason });
            const status = outcome.reason === 'throttled' ? 429 : 401;
            // The reason is deliberately vague: distinguishing a wrong password
            // from an unknown account turns this into an account-discovery tool.
            res.status(status).json({
                ok: false,
                error: outcome.reason === 'throttled' ? 'Too many attempts. Try again later.' : 'Sign-in failed.',
            });
            return;
        }

        setSessionCookie(res, outcome.session, Boolean(options.secureCookies));
        logInfo('WEB', 'login_ok', { username: outcome.session.username });
        res.json({ ok: true, username: outcome.session.username });
    });

    app.post('/api/auth/logout', (req: Request, res: Response) => {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (token) revokeSession(token);
        clearSessionCookie(res);
        res.json({ ok: true });
    });

    app.get('/api/me', requireSession, (req: AuthedRequest, res: Response) => {
        const participant = getResident(req.session!.participantId);
        res.json({
            ok: true,
            username: req.session!.username,
            participant: {
                id: req.session!.participantId,
                display_name: participant?.nickname || participant?.display_name || null,
                role: participant?.role || 'member',
            },
        });
    });

    // ==========================================
    // Spaces
    // ==========================================

    app.get('/api/spaces', requireSession, (req: AuthedRequest, res: Response) => {
        const spaces = listSpacesForParticipant(req.session!.participantId);

        res.json({
            ok: true,
            spaces: spaces.map((space) => ({
                id: space.id,
                slug: space.slug ?? null,
                title: space.title || space.id,
                kind: space.kind,
                last_message_at: space.last_message_at,
                last_message_preview: space.last_message_preview?.slice(0, 160) ?? null,
            })),
        });
    });

    /**
     * Send into a space.
     *
     * Membership is the authorization, so a member's first message is also what
     * creates the space's web binding — the resolver refuses to bootstrap web
     * endpoints precisely so that a *stranger* cannot, and a member is not one.
     *
     * From there the message goes through the same gateway as every other
     * transport: same id format, same deduplication, same pipeline. There is no
     * separate agent flow for the web.
     */
    app.post(
        '/api/spaces/:spaceId/messages',
        requireSession,
        requireJsonBody,
        jsonBody,
        async (req: AuthedRequest, res: Response) => {
            const spaceId = String(req.params.spaceId);
            const participantId = req.session!.participantId;
            const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

            if (!isSpaceMember(spaceId, participantId)) {
                res.status(404).json({ ok: false, error: 'Space not found.' });
                return;
            }

            const space = getSpace(spaceId);
            if (!space) {
                res.status(404).json({ ok: false, error: 'Space not found.' });
                return;
            }

            if (!text) {
                res.status(400).json({ ok: false, error: 'A message needs some text.' });
                return;
            }
            if (text.length > MAX_MESSAGE_CHARS) {
                res.status(413).json({ ok: false, error: `Keep it under ${MAX_MESSAGE_CHARS} characters.` });
                return;
            }

            ensureTransportBinding({
                transport: WEB_TRANSPORT,
                endpointId: space.id,
                endpointType: space.kind === 'group_chat' ? 'group' : 'direct',
                spaceId: space.id,
            });

            const transportMessageId = randomUUID();
            const message: IncomingMessage = {
                id: buildIncomingMessageId(WEB_TRANSPORT, space.id, transportMessageId),
                transportMessageId,
                transport: WEB_TRANSPORT,
                endpoint: {
                    id: space.id,
                    type: space.kind === 'group_chat' ? 'group' : 'direct',
                    title: space.title,
                },
                sender: {
                    // The username is this participant's web identity, so the
                    // resolver recognizes the same person it knows from
                    // Telegram. From the session, never from the body: a client
                    // that can name its own sender can speak as anyone.
                    transportUserId: req.session!.username,
                    displayName: getResident(participantId)?.display_name ?? null,
                    username: req.session!.username,
                },
                content: { text },
                timestamp: new Date().toISOString(),
                correlationId: randomUUID(),
                // A message typed into the assistant's own client is addressed
                // to it by definition.
                addressedToAssistant: true,
                // The session proved who this is, and membership was checked
                // above — the gateway needs no allowlist to trust it.
                senderAuthenticated: true,
            };

            res.status(202).json({ ok: true, message_id: message.id });
            publishSpaceActivity(space.id);

            // The reply may take a while; the client already has its 202 and
            // learns about the answer from the activity stream.
            void handleIncoming(message).catch((error) => {
                logWarn('WEB', 'send_failed', {
                    space_id: space.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    );

    /**
     * The activity stream.
     *
     * One event type and no server-side cursor: the client refetches the space
     * it was told about, so a dropped connection costs nothing to recover from.
     */
    app.get('/api/events', requireSession, (req: AuthedRequest, res: Response) => {
        const detach = subscribe(req.session!.participantId, res);
        req.on('close', detach);
    });

    app.get('/api/spaces/:spaceId/messages', requireSession, (req: AuthedRequest, res: Response) => {
        const spaceId = String(req.params.spaceId);
        const participantId = req.session!.participantId;

        // Membership is checked before the space is even confirmed to exist, so
        // a stranger cannot probe which space ids are real.
        if (!isSpaceMember(spaceId, participantId) || !getSpace(spaceId)) {
            res.status(404).json({ ok: false, error: 'Space not found.' });
            return;
        }

        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const messages = getRecentMessagesForSpace(spaceId, limit);

        res.json({
            ok: true,
            space_id: spaceId,
            messages: messages.map((message) => ({
                id: message.id,
                sender_id: message.sender_id ?? null,
                is_bot: message.is_bot === 1,
                content: message.content,
                timestamp: message.timestamp,
            })),
        });
    });
}
