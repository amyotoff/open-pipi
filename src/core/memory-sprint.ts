import { getDb, getMemoryEntries, getSpace, listSpaces, MemoryEntry, MemorySprint, rememberMemoryEntry } from '../db';
import { invalidateMemoryContextCache } from './memory-context';
import { resolveSpacePolicy } from './policy';

const DEFAULT_SPRINT_DAYS_BY_PACK: Record<string, number> = {
    jeeves: 7,
    tutor: 30,
    office: 7,
    reporter: 14,
};

function nowIso(now?: Date): string {
    return (now || new Date()).toISOString();
}

function addDays(iso: string, days: number): string {
    const next = new Date(iso);
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString();
}

export function defaultMemorySprintDaysForPack(packId: string): number {
    return DEFAULT_SPRINT_DAYS_BY_PACK[packId] || DEFAULT_SPRINT_DAYS_BY_PACK.jeeves;
}

export function resolveMemorySprintDays(spaceId: string): number {
    const space = getSpace(spaceId);
    const policy = resolveSpacePolicy(spaceId);
    const requested = Number(policy.memory_sprint_days);
    if (Number.isFinite(requested) && requested >= 1 && requested <= 365) {
        return Math.round(requested);
    }
    return defaultMemorySprintDaysForPack(space?.assistant_pack_id || 'jeeves');
}

function closeExpiredSprints(spaceId: string, currentIso: string): number {
    const result = getDb()
        .prepare(
            `
        UPDATE memory_sprints
        SET status = 'closed', updated_at = ?
        WHERE space_id = ?
          AND status = 'active'
          AND closes_at <= ?
    `
        )
        .run(currentIso, spaceId, currentIso);
    return result.changes;
}

function uniqueEntries(entries: MemoryEntry[], limit: number = 4): MemoryEntry[] {
    const seen = new Set<string>();
    const result: MemoryEntry[] = [];

    for (const entry of entries
        .slice()
        .sort((left, right) => right.salience - left.salience || right.updated_at.localeCompare(left.updated_at))) {
        const key = entry.content.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(entry);
        if (result.length >= limit) break;
    }

    return result;
}

function buildReflection(entries: MemoryEntry[]): string {
    const kinds = new Set(entries.map((entry) => entry.kind));

    if (kinds.has('task_failure')) {
        return 'The sprint surfaced one or two points of friction worth watching more carefully next time.';
    }
    if (kinds.has('workflow_artifact')) {
        return 'The work left behind durable artifacts, which is usually a sign that the sprint actually crystallized into something usable.';
    }
    if (kinds.has('insight')) {
        return 'A few patterns repeated often enough to feel like the real shape of the sprint, not just random noise.';
    }
    if (entries.length <= 2) {
        return 'It was a quiet sprint, but even quiet sprints often reveal what is stable and worth carrying forward.';
    }
    return 'Taken together, these notes feel like the part of the sprint that deserves to remain easy to recall later.';
}

function buildRecollection(sprint: MemorySprint, entries: MemoryEntry[], scopeType: 'space' | 'work'): string {
    const highlights = uniqueEntries(entries, 4);
    const dateRange = `${sprint.opened_at.substring(0, 10)} -> ${sprint.closes_at.substring(0, 10)}`;
    const heading = scopeType === 'work' ? 'Work recollection' : 'Space recollection';
    const highlightLines = highlights.map((entry) => `- ${entry.content}`).join('\n');
    const reflection = buildReflection(highlights);

    return `${heading} for sprint ${dateRange}.
Highlights:
${highlightLines}
Reflection: ${reflection}`;
}

function compactSprint(sprint: MemorySprint, currentIso: string): boolean {
    const entries = getDb()
        .prepare(
            `
        SELECT * FROM memory_entries
        WHERE scope_id = ?
          AND memory_sprint_id = ?
          AND scope_type IN ('space', 'work')
          AND kind != 'recollection'
        ORDER BY updated_at DESC
    `
        )
        .all(sprint.space_id, sprint.id) as MemoryEntry[];

    if (entries.length === 0) {
        getDb()
            .prepare(
                `
            UPDATE memory_sprints
            SET status = 'compacted', summary = ?, updated_at = ?
            WHERE id = ?
        `
            )
            .run('Quiet sprint with no notable structured memory to preserve.', currentIso, sprint.id);
        return false;
    }

    const spaceEntries = entries.filter((entry) => entry.scope_type === 'space');
    const workEntries = entries.filter((entry) => entry.scope_type === 'work');
    const summaryParts: string[] = [];

    for (const [scopeType, scopedEntries] of [
        ['space', spaceEntries],
        ['work', workEntries],
    ] as const) {
        if (scopedEntries.length === 0) continue;
        const recollection = buildRecollection(sprint, scopedEntries, scopeType);
        rememberMemoryEntry({
            scope_type: scopeType,
            scope_id: sprint.space_id,
            memory_sprint_id: null,
            kind: 'recollection',
            content: recollection,
            salience: 0.7,
            source: 'sprint_compaction',
        });
        summaryParts.push(recollection);
    }

    getDb()
        .prepare(
            `
        UPDATE memory_sprints
        SET status = 'compacted', summary = ?, updated_at = ?
        WHERE id = ?
    `
        )
        .run(summaryParts.join('\n\n'), currentIso, sprint.id);
    invalidateMemoryContextCache();
    return true;
}

