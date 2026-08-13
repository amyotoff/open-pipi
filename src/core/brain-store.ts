import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';
import { logError, logWarn } from '../utils/logging';

/**
 * Where the Brain Layer lives on disk, and how its index is opened.
 *
 * Markdown under the scope root is the source of truth. Everything in
 * `indexes/sqlite.db` is derived and may be deleted at any time —
 * `rebuildBrainIndex` reconstructs it from the files alone. Because the store
 * owns the database handle, it also owns the schema for every derived table.
 */

export interface BrainScopeInput {
    spaceId?: string;
}

/** Bump when a derived table changes shape. The index is dropped and rebuilt from markdown. */
const BRAIN_SCHEMA_VERSION = 2;

export const MAX_TAGS = 12;
export const MAX_NOTE_TEXT_CHARS = 64 * 1024;
export const MAX_WIKI_BODY_CHARS = 512 * 1024;
export const MAX_RAW_BODY_CHARS = 1024 * 1024;

const dbCache = new Map<string, Database.Database>();

export function nowIso(now?: Date): string {
    return (now || new Date()).toISOString();
}

export function dayStamp(iso: string): string {
    return iso.substring(0, 10);
}

export function clampLimit(limit: number | undefined, fallback: number, min: number, max: number): number {
    const value = Number(limit);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), min), max);
}

export function assertTextLimit(label: string, text: string, maxChars: number): void {
    if (text.length > maxChars) {
        throw new Error(`${label} is too large (${text.length} chars, max ${maxChars}).`);
    }
}

export function slugify(value: string, maxLength: number = 60): string {
    const slug =
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'untitled';
    return slug.substring(0, maxLength).replace(/-+$/g, '') || 'untitled';
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

export function brainPath(scope: BrainScopeInput | undefined, ...segments: string[]): string {
    return path.join(getBrainScopeRoot(scope), ...segments);
}

export function scopedRelativePath(scope: BrainScopeInput | undefined, filePath: string): string {
    return path.relative(getBrainScopeRoot(scope), filePath).split(path.sep).join(path.posix.sep);
}

/**
 * One level of topic directories under wiki/ and raw/ (D2 in docs/brain-wiki-plan.md).
 * Older installs nested entity pages one level deeper; move them up before use so
 * every page resolves raw links with the same `../../raw/<topic>/<file>.md`.
 */
function migrateNestedWikiTopics(scope?: BrainScopeInput): void {
    const entitiesRoot = brainPath(scope, 'wiki', 'entities');
    if (!fs.existsSync(entitiesRoot)) return;

    const wikiRoot = brainPath(scope, 'wiki');
    for (const entry of fs.readdirSync(entitiesRoot, { withFileTypes: true })) {
        const from = path.join(entitiesRoot, entry.name);
        const to = path.join(wikiRoot, entry.name);

        if (!entry.isDirectory()) continue;
        if (!fs.existsSync(to)) {
            fs.renameSync(from, to);
            continue;
        }

        // Target already exists: move the individual pages, keep whatever is already there.
        for (const child of fs.readdirSync(from, { withFileTypes: true })) {
            const childFrom = path.join(from, child.name);
            const childTo = path.join(to, child.name);
            if (child.isFile() && !fs.existsSync(childTo)) fs.renameSync(childFrom, childTo);
        }
        if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
    }

    if (fs.readdirSync(entitiesRoot).length === 0) fs.rmdirSync(entitiesRoot);
}

export function ensureBrainDirs(scope?: BrainScopeInput): void {
    const dirs = [
        // raw/ topic directories are created on capture, not up front — a pre-made
        // directory is indistinguishable from a topic nobody has written to yet.
        brainPath(scope, 'raw'),
        brainPath(scope, 'notebook', 'daily'),
        brainPath(scope, 'notebook', 'project'),
        brainPath(scope, 'notebook', 'scratch'),
        brainPath(scope, 'wiki', 'projects'),
        brainPath(scope, 'wiki', 'people'),
        brainPath(scope, 'wiki', 'companies'),
        brainPath(scope, 'wiki', 'tools'),
        brainPath(scope, 'wiki', 'cities'),
        brainPath(scope, 'wiki', 'decisions'),
        brainPath(scope, 'wiki', 'principles'),
        brainPath(scope, 'wiki', 'playbooks'),
        brainPath(scope, 'playbooks'),
        brainPath(scope, 'indexes'),
    ];

    for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
    }

    migrateNestedWikiTopics(scope);
}

