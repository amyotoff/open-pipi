import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { DATA_DIR } from '../config';

export type BrainNoteStatus = 'open' | 'promoted' | 'rejected' | 'superseded' | 'needs_review';

export interface BrainScopeInput {
    spaceId?: string;
}

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

export interface BrainWikiPage {
    path: string;
    file_path: string;
    exists: boolean;
    content: string;
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

type ParsedFrontmatter = {
    meta: Record<string, unknown>;
    body: string;
    hasFrontmatter: boolean;
};

const NOTE_BLOCK_RE = /<!-- brain-note:([a-f0-9-]+)\n([\s\S]*?)\n-->\n([\s\S]*?)\n<!-- \/brain-note:\1 -->/g;
const NOTE_EVENT_RE = /<!-- brain-note-event:([a-f0-9-]+)\n([\s\S]*?)\n-->/g;
const MAX_TAGS = 12;
const MAX_NOTE_TEXT_CHARS = 64 * 1024;
const MAX_WIKI_BODY_CHARS = 512 * 1024;

const dbCache = new Map<string, Database.Database>();

function nowIso(now?: Date): string {
    return (now || new Date()).toISOString();
}

function dayStamp(iso: string): string {
    return iso.substring(0, 10);
}

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

function clampLimit(limit: number | undefined, fallback: number, min: number, max: number): number {
    const value = Number(limit);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), min), max);
}

function assertTextLimit(label: string, text: string, maxChars: number): void {
    if (text.length > maxChars) {
        throw new Error(`${label} is too large (${text.length} chars, max ${maxChars}).`);
    }
}

function scopeRootSegment(scope?: BrainScopeInput): string[] {
    const spaceId = scope?.spaceId?.trim();
    return spaceId ? ['spaces', encodeURIComponent(spaceId)] : ['global'];
}

export function getBrainRoot(): string {
    return path.join(DATA_DIR, 'pipi-brain');
}

export function getBrainScopeRoot(scope?: BrainScopeInput): string {
    return path.join(getBrainRoot(), ...scopeRootSegment(scope));
}

function brainPath(scope: BrainScopeInput | undefined, ...segments: string[]): string {
    return path.join(getBrainScopeRoot(scope), ...segments);
}

