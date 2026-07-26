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
 * Settings that live in `.env` — tokens, owners, hosts — are shown read-only
 * and edited in the file. A dashboard that edits credentials is an attack
 * surface, not a convenience.
 */

import type { Express, NextFunction, Response } from 'express';
import {
    getDb,
    getMemoryEntries,
    getResident,
    getTransportTopologyReport,
    listSpaces,
    listTransportBindingsForSpace,
    type Space,
} from '../db';
import { countOutboxByStatus } from '../gateway/outbox';
import { getHealthState, getSystemMetrics } from '../core/healthcheck';
import { listTransports } from '../transports/registry';
import { resolveSpaceOperationalSettings } from '../core/space-preferences';
import { countSubscribers } from './events';
import type { AuthedRequest } from './routes';

const NOT_FOUND = { ok: false, error: 'Not found.' };

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

export function mountAdminRoutes(app: Express, requireSession: SessionGuard): void {
    const guard = [requireSession, requireOwner];

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

    /** Every space, with the things that decide how it behaves. */
    app.get('/api/admin/spaces', guard, (_req: AuthedRequest, res: Response) => {
        res.json({ ok: true, spaces: listSpaces().map(describeSpace) });
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