function indexPath(scope?: BrainScopeInput): string {
    ensureBrainDirs(scope);
    return brainPath(scope, 'indexes', 'sqlite.db');
}

function ensureBrainSchema(db: Database.Database): boolean {
    const version = (db.pragma('user_version', { simple: true }) as number) || 0;
    const wasReset = version !== BRAIN_SCHEMA_VERSION;
    if (wasReset) {
        // Dropping the index is safe only because a rebuild follows; see getBrainDb.
        db.exec(`
            DROP TABLE IF EXISTS notes;
            DROP TABLE IF EXISTS note_events;
            DROP TABLE IF EXISTS wiki_pages;
            DROP TABLE IF EXISTS wiki_links;
            DROP TABLE IF EXISTS wiki_fts;
            DROP TABLE IF EXISTS raw_sources;
        `);
    }

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
            topic TEXT NOT NULL,
            title TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            visibility TEXT NOT NULL,
            excerpt TEXT NOT NULL,
            sources_json TEXT NOT NULL,
            knowledge_updated_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brain_wiki_pages_topic
            ON wiki_pages(topic, knowledge_updated_at DESC);

        CREATE TABLE IF NOT EXISTS wiki_links (
            from_path TEXT NOT NULL,
            to_path TEXT NOT NULL,
            kind TEXT NOT NULL,
            resolved INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brain_wiki_links_from ON wiki_links(from_path);
        CREATE INDEX IF NOT EXISTS idx_brain_wiki_links_to ON wiki_links(to_path);

        CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
            path UNINDEXED,
            title,
            excerpt,
            body
        );

        CREATE TABLE IF NOT EXISTS raw_sources (
            path TEXT PRIMARY KEY,
            topic TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT,
            content_hash TEXT NOT NULL,
            collected_at TEXT NOT NULL,
            published_at TEXT,
            state TEXT NOT NULL,
            disposition TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_brain_raw_state ON raw_sources(state, collected_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_raw_hash ON raw_sources(content_hash);
    `);

    // The version is stamped only once the index has actually been rebuilt (see getBrainDb).
    // Stamping here would make a failed rebuild permanent: the next open would see a current
    // version over an empty index and never try again.
    if (!wasReset) db.pragma(`user_version = ${BRAIN_SCHEMA_VERSION}`);
    return wasReset;
}

type IndexRebuilder = (scope?: BrainScopeInput) => void;

let indexRebuilder: IndexRebuilder | null = null;
const rebuilding = new Set<string>();

/**
 * `brain.ts` registers the rebuild on load. The store cannot import it directly — the
 * rebuild spans notes, wiki and raw — so the dependency is inverted instead of cycled.
 */
export function registerIndexRebuilder(rebuilder: IndexRebuilder): void {
    indexRebuilder = rebuilder;
}

export function getBrainDb(scope?: BrainScopeInput): Database.Database {
    const dbPath = indexPath(scope);
    const cached = dbCache.get(dbPath);
    if (cached) return cached;

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    const wasReset = ensureBrainSchema(db);
    dbCache.set(dbPath, db);

    // A schema change empties every derived table. Markdown is the source of truth, so the
    // index is rebuilt from it immediately — without this the upgrade reads as data loss.
    if (wasReset && !rebuilding.has(dbPath)) {
        if (!indexRebuilder) {
            // Leave the version stale so a later open, once brain.ts is loaded, still rebuilds.
            logWarn('BRAIN', 'index_reset_without_rebuilder', { db_path: dbPath });
            return db;
        }

        rebuilding.add(dbPath);
        try {
            indexRebuilder(scope);
            db.pragma(`user_version = ${BRAIN_SCHEMA_VERSION}`);
        } catch (error: any) {
            // An empty index that reports itself as current is worse than a loud failure:
            // drop the connection, keep the stale version, and let the next open retry.
            logError('BRAIN', 'index_rebuild_failed', { db_path: dbPath, message: error?.message });
            dbCache.delete(dbPath);
            db.close();
            throw error;
        } finally {
            rebuilding.delete(dbPath);
        }
    }

    return db;
}

export function closeBrainDatabases(): void {
    for (const db of dbCache.values()) {
        db.close();
    }
    dbCache.clear();
}

export function listMarkdownFiles(root: string): string[] {
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
