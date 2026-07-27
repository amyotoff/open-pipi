/**
 * The owner dashboard's read API.
 *
 * A window into the runtime, nothing more: today the only way to see what the
 * assistant is doing is `sqlite3` and the logs.
 *
 * Every route here is read-only and owner-gated. A non-owner gets 404 rather
 * than 403 — the same rule the space routes follow, because telling someone an
 * admin surface exists is itself a disclosure.
 *
 * The few writes it does have change only what already lives in the database:
 * how a space behaves, and whether a failed delivery gets another go. Settings
 * that live in `.env` — tokens, owners, hosts — are edited in the file. A
 * dashboard that edits credentials is an attack surface, not a convenience.
 */

import type { Express, NextFunction, RequestHandler, Response } from 'express';
import {
    getDb,
    getMemoryEntries,
    getResident,
    getSpace,
    getTransportTopologyReport,
    listSpaces,
    listTransportBindingsForSpace,
    logEvent,
    updateSpaceAssistantPack,
    updateSpaceGroundingPack,
    updateSpacePolicy,
    updateSpaceStatus,
    type Space,
} from '../db';
import { countOutboxByStatus, getOutboxEntry, requeueDelivery } from '../gateway/outbox';
import { getHealthState, getSystemMetrics } from '../core/healthcheck';
import { listTransports } from '../transports/registry';
import { listInstallablePackIds } from '../core/pack-loader';
import { listInstallableGroundingIds } from '../core/grounding-loader';
import { resolveSpaceOperationalSettings, type SpaceChannelMode } from '../core/space-preferences';
import { logInfo } from '../utils/logging';
import { countSubscribers } from './events';
import type { AuthedRequest } from './routes';

const NOT_FOUND = { ok: false, error: 'Not found.' };

const CHANNEL_MODES: SpaceChannelMode[] = ['off', 'notify_only', 'inbox', 'full'];
const SPACE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;

type SpaceStatus = (typeof SPACE_STATUSES)[number];

/**
 * Owner-only, and silent about it.
 *
 * The role comes from the participant the session resolves to, so it is the
 * same notion of "owner" every other surface uses.
 */
function requireOwner(req: AuthedRequest, res: Response, next: NextFunction): void {
    const participant = req.session ? getResident(req.session.participantId) : undefined;
    if (!participant || participant.role !== 'owner') {
        res.status(404).json(NOT_FOUND);
        return;
    }
    next();
}

function describeSpace(space: Space) {
    const settings = resolveSpaceOperationalSettings(space.policy_json);
    const bindings = listTransportBindingsForSpace(space.id, { includeDisabled: true });

    return {
        id: space.id,
        title: space.title || space.id,
        kind: space.kind,
        status: space.status,
        pack: space.assistant_pack_id,
        grounding: space.grounding_pack_id,
        channel_mode: settings.channel_mode,
        bindings: bindings.map((binding) => ({
            id: binding.id,
            transport: binding.transport,
            endpoint_id: binding.endpoint_id,
            status: binding.status,
        })),
    };
}

export type SessionGuard = (req: AuthedRequest, res: Response, next: NextFunction) => void;

export interface AdminRouteDependencies {
    requireSession: SessionGuard;
    /** The same JSON-only rule the rest of the client's writes follow. */
    requireJsonBody: RequestHandler;
    jsonBody: RequestHandler;
}

