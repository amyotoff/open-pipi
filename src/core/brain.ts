import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
    BrainScopeInput,
    MAX_NOTE_TEXT_CHARS,
    MAX_TAGS,
    assertTextLimit,
    brainPath,
    clampLimit,
    dayStamp,
    ensureBrainDirs,
    getBrainDb,
    listMarkdownFiles,
    nowIso,
    registerIndexRebuilder,
    scopedRelativePath,
    sharedScope,
    toScope,
} from './brain-store';
import {
    normalizeWikiPath,
    parseJsonFrontmatter,
    projectWikiIndexFile,
    readWikiPage,
    reindexWikiTree,
    writeWikiPageInternal,
} from './brain-wiki';
import { reindexRawTree } from './brain-ingest';
import { generateBrainText, parseModelJson } from './brain-model';
import { getBrainSchema } from './brain-schema';

/**
 * The notebook: append-only working memory the agent writes before anything is
 * canonical. Notes live inside daily markdown files as delimited blocks, so the
 * SQLite index stays fully reconstructible from the files (see brain-store.ts).
 */

export type BrainNoteStatus = 'open' | 'promoted' | 'rejected' | 'superseded' | 'needs_review';

export interface BrainNote {
    id: string;
    topic: string;
    text: string;
    tags: string[];
    status: BrainNoteStatus;
    file_path: string;
    promoted_to: string | null;
    created_at: string;
    updated_at: string;
}

type BrainNoteMeta = {
    id: string;
    delimiter: string;
    topic: string;
    tags: string[];
    status: BrainNoteStatus;
    created_at: string;
    updated_at: string;
};

type BrainNoteEvent = {
    note_id: string;
    event_type: 'promoted' | 'rejected' | 'superseded' | 'needs_review';
    target_page?: string;
    created_at: string;
};

type BrainNoteRow = {
    id: string;
    topic: string;
    text: string;
    tags_json: string;
    status: BrainNoteStatus;
    file_path: string;
    promoted_to: string | null;
    created_at: string;
    updated_at: string;
};

const NOTE_BLOCK_RE = /<!-- brain-note:([a-f0-9-]+)\n([\s\S]*?)\n-->\n([\s\S]*?)\n<!-- \/brain-note:\1 -->/g;
const NOTE_EVENT_RE = /<!-- brain-note-event:([a-f0-9-]+)\n([\s\S]*?)\n-->/g;
const MAX_MERGE_PROMPT_CHARS = 24_000;

export type { BrainScopeInput };
export { closeBrainDatabases, ensureBrainDirs, getBrainRoot, getBrainScopeRoot } from './brain-store';
export type { BrainWikiPage, BrainWikiSummary, WikiLogEntry } from './brain-wiki';
export {
    appendWikiLog,
    listWikiPages,
    projectWikiIndexFile,
    readWikiLog,
    readWikiPage,
    updateWikiPage,
} from './brain-wiki';

function normalizeTopic(topic: string): string {
    const normalized = topic.trim();
    return normalized || 'general';
}

function normalizeTags(tags?: string[], options?: { strict?: boolean }): string[] {
    const normalized = [...new Set((tags || []).map((tag) => tag.trim()).filter(Boolean))];
    if (options?.strict && normalized.length > MAX_TAGS) {
        throw new Error(`Notebook notes support at most ${MAX_TAGS} tags.`);
    }
    return normalized.slice(0, MAX_TAGS);
}

function safeRelativePath(input: string, kind: 'notebook' | 'wiki'): string {
    const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
    if (
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.includes('/../') ||
        normalized.includes('\0') ||
        path.isAbsolute(normalized)
    ) {
        throw new Error(`Unsafe ${kind} path: ${input}`);
    }
    if (kind === 'notebook' && !normalized.startsWith('notebook/')) {
        throw new Error(`Unsafe notebook path: ${input}`);
    }
    if (kind === 'wiki' && !normalized.endsWith('.md')) {
        throw new Error('Wiki pages must be Markdown files ending in .md.');
    }
    return normalized;
}

function ensureDailyNotebookFile(filePath: string, date: string): void {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# Notebook / ${date}\n`, 'utf-8');
}

function noteBlock(meta: BrainNoteMeta, text: string): string {
    return `\n\n<!-- brain-note:${meta.delimiter}\n${JSON.stringify(meta, null, 2)}\n-->\n${text.trim()}\n<!-- /brain-note:${meta.delimiter} -->\n`;
}

function noteEventBlock(event: BrainNoteEvent): string {
    const delimiter = randomUUID();
    return `\n\n<!-- brain-note-event:${delimiter}\n${JSON.stringify(event, null, 2)}\n-->\n`;
}