export function ensureBrainDirs(scope?: BrainScopeInput): void {
    const dirs = [
        brainPath(scope, 'raw', 'chats'),
        brainPath(scope, 'raw', 'links'),
        brainPath(scope, 'raw', 'docs'),
        brainPath(scope, 'raw', 'transcripts'),
        brainPath(scope, 'notebook', 'daily'),
        brainPath(scope, 'notebook', 'project'),
        brainPath(scope, 'notebook', 'scratch'),
        brainPath(scope, 'wiki', 'projects'),
        brainPath(scope, 'wiki', 'entities', 'people'),
        brainPath(scope, 'wiki', 'entities', 'companies'),
        brainPath(scope, 'wiki', 'entities', 'tools'),
        brainPath(scope, 'wiki', 'entities', 'cities'),
        brainPath(scope, 'wiki', 'decisions'),
        brainPath(scope, 'wiki', 'principles'),
        brainPath(scope, 'wiki', 'playbooks'),
        brainPath(scope, 'playbooks'),
        brainPath(scope, 'indexes'),
    ];

    for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function indexPath(scope?: BrainScopeInput): string {
    ensureBrainDirs(scope);
    return brainPath(scope, 'indexes', 'sqlite.db');
}

function getBrainDb(scope?: BrainScopeInput): Database.Database {
    const dbPath = indexPath(scope);
    const cached = dbCache.get(dbPath);
    if (cached) return cached;

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    ensureBrainSchema(db);
    dbCache.set(dbPath, db);
    return db;
}

export function closeBrainDatabases(): void {
    for (const db of dbCache.values()) {
        db.close();
    }
    dbCache.clear();
}

function ensureBrainSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            text TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            status TEXT NOT NULL,
            file_path TEXT NOT NULL,
            promoted_to TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brain_notes_topic_updated
            ON notes(topic, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_brain_notes_status_updated
            ON notes(status, updated_at DESC);

        CREATE TABLE IF NOT EXISTS note_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            target_page TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brain_note_events_note
            ON note_events(note_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS wiki_pages (
            path TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            excerpt TEXT NOT NULL,
            sources_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
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

function scopedRelativePath(scope: BrainScopeInput | undefined, filePath: string): string {
    return path.relative(getBrainScopeRoot(scope), filePath).split(path.sep).join(path.posix.sep);
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

function listMarkdownFiles(root: string): string[] {
    if (!fs.existsSync(root)) return [];

    const result: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const filePath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            result.push(...listMarkdownFiles(filePath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            result.push(filePath);
        }
    }
    return result.sort();
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

export function rebuildBrainIndex(scope?: BrainScopeInput): { notes: number; events: number; wiki_pages: number } {
    ensureBrainDirs(scope);
    const notebookFiles = listMarkdownFiles(brainPath(scope, 'notebook'));
    const wikiFiles = listMarkdownFiles(brainPath(scope, 'wiki'));
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
        db.exec('DELETE FROM notes; DELETE FROM note_events; DELETE FROM wiki_pages;');
        for (const note of appliedNotes) insertNote(db, note);
        for (const event of events) insertNoteEvent(db, event);
        for (const filePath of wikiFiles) {
            const relative = path.relative(brainPath(scope, 'wiki'), filePath).split(path.sep).join(path.posix.sep);
            indexWikiPage(db, relative, fs.readFileSync(filePath, 'utf-8'));
        }
    });

    rebuild();
    return { notes: appliedNotes.length, events: events.length, wiki_pages: wikiFiles.length };
}

export function appendNote(
    input: { topic: string; text: string; tags?: string[]; now?: Date } & BrainScopeInput
): BrainNote {
    const scope = { spaceId: input.spaceId };
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

function normalizeWikiPath(targetPath: string): string {
    if (targetPath.trim().startsWith('/') || path.isAbsolute(targetPath)) {
        throw new Error(`Unsafe wiki path: ${targetPath}`);
    }
    const raw = targetPath
        .trim()
        .replace(/\\/g, '/')
        .replace(/^wiki\//, '');
    const withExtension = raw ? (path.posix.extname(raw) ? raw : `${raw}.md`) : 'index.md';
    const normalized = path.posix.normalize(withExtension);

    if (
        normalized === '.' ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized.includes('/../') ||
        normalized.includes('\0') ||
        path.isAbsolute(normalized)
    ) {
        throw new Error(`Unsafe wiki path: ${targetPath}`);
    }
    if (!normalized.endsWith('.md')) {
        throw new Error('Wiki pages must be Markdown files ending in .md.');
    }

    return normalized;
}

function parseJsonFrontmatter(raw: string): ParsedFrontmatter {
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) {
        return { meta: {}, body: raw.trim(), hasFrontmatter: false };
    }

    try {
        return {
            meta: JSON.parse(match[1].trim()),
            body: match[2].trim(),
            hasFrontmatter: true,
        };
    } catch {
        return { meta: {}, body: raw.trim(), hasFrontmatter: false };
    }
}

function wikiTitle(relativePath: string): string {
    const base = path.posix.basename(relativePath, '.md');
    return base
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function firstHeading(body: string, relativePath: string): string {
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return heading || wikiTitle(relativePath);
}

function excerpt(body: string): string {
    return body
        .replace(/^---[\s\S]*?---/m, '')
        .replace(/[#>*_`-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 240);
}

function arrayMeta(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function indexWikiPage(db: Database.Database, relativePath: string, content: string): void {
    const parsed = parseJsonFrontmatter(content);
    const body = parsed.body;
    db.prepare(
        `
        INSERT INTO wiki_pages (path, title, excerpt, sources_json, updated_at)
        VALUES (@path, @title, @excerpt, @sources_json, @updated_at)
        ON CONFLICT(path) DO UPDATE SET
            title = excluded.title,
            excerpt = excluded.excerpt,
            sources_json = excluded.sources_json,
            updated_at = excluded.updated_at
    `
    ).run({
        path: relativePath,
        title: firstHeading(body, relativePath),
        excerpt: excerpt(body),
        sources_json: JSON.stringify(arrayMeta(parsed.meta.sources)),
        updated_at: typeof parsed.meta.updated_at === 'string' ? parsed.meta.updated_at : nowIso(),
    });
}

function writeWikiPage(
    scope: BrainScopeInput | undefined,
    relativePath: string,
    body: string,
    metaPatch?: Record<string, unknown>
): BrainWikiPage {
    assertTextLimit('Wiki page body', body, MAX_WIKI_BODY_CHARS);
    const absolutePath = brainPath(scope, 'wiki', ...relativePath.split('/'));
    const existingRaw = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : '';
    const existing = parseJsonFrontmatter(existingRaw);
    const currentIso = nowIso();
    const meta = {
        id: `wiki_${relativePath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
        status: 'canonical',
        frontmatter_format: 'json',
        created_at: existing.meta.created_at || currentIso,
        ...existing.meta,
        ...(metaPatch || {}),
        updated_at: currentIso,
    };
    // JSON frontmatter is intentional: it keeps Brain pages dependency-free and machine-readable.
    const content = `---\n${JSON.stringify(meta, null, 2)}\n---\n${body.trim()}\n`;

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf-8');
    indexWikiPage(getBrainDb(scope), relativePath, content);

    return {
        path: relativePath,
        file_path: scopedRelativePath(scope, absolutePath),
        exists: true,
        content,
    };
}

export function readWikiPage(targetPath: string, scope?: BrainScopeInput): BrainWikiPage {
    const relativePath = normalizeWikiPath(targetPath);
    const absolutePath = brainPath(scope, 'wiki', ...relativePath.split('/'));
    if (!fs.existsSync(absolutePath)) {
        return {
            path: relativePath,
            file_path: scopedRelativePath(scope, absolutePath),
            exists: false,
            content: '',
        };
    }

    return {
        path: relativePath,
        file_path: scopedRelativePath(scope, absolutePath),
        exists: true,
        content: fs.readFileSync(absolutePath, 'utf-8'),
    };
}

export function updateWikiPage(input: { path: string; body: string } & BrainScopeInput): BrainWikiPage {
    const relativePath = normalizeWikiPath(input.path);
    const body = input.body.trim();
    if (!body) {
        throw new Error('Wiki update cannot be empty.');
    }

    const parsed = parseJsonFrontmatter(body);
    return writeWikiPage(input, relativePath, parsed.hasFrontmatter ? parsed.body : body, parsed.meta);
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

export function promoteNoteToWiki(input: { note_id: string; target_page: string } & BrainScopeInput): BrainWikiPage {
    const scope = { spaceId: input.spaceId };
    const note = getNote(input.note_id, scope);
    if (!note) {
        throw new Error(`Notebook note not found: ${input.note_id}`);
    }

    const relativePath = normalizeWikiPath(input.target_page);
    const existing = readWikiPage(relativePath, scope);
    const parsed = parseJsonFrontmatter(existing.content);
    let body = parsed.body || `# ${wikiTitle(relativePath)}\n`;
    const marker = `Source note: ${note.id}`;

    if (!body.includes(marker)) {
        const heading = '## Promoted Notebook Notes';
        if (!body.includes(heading)) {
            body = `${body.trim()}\n\n${heading}\n`;
        }
        body = `${body.trimEnd()}\n\n${promotedNoteEntry(note)}\n`;
    }

    const sources = [...new Set([...arrayMeta(parsed.meta.sources), note.id])];
    const page = writeWikiPage(scope, relativePath, body, { ...parsed.meta, sources });
    if (!(note.status === 'promoted' && note.promoted_to === relativePath)) {
        appendPromotionEvent(scope, note, relativePath);
    }
    return page;
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
