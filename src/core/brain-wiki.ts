import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getMembership, getResident } from '../db';
import {
    BrainScopeInput,
    MAX_WIKI_BODY_CHARS,
    assertTextLimit,
    brainPath,
    clampLimit,
    dayStamp,
    ensureBrainDirs,
    getBrainDb,
    listMarkdownFiles,
    nowIso,
    scopedRelativePath,
} from './brain-store';

/**
 * The wiki layer: pages the agent compiles and owns.
 *
 * `wiki/index.md` and `wiki/log.md` are not pages. The index is a projection of
 * the `wiki_pages` table and is regenerated wholesale; the log is append-only and
 * its grep-able heading format is its query interface, so it is never rewritten.
 */

export interface BrainWikiPage {
    path: string;
    file_path: string;
    exists: boolean;
    content: string;
}

export interface BrainWikiSummary {
    path: string;
    topic: string;
    title: string;
    kind: string;
    excerpt: string;
    knowledge_updated_at: string;
    updated_at: string;
}

export interface WikiLogEntry {
    day: string;
    action: string;
    subject: string;
    details: Record<string, string>;
}

type ParsedFrontmatter = {
    meta: Record<string, unknown>;
    body: string;
    hasFrontmatter: boolean;
};

export const WIKI_INDEX_FILE = 'index.md';
export const WIKI_LOG_FILE = 'log.md';