function parseNoteBlocks(scope: BrainScopeInput | undefined, raw: string, filePath: string): BrainNote[] {
    const notes: BrainNote[] = [];
    for (const match of raw.matchAll(NOTE_BLOCK_RE)) {
        try {
            const meta = JSON.parse(match[2].trim()) as BrainNoteMeta;
            if (meta.delimiter !== match[1]) continue;
            notes.push({
                id: meta.id,
                topic: normalizeTopic(meta.topic),
                text: match[3].trim(),
                tags: normalizeTags(meta.tags),
                status: meta.status || 'open',
                file_path: scopedRelativePath(scope, filePath),
                promoted_to: null,
                created_at: meta.created_at,
                updated_at: meta.updated_at || meta.created_at,
            });
        } catch {
            continue;
        }
    }
    return notes;
}

function parseNoteEvents(raw: string): BrainNoteEvent[] {
    const events: BrainNoteEvent[] = [];
    for (const match of raw.matchAll(NOTE_EVENT_RE)) {
        try {
            events.push(JSON.parse(match[2].trim()) as BrainNoteEvent);
        } catch {
            continue;
        }
    }
    return events;
}

function insertNote(db: Database.Database, note: BrainNote): void {
    db.prepare(
        `
        INSERT INTO notes (id, topic, text, tags_json, status, file_path, promoted_to, created_at, updated_at)
        VALUES (@id, @topic, @text, @tags_json, @status, @file_path, @promoted_to, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
            topic = excluded.topic,
            text = excluded.text,
            tags_json = excluded.tags_json,
            status = excluded.status,
            file_path = excluded.file_path,
            promoted_to = excluded.promoted_to,
            updated_at = excluded.updated_at
    `
    ).run({
        ...note,
        tags_json: JSON.stringify(note.tags),
    });
}

function insertNoteEvent(db: Database.Database, event: BrainNoteEvent): void {
    db.prepare(
        `
        INSERT INTO note_events (note_id, event_type, target_page, created_at)
        VALUES (@note_id, @event_type, @target_page, @created_at)
    `
    ).run({
        note_id: event.note_id,
        event_type: event.event_type,
        target_page: event.target_page || null,
        created_at: event.created_at,
    });
}

function applyEvents(notes: BrainNote[], events: BrainNoteEvent[]): BrainNote[] {
    const byId = new Map(notes.map((note) => [note.id, { ...note }]));
    for (const event of events.sort((left, right) => left.created_at.localeCompare(right.created_at))) {
        const note = byId.get(event.note_id);
        if (!note) continue;
        note.status = event.event_type;
        note.promoted_to = event.event_type === 'promoted' ? event.target_page || null : note.promoted_to;
        note.updated_at = event.created_at;
    }
    return [...byId.values()];
}

/**
 * Rebuild every derived table from markdown alone. Deleting indexes/sqlite.db and
 * calling this must produce an identical index — that invariant is what lets git be
 * the wiki's history and lets restore points actually restore.
 */
export function rebuildBrainIndex(scope?: BrainScopeInput): {
    notes: number;
    events: number;
    wiki_pages: number;
    raw_sources: number;
} {
    ensureBrainDirs(scope);
    const notebookFiles = listMarkdownFiles(brainPath(scope, 'notebook'));
    const notes: BrainNote[] = [];
    const events: BrainNoteEvent[] = [];

    for (const filePath of notebookFiles) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        notes.push(...parseNoteBlocks(scope, raw, filePath));
        events.push(...parseNoteEvents(raw));
    }

    const db = getBrainDb(scope);
    const appliedNotes = applyEvents(notes, events);
    const rebuild = db.transaction(() => {
        db.exec(
            'DELETE FROM notes; DELETE FROM note_events; DELETE FROM wiki_pages; DELETE FROM wiki_links; DELETE FROM wiki_fts; DELETE FROM raw_sources;'
        );
        for (const note of appliedNotes) insertNote(db, note);
        for (const event of events) insertNoteEvent(db, event);
    });

    rebuild();
    const wikiPages = reindexWikiTree(scope);
    const rawSources = reindexRawTree(scope);
    projectWikiIndexFile(scope);

    return { notes: appliedNotes.length, events: events.length, wiki_pages: wikiPages, raw_sources: rawSources };
}

// Recovers the index whenever a schema change empties it (see getBrainDb).
registerIndexRebuilder((scope) => {
    rebuildBrainIndex(scope);
});