export function mountAdminRoutes(app: Express, deps: AdminRouteDependencies): void {
    const guard = [deps.requireSession, requireOwner];
    const writeGuard = [...guard, deps.requireJsonBody, deps.jsonBody];

    /** Is the assistant healthy, and is anything stuck? */
    app.get('/api/admin/overview', guard, (_req: AuthedRequest, res: Response) => {
        const topology = getTransportTopologyReport();

        res.json({
            ok: true,
            health: getHealthState(),
            metrics: getSystemMetrics(),
            transports: listTransports().map((adapter) => adapter.name),
            outbox: countOutboxByStatus(),
            topology: {
                spaces: topology.spaces,
                bindings: topology.bindings,
                participants: topology.participants,
                identities: topology.identities,
                spaces_without_binding: topology.spaces_without_binding,
                participants_without_identity: topology.participants_without_identity,
            },
            web_subscribers: countSubscribers(),
        });
    });

    /**
     * Every space, with the things that decide how it behaves — and the values
     * those things may take, so the client offers choices rather than a text
     * box that can be typed wrong.
     */
    app.get('/api/admin/spaces', guard, (_req: AuthedRequest, res: Response) => {
        res.json({
            ok: true,
            spaces: listSpaces().map(describeSpace),
            choices: {
                channel_mode: CHANNEL_MODES,
                pack: listInstallablePackIds(),
                grounding: listInstallableGroundingIds(),
                status: SPACE_STATUSES,
            },
        });
    });

    /**
     * Change how a space behaves.
     *
     * Every field is optional and every value is checked against the same list
     * the client is offered, so a hand-written request cannot put a space into
     * a state the UI could not.
     */
    app.patch('/api/admin/spaces/:spaceId', writeGuard, (req: AuthedRequest, res: Response) => {
        const spaceId = String(req.params.spaceId);
        if (!getSpace(spaceId)) {
            res.status(404).json(NOT_FOUND);
            return;
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const changes: Record<string, string> = {};

        for (const [field, allowed] of [
            ['channel_mode', CHANNEL_MODES as readonly string[]],
            ['pack', listInstallablePackIds()],
            ['grounding', listInstallableGroundingIds()],
            ['status', SPACE_STATUSES as readonly string[]],
        ] as const) {
            const value = body[field];
            if (value === undefined) continue;
            if (typeof value !== 'string' || !allowed.includes(value)) {
                res.status(400).json({ ok: false, error: `${field} must be one of: ${allowed.join(', ')}.` });
                return;
            }
            changes[field] = value;
        }

        if (Object.keys(changes).length === 0) {
            res.status(400).json({ ok: false, error: 'Nothing to change.' });
            return;
        }

        if (changes.pack) updateSpaceAssistantPack(spaceId, changes.pack);
        if (changes.grounding) updateSpaceGroundingPack(spaceId, changes.grounding);
        if (changes.status) {
            updateSpaceStatus(spaceId, changes.status as SpaceStatus);
            // Archiving has to mean "stop here". Status alone only hides the
            // space from lists; the assistant would go on answering in it,
            // which is exactly what someone archiving it does not expect.
            if (changes.status === 'ARCHIVED' && changes.channel_mode === undefined) changes.channel_mode = 'off';
        }
        if (changes.channel_mode) updateSpacePolicy(spaceId, { channel_mode: changes.channel_mode });

        const by = req.session!.participantId;
        logEvent('admin_space_update', { space_id: spaceId, by, changes });
        logInfo('WEB', 'admin_space_update', { space_id: spaceId, by, ...changes });

        res.json({ ok: true, space: describeSpace(getSpace(spaceId)!) });
    });

    /** What is stuck, and why. */
    app.get('/api/admin/delivery', guard, (_req: AuthedRequest, res: Response) => {
        const entries = getDb()
            .prepare(
                `
            SELECT id, transport, endpoint_id, status, attempts, last_error, next_retry_at, created_at
            FROM outbox
            WHERE status IN ('queued', 'processing', 'failed')
            ORDER BY CASE status WHEN 'failed' THEN 0 ELSE 1 END, rowid DESC
            LIMIT 100
        `
            )
            .all();

        res.json({ ok: true, counts: countOutboxByStatus(), entries });
    });

    /**
     * Try a given-up delivery again.
     *
     * The delivery worker polls, so a re-queued entry goes out on its next
     * pass — there is nothing to kick.
     */
    app.post('/api/admin/delivery/:id/requeue', writeGuard, (req: AuthedRequest, res: Response) => {
        const id = String(req.params.id);
        const entry = requeueDelivery(id);

        if (!entry) {
            // Either it does not exist or it is not failed. Both mean the same
            // thing to the person clicking: there is nothing here to retry.
            res.status(getOutboxEntry(id) ? 409 : 404).json({
                ok: false,
                error: getOutboxEntry(id) ? 'That delivery is not failed.' : 'Not found.',
            });
            return;
        }

        const by = req.session!.participantId;
        logEvent('admin_delivery_requeue', { outbox_id: id, transport: entry.transport, by });
        logInfo('WEB', 'admin_delivery_requeue', { outbox_id: id, transport: entry.transport, by });

        res.json({ ok: true, entry: { id: entry.id, status: entry.status, attempts: entry.attempts } });
    });

    /**
     * The Brain Layer's curated pages.
     *
     * Listing and reading only: the assistant maintains this through its own
     * skill, where a change carries provenance. Editing it from a form would
     * make knowledge appear from nowhere.
     */
    app.get('/api/admin/brain', guard, async (_req: AuthedRequest, res: Response) => {
        const { listWikiPages, searchNotes } = await import('../core/brain');

        res.json({
            ok: true,
            wiki_pages: listWikiPages({ limit: 100 }),
            notes: searchNotes({ limit: 30 }).map((note) => ({
                id: note.id,
                topic: note.topic,
                text: note.text,
                tags: note.tags,
                status: note.status,
                updated_at: note.updated_at,
            })),
        });
    });

    app.get('/api/admin/brain/page', guard, async (req: AuthedRequest, res: Response) => {
        const pagePath = typeof req.query.path === 'string' ? req.query.path : '';
        if (!pagePath) {
            res.status(400).json({ ok: false, error: 'A page path is required.' });
            return;
        }

        const { readWikiPage } = await import('../core/brain');
        try {
            const page = readWikiPage(pagePath);
            res.json({ ok: true, page: { path: page.path, exists: page.exists, content: page.content } });
        } catch {
            // readWikiPage rejects anything that escapes the wiki root.
            res.status(400).json({ ok: false, error: 'That is not a wiki page path.' });
        }
    });

    /** What the assistant remembers, by scope. */
    app.get('/api/admin/memory', guard, (req: AuthedRequest, res: Response) => {
        const scopeType = typeof req.query.scope_type === 'string' ? req.query.scope_type : undefined;
        const scopeId = typeof req.query.scope_id === 'string' ? req.query.scope_id : undefined;
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

        const entries =
            scopeType && scopeId
                ? getMemoryEntries(scopeType, scopeId, undefined, limit)
                : (getDb()
                      .prepare(`SELECT * FROM memory_entries ORDER BY updated_at DESC LIMIT ?`)
                      .all(limit) as ReturnType<typeof getMemoryEntries>);

        res.json({
            ok: true,
            entries: entries.map((entry) => ({
                scope_type: entry.scope_type,
                scope_id: entry.scope_id,
                kind: entry.kind,
                content: entry.content,
                salience: entry.salience,
                source: entry.source,
                updated_at: entry.updated_at,
            })),
        });
    });
}
