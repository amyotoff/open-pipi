import { ensureTelegramSpace, getAllResidents, getDb } from '../db';
import { HOUSEHOLD_CHAT_ID } from '../config';
import { invalidateMemoryContextCache } from './memory-context';

type BackfillCounts = {
    resident_notes: number;
    house_diary: number;
    daily_insights: number;
};

type LegacyResidentNote = {
    resident_tg_id: string | null;
    resident_name: string | null;
    fact: string;
    category: string | null;
    chat_jid?: string | null;
    scope?: string | null;
    created_at: string | null;
    updated_at: string | null;
};

type LegacyDiaryEntry = {
    date: string;
    entry: string;
    type: string | null;
    chat_jid?: string | null;
    scope?: string | null;
    created_at: string | null;
};

type LegacyDailyInsight = {
    date: string;
    resident_tg_id: string | null;
    insight: string;
    chat_jid?: string | null;
    scope?: string | null;
    created_at: string | null;
};

function normalizeName(value: string | null | undefined): string {
    return (value || '').trim().toLowerCase();
}

function householdSpaceId(): string | null {
    if (!HOUSEHOLD_CHAT_ID) return null;
    return ensureTelegramSpace(HOUSEHOLD_CHAT_ID, 'group', HOUSEHOLD_CHAT_ID).id;
}

function resolveLegacyPersonScopeId(note: LegacyResidentNote): string | null {
    if (note.resident_tg_id) return note.resident_tg_id;

    const normalized = normalizeName(note.resident_name);
    if (!normalized) return null;

    const resident = getAllResidents().find((item) =>
        [item.nickname, item.display_name, item.username, item.tg_id]
            .filter(Boolean)
            .some((value) => value!.trim().toLowerCase() === normalized)
    );

    return resident?.tg_id || `name:${normalized}`;
}

function resolveLegacyNoteTarget(
    note: LegacyResidentNote,
    defaultSpaceId: string | null
): {
    scope_type: 'person' | 'space';
    scope_id: string;
} | null {
    const normalized = normalizeName(note.resident_name);
    if ((normalized === 'household' || normalized === 'group' || normalized === 'space') && defaultSpaceId) {
        return { scope_type: 'space', scope_id: defaultSpaceId };
    }

    const personScopeId = resolveLegacyPersonScopeId(note);
    if (!personScopeId) return null;
    return { scope_type: 'person', scope_id: personScopeId };
}

function isoFromDate(date: string | null | undefined, fallbackDate?: string): string {
    if (date && date.includes('T')) return date;
    const base = date || fallbackDate || new Date().toISOString().split('T')[0];
    return `${base}T12:00:00.000Z`;
}

function tableExists(tableName: string): boolean {
    const row = getDb()
        .prepare(
            `
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
    `
        )
        .get(tableName) as { name: string } | undefined;
    return Boolean(row?.name);
}

function columnExists(tableName: string, columnName: string): boolean {
    if (!tableExists(tableName)) return false;
    const rows = getDb().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
}

function legacyScopedSelect(tableName: string, columns: string[]): string {
    const chatColumn = columnExists(tableName, 'chat_jid') ? 'chat_jid' : 'NULL as chat_jid';
    const scopeColumn = columnExists(tableName, 'scope') ? 'scope' : "'global' as scope";
    return [...columns, chatColumn, scopeColumn].join(', ');
}

function normalizeLegacyScope(scope: string | null | undefined): 'global' | 'private' | 'household' {
    const normalized = (scope || 'global').trim().toLowerCase();
    return normalized === 'private' || normalized === 'household' ? normalized : 'global';
}

function legacyChatSpaceId(chatJid: string): string {
    return ensureTelegramSpace(chatJid, chatJid === HOUSEHOLD_CHAT_ID ? 'group' : 'private', chatJid).id;
}

function legacySpaceBoundId(row: { chat_jid?: string | null; scope?: string | null }, defaultSpaceId: string | null) {
    const chatJid = row.chat_jid?.trim();
    if (chatJid) return legacyChatSpaceId(chatJid);
    return normalizeLegacyScope(row.scope) === 'household' ? defaultSpaceId : null;
}

function legacySpaceScopeId(row: { chat_jid?: string | null; scope?: string | null }, defaultSpaceId: string | null) {
    const chatJid = row.chat_jid?.trim();
    if (chatJid) return legacyChatSpaceId(chatJid);
    if (normalizeLegacyScope(row.scope) === 'private') return null;
    return defaultSpaceId;
}

function hasUnresolvablePrivateScope(row: { chat_jid?: string | null; scope?: string | null }): boolean {
    return normalizeLegacyScope(row.scope) === 'private' && !row.chat_jid?.trim();
}