export function appendNote(
    input: { topic: string; text: string; tags?: string[]; now?: Date } & BrainScopeInput
): BrainNote {
    const scope = toScope(input);
    const topic = normalizeTopic(input.topic);
    const text = input.text.trim();
    if (!text) {
        throw new Error('Notebook note text cannot be empty.');
    }
    assertTextLimit('Notebook note text', text, MAX_NOTE_TEXT_CHARS);

    const createdAt = nowIso(input.now);
    const date = dayStamp(createdAt);
    const delimiter = randomUUID();
    const id = `note_${date.replace(/-/g, '')}_${randomUUID()}`;
    const filePath = brainPath(scope, 'notebook', 'daily', `${date}.md`);
    const meta: BrainNoteMeta = {
        id,
        delimiter,
        topic,
        tags: normalizeTags(input.tags, { strict: true }),
        status: 'open',
        created_at: createdAt,
        updated_at: createdAt,
    };
    const note: BrainNote = {
        ...meta,
        text,
        file_path: scopedRelativePath(scope, filePath),
        promoted_to: null,
    };

    const db = getBrainDb(scope);
    insertNote(db, note);
    try {
        ensureDailyNotebookFile(filePath, date);
        fs.appendFileSync(filePath, noteBlock(meta, text), 'utf-8');
    } catch (error) {
        db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
        throw error;
    }

    return note;
}