const LOG_HEADER = `# Wiki Log\n\n<!-- Format: ## [YYYY-MM-DD] <action> | <subject>. Actions: ingest / query / lint. Append-only. -->\n`;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const EXTERNAL_LINK_RE = /^(https?:|mailto:|#|data:)/i;

export function normalizeWikiPath(targetPath: string): string {
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

export function parseJsonFrontmatter(raw: string): ParsedFrontmatter {
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

function excerptOf(body: string): string {
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

function stringMeta(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function wikiTopicOf(relativePath: string): string {
    const dir = path.posix.dirname(relativePath);
    return dir === '.' ? 'general' : dir.split('/')[0];
}

/** index.md and log.md live inside wiki/ but are not pages. */
export function isWikiSpecialFile(relativePath: string): boolean {
    return relativePath === WIKI_INDEX_FILE || relativePath === WIKI_LOG_FILE;
}

function extractLinks(
    scope: BrainScopeInput | undefined,
    relativePath: string,
    body: string
): Array<{ to_path: string; kind: string; resolved: number }> {
    const pageDir = path.dirname(brainPath(scope, 'wiki', ...relativePath.split('/')));
    const links: Array<{ to_path: string; kind: string; resolved: number }> = [];
    const seeAlsoIndex = body.search(/^##\s+See Also\s*$/im);

    for (const match of body.matchAll(LINK_RE)) {
        const target = match[2].trim();
        if (!target || EXTERNAL_LINK_RE.test(target)) continue;

        const absolute = path.resolve(pageDir, target.split('#')[0]);
        const toPath = scopedRelativePath(scope, absolute);
        const isRaw = toPath.startsWith('raw/');
        const inSeeAlso = seeAlsoIndex >= 0 && (match.index ?? 0) > seeAlsoIndex;

        links.push({
            to_path: toPath,
            kind: isRaw ? 'raw' : inSeeAlso ? 'see_also' : 'body',
            resolved: fs.existsSync(absolute) ? 1 : 0,
        });
    }

    return links;
}

function indexWikiPage(
    db: Database.Database,
    scope: BrainScopeInput | undefined,
    relativePath: string,
    content: string
): void {
    const parsed = parseJsonFrontmatter(content);
    const body = parsed.body;
    const title = stringMeta(parsed.meta.title, firstHeading(body, relativePath));
    const updatedAt = stringMeta(parsed.meta.updated_at, nowIso());

    db.prepare(
        `
        INSERT INTO wiki_pages (
            path, topic, title, kind, status, visibility, excerpt, sources_json, knowledge_updated_at, updated_at
        ) VALUES (
            @path, @topic, @title, @kind, @status, @visibility, @excerpt, @sources_json, @knowledge_updated_at, @updated_at
        )
        ON CONFLICT(path) DO UPDATE SET
            topic = excluded.topic,
            title = excluded.title,
            kind = excluded.kind,
            status = excluded.status,
            visibility = excluded.visibility,
            excerpt = excluded.excerpt,
            sources_json = excluded.sources_json,
            knowledge_updated_at = excluded.knowledge_updated_at,
            updated_at = excluded.updated_at
    `
    ).run({
        path: relativePath,
        topic: wikiTopicOf(relativePath),
        title,
        kind: stringMeta(parsed.meta.kind, 'article'),
        status: stringMeta(parsed.meta.status, 'canonical'),
        visibility: stringMeta(parsed.meta.visibility, scope?.spaceId ? 'space' : 'owner'),
        excerpt: excerptOf(body),
        sources_json: JSON.stringify(arrayMeta(parsed.meta.sources)),
        knowledge_updated_at: stringMeta(parsed.meta.knowledge_updated_at, dayStamp(updatedAt)),
        updated_at: updatedAt,
    });

    db.prepare('DELETE FROM wiki_fts WHERE path = ?').run(relativePath);
    db.prepare('INSERT INTO wiki_fts (path, title, excerpt, body) VALUES (?, ?, ?, ?)').run(
        relativePath,
        title,
        excerptOf(body),
        body
    );

    db.prepare('DELETE FROM wiki_links WHERE from_path = ?').run(relativePath);
    const insertLink = db.prepare('INSERT INTO wiki_links (from_path, to_path, kind, resolved) VALUES (?, ?, ?, ?)');
    for (const link of extractLinks(scope, relativePath, body)) {
        insertLink.run(relativePath, link.to_path, link.kind, link.resolved);
    }
}

function writeWikiPage(
    scope: BrainScopeInput | undefined,
    relativePath: string,
    body: string,
    metaPatch?: Record<string, unknown>,
    options?: { knowledgeChanged?: boolean }
): BrainWikiPage {
    assertTextLimit('Wiki page body', body, MAX_WIKI_BODY_CHARS);
    const absolutePath = brainPath(scope, 'wiki', ...relativePath.split('/'));
    const existingRaw = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : '';
    const existing = parseJsonFrontmatter(existingRaw);
    const currentIso = nowIso();
    const knowledgeChanged = options?.knowledgeChanged !== false;

    const meta = {
        id: `wiki_${relativePath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
        title: firstHeading(body, relativePath),
        kind: 'article',
        status: 'canonical',
        // D3: pages inherit the visibility of the scope they are compiled in.
        visibility: scope?.spaceId ? 'space' : 'owner',
        frontmatter_format: 'json',
        created_at: existing.meta.created_at || currentIso,
        ...existing.meta,
        ...(metaPatch || {}),
        updated_at: currentIso,
        knowledge_updated_at: knowledgeChanged
            ? dayStamp(currentIso)
            : stringMeta(existing.meta.knowledge_updated_at, dayStamp(currentIso)),
    };
    // JSON frontmatter is intentional: it keeps Brain pages dependency-free and machine-readable.
    const content = `---\n${JSON.stringify(meta, null, 2)}\n---\n${body.trim()}\n`;

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf-8');
    indexWikiPage(getBrainDb(scope), scope, relativePath, content);
    projectWikiIndexFile(scope);

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

export interface WikiReader extends BrainScopeInput {
    /** The person asking. Absent means a background job, which sees only space-visible pages. */
    personId?: string;
}

/**
 * Which visibility levels a reader may see (D3). Owner-only pages are not merely
 * hidden from search — they are unreadable by path, or the field would be decoration.
 */
export function visibilityForReader(reader: WikiReader): string[] {
    // The host-level wiki has no space audience; it belongs to the owner.
    if (!reader.spaceId) return ['owner', 'space'];
    if (!reader.personId) return ['space'];

    const isOwner =
        getMembership(reader.spaceId, reader.personId)?.role === 'owner' ||
        getResident(reader.personId)?.role === 'owner';
    return isOwner ? ['space', 'owner'] : ['space'];
}

export function pageVisibility(scope: BrainScopeInput | undefined, content: string): string {
    return stringMeta(parseJsonFrontmatter(content).meta.visibility, scope?.spaceId ? 'space' : 'owner');
}

/**
 * Read a page as a particular person. Returns `allowed: false` with no content when the
 * page is above the reader's visibility, so knowing a path is not a way around D3.
 */
export function readWikiPageForReader(input: { path: string } & WikiReader): BrainWikiPage & { allowed: boolean } {
    const scope: BrainScopeInput = { spaceId: input.spaceId };
    const page = readWikiPage(input.path, scope);
    if (!page.exists) return { ...page, allowed: true };

    const allowed = visibilityForReader(input).includes(pageVisibility(scope, page.content));
    return allowed ? { ...page, allowed } : { ...page, content: '', allowed: false };
}

export function updateWikiPage(input: { path: string; body: string } & BrainScopeInput): BrainWikiPage {
    const relativePath = normalizeWikiPath(input.path);
    if (isWikiSpecialFile(relativePath)) {
        throw new Error(`${relativePath} is generated by the Brain Layer and cannot be edited directly.`);
    }

    const body = input.body.trim();
    if (!body) {
        throw new Error('Wiki update cannot be empty.');
    }

    const parsed = parseJsonFrontmatter(body);
    return writeWikiPage(
        { spaceId: input.spaceId },
        relativePath,
        parsed.hasFrontmatter ? parsed.body : body,
        parsed.meta
    );
}

/** Used by note promotion, which supplies its own merged body and metadata. */
export function writeWikiPageInternal(
    scope: BrainScopeInput | undefined,
    relativePath: string,
    body: string,
    metaPatch?: Record<string, unknown>
): BrainWikiPage {
    return writeWikiPage(scope, relativePath, body, metaPatch);
}

/** The curated pages, most recently touched first — for browsing rather than reading. */
export function listWikiPages(input?: { limit?: number } & BrainScopeInput): BrainWikiSummary[] {
    const limit = clampLimit(input?.limit, 50, 1, 200);
    return getBrainDb(input)
        .prepare(
            `SELECT path, topic, title, kind, excerpt, knowledge_updated_at, updated_at
             FROM wiki_pages ORDER BY updated_at DESC LIMIT ?`
        )
        .all(limit) as BrainWikiSummary[];
}

export function reindexWikiTree(scope?: BrainScopeInput): number {
    const db = getBrainDb(scope);
    const wikiRoot = brainPath(scope, 'wiki');
    const files = listMarkdownFiles(wikiRoot);
    let count = 0;

    for (const filePath of files) {
        const relative = path.relative(wikiRoot, filePath).split(path.sep).join(path.posix.sep);
        if (isWikiSpecialFile(relative)) continue;
        indexWikiPage(db, scope, relative, fs.readFileSync(filePath, 'utf-8'));
        count += 1;
    }

    return count;
}

/**
 * Regenerate wiki/index.md from the index. The agent reads SQLite; the owner reads
 * this file in Obsidian or on GitHub. One writer keeps them from drifting.
 */
export function projectWikiIndexFile(scope?: BrainScopeInput): string {
    ensureBrainDirs(scope);
    const rows = getBrainDb(scope)
        .prepare(
            `SELECT path, topic, title, kind, excerpt, knowledge_updated_at
             FROM wiki_pages ORDER BY topic ASC, title ASC`
        )
        .all() as BrainWikiSummary[];

    const byTopic = new Map<string, BrainWikiSummary[]>();
    for (const row of rows) {
        const bucket = byTopic.get(row.topic) || [];
        bucket.push(row);
        byTopic.set(row.topic, bucket);
    }

    const lines = ['# Knowledge Base Index', ''];
    if (rows.length === 0) {
        lines.push('_No pages compiled yet._', '');
    }

    for (const topic of [...byTopic.keys()].sort()) {
        lines.push(`## ${topic}`, '', '| Article | Summary | Updated |', '|---------|---------|---------|');
        for (const row of byTopic.get(topic) || []) {
            const summary = (row.kind === 'archive' ? `[Archived] ${row.excerpt}` : row.excerpt) || '(no summary)';
            const cell = summary.replace(/\|/g, '\\|').substring(0, 160);
            lines.push(`| [${row.title.replace(/\|/g, '\\|')}](${row.path}) | ${cell} | ${row.knowledge_updated_at} |`);
        }
        lines.push('');
    }

    const content = `${lines.join('\n').trimEnd()}\n`;
    fs.writeFileSync(brainPath(scope, 'wiki', WIKI_INDEX_FILE), content, 'utf-8');
    return content;
}

function logFilePath(scope?: BrainScopeInput): string {
    ensureBrainDirs(scope);
    return brainPath(scope, 'wiki', WIKI_LOG_FILE);
}

/**
 * Append one entry to wiki/log.md. Append is safe under concurrency; rewriting is not,
 * which is exactly why the log is never projected from the index.
 */
export function appendWikiLog(
    input: { action: string; subject: string; details?: Record<string, string>; now?: Date } & BrainScopeInput
): WikiLogEntry {
    const filePath = logFilePath({ spaceId: input.spaceId });
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, LOG_HEADER, 'utf-8');
    }

    const day = dayStamp(nowIso(input.now));
    const subject = input.subject.replace(/\s+/g, ' ').trim();
    const details = input.details || {};
    const detailLines = Object.entries(details).map(([key, value]) => `- ${key}: ${value}`);
    const block = `\n## [${day}] ${input.action} | ${subject}\n${detailLines.join('\n')}${detailLines.length ? '\n' : ''}`;

    fs.appendFileSync(filePath, block, 'utf-8');
    return { day, action: input.action, subject, details };
}

export function readWikiLog(scope?: BrainScopeInput): WikiLogEntry[] {
    const filePath = logFilePath(scope);
    if (!fs.existsSync(filePath)) return [];

    const entries: WikiLogEntry[] = [];
    let current: WikiLogEntry | null = null;

    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        const heading = line.match(/^##\s+\[(\d{4}-\d{2}-\d{2})\]\s+(\S+)\s*\|\s*(.*)$/);
        if (heading) {
            current = { day: heading[1], action: heading[2], subject: heading[3].trim(), details: {} };
            entries.push(current);
            continue;
        }

        const detail = line.match(/^-\s+([^:]+):\s*(.*)$/);
        if (detail && current) current.details[detail[1].trim()] = detail[2].trim();
    }

    return entries;
}