export function compactClosedSprints(spaceId?: string, now?: Date): number {
    const currentIso = nowIso(now);
    const values: string[] = [];
    const where = spaceId ? "WHERE space_id = ? AND status = 'closed'" : "WHERE status = 'closed'";
    if (spaceId) values.push(spaceId);

    const closed = getDb()
        .prepare(
            `
        SELECT * FROM memory_sprints
        ${where}
        ORDER BY opened_at ASC
    `
        )
        .all(...values) as MemorySprint[];

    let compacted = 0;
    for (const sprint of closed) {
        if (compactSprint(sprint, currentIso)) {
            compacted += 1;
        }
    }
    return compacted;
}

export function compactExpiredSprintsForActiveSpaces(now?: Date): number {
    const currentIso = nowIso(now);
    let compacted = 0;

    for (const space of listSpaces('ACTIVE')) {
        closeExpiredSprints(space.id, currentIso);
        compacted += compactClosedSprints(space.id, now);
    }

    return compacted;
}

export function ensureActiveMemorySprint(spaceId: string, now?: Date): MemorySprint {
    const currentIso = nowIso(now);
    closeExpiredSprints(spaceId, currentIso);
    compactClosedSprints(spaceId, now);

    const existing = getDb()
        .prepare(
            `
        SELECT * FROM memory_sprints
        WHERE space_id = ?
          AND status = 'active'
          AND opened_at <= ?
          AND closes_at > ?
        ORDER BY opened_at DESC
        LIMIT 1
    `
        )
        .get(spaceId, currentIso, currentIso) as MemorySprint | undefined;

    if (existing) {
        return existing;
    }

    const cadenceDays = resolveMemorySprintDays(spaceId);
    const sprint: MemorySprint = {
        id: `sprint:${spaceId}:${currentIso}`,
        space_id: spaceId,
        opened_at: currentIso,
        closes_at: addDays(currentIso, cadenceDays),
        status: 'active',
        cadence_days: cadenceDays,
        summary: null,
        created_at: currentIso,
        updated_at: currentIso,
    };

    getDb()
        .prepare(
            `
        INSERT INTO memory_sprints (
            id, space_id, opened_at, closes_at, status, cadence_days, summary, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
        )
        .run(
            sprint.id,
            sprint.space_id,
            sprint.opened_at,
            sprint.closes_at,
            sprint.status,
            sprint.cadence_days,
            sprint.summary,
            sprint.created_at,
            sprint.updated_at
        );

    return sprint;
}

export function getEntriesForActiveSprint(
    scopeType: 'space' | 'work',
    spaceId: string,
    kind?: string,
    limit: number = 20
): MemoryEntry[] {
    const sprint = ensureActiveMemorySprint(spaceId);
    if (kind) {
        return getDb()
            .prepare(
                `
            SELECT * FROM memory_entries
            WHERE scope_type = ?
              AND scope_id = ?
              AND memory_sprint_id = ?
              AND kind = ?
            ORDER BY updated_at DESC
            LIMIT ?
        `
            )
            .all(scopeType, spaceId, sprint.id, kind, limit) as MemoryEntry[];
    }

    return getDb()
        .prepare(
            `
        SELECT * FROM memory_entries
        WHERE scope_type = ?
          AND scope_id = ?
          AND memory_sprint_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
    `
        )
        .all(scopeType, spaceId, sprint.id, limit) as MemoryEntry[];
}

export function getOlderLongMemoryEntries(spaceId: string, limit: number = 6): MemoryEntry[] {
    const sprint = ensureActiveMemorySprint(spaceId);
    const recollections = getDb()
        .prepare(
            `
        SELECT * FROM memory_entries
        WHERE scope_id = ?
          AND scope_type IN ('space', 'work')
          AND kind = 'recollection'
        ORDER BY salience DESC, updated_at DESC
        LIMIT ?
    `
        )
        .all(spaceId, limit) as MemoryEntry[];

    if (recollections.length > 0) {
        return recollections;
    }

    const currentSprintId = sprint.id;
    const olderStructured = getDb()
        .prepare(
            `
        SELECT * FROM memory_entries
        WHERE scope_id = ?
          AND scope_type IN ('space', 'work')
          AND kind != 'recollection'
          AND (memory_sprint_id IS NULL OR memory_sprint_id != ?)
        ORDER BY salience DESC, updated_at DESC
        LIMIT ?
    `
        )
        .all(spaceId, currentSprintId, limit) as MemoryEntry[];

    if (olderStructured.length > 0) {
        return olderStructured;
    }

    return getMemoryEntries('work', spaceId, undefined, limit);
}