function hydrateNote(row: BrainNoteRow): BrainNote {
    return {
        id: row.id,
        topic: row.topic,
        text: row.text,
        tags: JSON.parse(row.tags_json || '[]'),
        status: row.status,
        file_path: row.file_path,
        promoted_to: row.promoted_to,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

export function getNote(noteId: string, scope?: BrainScopeInput): BrainNote | undefined {
    const row = getBrainDb(scope).prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as BrainNoteRow | undefined;
    return row ? hydrateNote(row) : undefined;
}

export function searchNotes(input: { query?: string; limit?: number } & BrainScopeInput): BrainNote[] {
    const limit = clampLimit(input.limit, 8, 1, 30);
    const query = (input.query || '').trim().toLowerCase();
    const db = getBrainDb(input);
    const rows = !query
        ? (db.prepare('SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?').all(limit) as BrainNoteRow[])
        : (db
              .prepare(
                  `
                SELECT * FROM notes
                WHERE LOWER(topic) LIKE ?
                   OR LOWER(text) LIKE ?
                   OR LOWER(tags_json) LIKE ?
                   OR LOWER(id) LIKE ?
                ORDER BY updated_at DESC
                LIMIT ?
            `
              )
              .all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit) as BrainNoteRow[]);

    return rows.map(hydrateNote);
}

export function listNotesByTopic(input: { topic: string; limit?: number } & BrainScopeInput): BrainNote[] {
    const topic = normalizeTopic(input.topic).toLowerCase();
    const limit = clampLimit(input.limit, 20, 1, 50);
    const rows = getBrainDb(input)
        .prepare(
            `
            SELECT * FROM notes
            WHERE LOWER(topic) = ?
            ORDER BY updated_at DESC
            LIMIT ?
        `
        )
        .all(topic, limit) as BrainNoteRow[];

    return rows.map(hydrateNote);
}

function wikiTitle(relativePath: string): string {
    const base = path.posix.basename(relativePath, '.md');
    return base
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function promotedNoteEntry(note: BrainNote): string {
    const tagText = note.tags.length > 0 ? `\nTags: ${note.tags.join(', ')}` : '';
    return `### ${note.id}\nSource note: ${note.id}\nTopic: ${note.topic}${tagText}\n\n${note.text}`;
}

function appendPromotionEvent(scope: BrainScopeInput | undefined, note: BrainNote, targetPage: string): BrainNoteEvent {
    const createdAt = nowIso();
    const safeNotePath = safeRelativePath(note.file_path, 'notebook');
    const filePath = brainPath(scope, ...safeNotePath.split('/'));
    const event: BrainNoteEvent = {
        note_id: note.id,
        event_type: 'promoted',
        target_page: targetPage,
        created_at: createdAt,
    };

    fs.appendFileSync(filePath, noteEventBlock(event), 'utf-8');
    const db = getBrainDb(scope);
    insertNoteEvent(db, event);
    db.prepare(
        `
        UPDATE notes
        SET status = 'promoted', promoted_to = ?, updated_at = ?
        WHERE id = ?
    `
    ).run(targetPage, createdAt, note.id);

    return event;
}

const PROMOTE_SYSTEM = [
    'You fold one notebook note into a page of a personal knowledge wiki that you maintain.',
    'Merge the note into the section where the knowledge belongs. Rewrite that prose so the page',
    'reads as one compiled article — never append the note verbatim, and never add a section that',
    'only exists to hold notes.',
    'Preserve everything on the page that the note does not change. Keep every number, date and',
    'quote exactly as the note or the page states it; invent nothing.',
    'If the note contradicts the page, keep the old claim and mark it:',
    '"> **Status: Disputed**" followed by an explanation line.',
    'Reply with JSON only: {"body": "the complete revised markdown body, starting with # Title"}.',
].join('\n');

/**
 * Fold a note into a page (D6). The old behaviour appended the note's text under a
 * "Promoted Notebook Notes" heading, which produced a scrapbook rather than a compiled
 * page. That path survives only as a visible fallback: when no model is available the
 * note is still filed, and the page is marked `needs_review` so lint can find it.
 */
export async function promoteNoteToWiki(
    input: { note_id: string; target_page: string } & BrainScopeInput
): Promise<{ path: string; file_path: string; exists: boolean; content: string; compiled: boolean }> {
    const scope = toScope(input);
    const note = getNote(input.note_id, scope);
    if (!note) {
        throw new Error(`Notebook note not found: ${input.note_id}`);
    }

    const relativePath = normalizeWikiPath(input.target_page);
    if (!scope.shared && scope.spaceId && readWikiPage(relativePath, sharedScope(scope)).exists) {
        throw new Error(
            `${relativePath} lives in the shared wiki, which is what everyone reads. Use wiki_save to change it.`
        );
    }

    const absolutePath = brainPath(scope, 'wiki', ...relativePath.split('/'));
    const existingRaw = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : '';
    const parsed = parseJsonFrontmatter(existingRaw);
    const currentBody = parsed.body || `# ${wikiTitle(relativePath)}\n`;
    const sources = [...new Set([...(Array.isArray(parsed.meta.sources) ? parsed.meta.sources : []), note.id])];

    let body = currentBody;
    let compiled = false;
    // Above this the model cannot be shown the whole page, and a returned "full" body
    // would silently drop the tail — so the safe append path is used instead.
    const tooLongToMerge = currentBody.length > MAX_MERGE_PROMPT_CHARS;

    try {
        if (tooLongToMerge) throw new Error('page exceeds the merge prompt budget');
        const text = await generateBrainText({
            system: `${PROMOTE_SYSTEM}\n\n<schema>\n${getBrainSchema(scope)}\n</schema>`,
            mode: 'advisor',
            spaceId: input.spaceId,
            temperature: 0.3,
            prompt: [
                `<page path="${relativePath}">`,
                currentBody,
                '</page>',
                `<note topic="${note.topic}" tags="${note.tags.join(', ')}">`,
                note.text,
                '</note>',
            ].join('\n'),
        });
        const merged = parseModelJson<{ body?: string }>(text)?.body?.trim();
        if (merged && merged.length > 0) {
            body = merged;
            compiled = true;
        }
    } catch {
        // Fall through to the visible fallback below.
    }

    if (!compiled && !body.includes(`Source note: ${note.id}`)) {
        const heading = '## Promoted Notebook Notes';
        if (!body.includes(heading)) {
            body = `${body.trim()}\n\n${heading}\n`;
        }
        body = `${body.trimEnd()}\n\n${promotedNoteEntry(note)}\n`;
    }

    const page = writeWikiPageInternal(scope, relativePath, body, {
        ...parsed.meta,
        sources,
        status: compiled ? parsed.meta.status || 'canonical' : 'needs_review',
    });
    if (!(note.status === 'promoted' && note.promoted_to === relativePath)) {
        appendPromotionEvent(scope, note, relativePath);
    }
    return { ...page, compiled };
}

export function compileNotebook(input: { topic: string; limit?: number } & BrainScopeInput): string {
    const topic = normalizeTopic(input.topic);
    const notes = listNotesByTopic({ ...input, topic, limit: clampLimit(input.limit, 20, 1, 50) });
    if (notes.length === 0) {
        return `# Notebook Compilation / ${topic}\n\nNo matching notebook notes were found.`;
    }

    const groups: BrainNoteStatus[] = ['open', 'needs_review', 'promoted', 'superseded', 'rejected'];
    const lines = [`# Notebook Compilation / ${topic}`];

    for (const status of groups) {
        const scoped = notes.filter((note) => note.status === status);
        if (scoped.length === 0) continue;
        lines.push(`\n## ${status.replace('_', ' ')}`);
        for (const note of scoped) {
            const target = note.promoted_to ? ` -> ${note.promoted_to}` : '';
            const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
            lines.push(`- ${note.id}${target}${tags}: ${note.text.substring(0, 220)}`);
        }
    }

    return lines.join('\n');
}