function insertBackfilledMemoryEntry(entry: {
    scope_type: 'person' | 'space' | 'work';
    scope_id: string;
    kind: string;
    content: string;
    salience: number;
    source: string;
    space_bound_id?: string | null;
    created_at: string;
    updated_at: string;
}): boolean {
    const db = getDb();
    const existing = db
        .prepare(
            `
        SELECT id FROM memory_entries
        WHERE scope_type = ?
          AND scope_id = ?
          AND kind = ?
          AND content = ?
          AND source = ?
          AND COALESCE(space_bound_id, '') = COALESCE(?, '')
        LIMIT 1
    `
        )
        .get(
            entry.scope_type,
            entry.scope_id,
            entry.kind,
            entry.content,
            entry.source,
            entry.space_bound_id || null
        ) as { id: number } | undefined;

    if (existing) return false;

    db.prepare(
        `
        INSERT INTO memory_entries (
            scope_type, scope_id, memory_sprint_id, kind, content, salience, source, space_bound_id, created_at, updated_at
        )
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
        entry.scope_type,
        entry.scope_id,
        entry.kind,
        entry.content,
        entry.salience,
        entry.source,
        entry.space_bound_id || null,
        entry.created_at,
        entry.updated_at
    );

    return true;
}

export function backfillLegacyMemory(): BackfillCounts {
    const db = getDb();
    const defaultSpaceId = householdSpaceId();
    const counts: BackfillCounts = {
        resident_notes: 0,
        house_diary: 0,
        daily_insights: 0,
    };

    if (tableExists('resident_notes')) {
        const notes = db
            .prepare(
                `
            SELECT ${legacyScopedSelect('resident_notes', [
                'resident_tg_id',
                'resident_name',
                'fact',
                'category',
                'created_at',
                'updated_at',
            ])}
            FROM resident_notes
            ORDER BY id ASC
        `
            )
            .all() as LegacyResidentNote[];

        for (const note of notes) {
            if (hasUnresolvablePrivateScope(note)) continue;
            const rowSpaceId = legacySpaceScopeId(note, defaultSpaceId);
            const target = resolveLegacyNoteTarget(note, rowSpaceId);
            if (!target) continue;

            const inserted = insertBackfilledMemoryEntry({
                scope_type: target.scope_type,
                scope_id: target.scope_id,
                kind: note.category || 'general',
                content: note.fact.trim(),
                salience: target.scope_type === 'person' ? 0.8 : 0.7,
                source: 'legacy_backfill_resident_note',
                space_bound_id: target.scope_type === 'person' ? legacySpaceBoundId(note, defaultSpaceId) : null,
                created_at: isoFromDate(note.created_at),
                updated_at: isoFromDate(note.updated_at, note.created_at || undefined),
            });

            if (inserted) counts.resident_notes += 1;
        }
    }

    if (defaultSpaceId && tableExists('house_diary')) {
        const diaryEntries = db
            .prepare(
                `
            SELECT ${legacyScopedSelect('house_diary', ['date', 'entry', 'type', 'created_at'])}
            FROM house_diary
            ORDER BY date ASC, id ASC
        `
            )
            .all() as LegacyDiaryEntry[];

        for (const diaryEntry of diaryEntries) {
            if (hasUnresolvablePrivateScope(diaryEntry)) continue;
            const rowSpaceId = legacySpaceScopeId(diaryEntry, defaultSpaceId);
            if (!rowSpaceId) continue;
            const kind = diaryEntry.type === 'weekly_summary' ? 'recollection' : 'diary';
            const content =
                kind === 'recollection'
                    ? `Legacy diary recollection for ${diaryEntry.date}: ${diaryEntry.entry.trim()}`
                    : diaryEntry.entry.trim();

            const inserted = insertBackfilledMemoryEntry({
                scope_type: 'space',
                scope_id: rowSpaceId,
                kind,
                content,
                salience: kind === 'recollection' ? 0.65 : 0.45,
                source: kind === 'recollection' ? 'legacy_backfill_weekly_summary' : 'legacy_backfill_diary',
                created_at: isoFromDate(diaryEntry.created_at, diaryEntry.date),
                updated_at: isoFromDate(diaryEntry.created_at, diaryEntry.date),
            });

            if (inserted) counts.house_diary += 1;
        }
    }

    if (tableExists('daily_insights')) {
        const insights = db
            .prepare(
                `
            SELECT ${legacyScopedSelect('daily_insights', ['date', 'resident_tg_id', 'insight', 'created_at'])}
            FROM daily_insights
            ORDER BY date ASC, id ASC
        `
            )
            .all() as LegacyDailyInsight[];

        for (const insight of insights) {
            if (hasUnresolvablePrivateScope(insight)) continue;
            const rowSpaceId = legacySpaceScopeId(insight, defaultSpaceId);
            const target = insight.resident_tg_id
                ? { scope_type: 'person' as const, scope_id: insight.resident_tg_id }
                : rowSpaceId
                  ? { scope_type: 'work' as const, scope_id: rowSpaceId }
                  : null;
            if (!target) continue;

            const inserted = insertBackfilledMemoryEntry({
                scope_type: target.scope_type,
                scope_id: target.scope_id,
                kind: 'insight',
                content: insight.insight.trim(),
                salience: 0.6,
                source: 'legacy_backfill_daily_insight',
                space_bound_id: target.scope_type === 'person' ? legacySpaceBoundId(insight, defaultSpaceId) : null,
                created_at: isoFromDate(insight.created_at, insight.date),
                updated_at: isoFromDate(insight.created_at, insight.date),
            });

            if (inserted) counts.daily_insights += 1;
        }
    }

    if (counts.resident_notes || counts.house_diary || counts.daily_insights) {
        invalidateMemoryContextCache();
    }

    return counts;
}
