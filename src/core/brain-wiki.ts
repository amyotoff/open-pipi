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
    sharedScope,
    toScope,
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

/**
 * `shared` is readable by everyone in the install, `space` only inside its chat, and
 * `owner` only by the owner. The shared wiki is the household's; a chat's pages are not.
 */
export function defaultVisibility(scope?: BrainScopeInput): string {
    if (scope?.shared) return 'shared';
    return scope?.spaceId ? 'space' : 'owner';
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
        visibility: stringMeta(parsed.meta.visibility, defaultVisibility(scope)),
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

    // Provenance lives in frontmatter, not in the prose. Indexing it here is what lets lint
    // verify a compiled page at all — the compiler records sources but writes no body link.
    for (const source of arrayMeta(parsed.meta.sources)) {
        if (!source.startsWith('raw/')) continue;
        const absolute = brainPath(scope, ...source.split('/'));
        insertLink.run(relativePath, source, 'source', fs.existsSync(absolute) ? 1 : 0);
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
        visibility: defaultVisibility(scope),
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
    // Everyone in the install reads the shared wiki; that is what makes it shared.
    if (!reader.spaceId) return ['shared', 'owner', 'space'];
    if (!reader.personId) return ['shared', 'space'];

    const isOwner =
        getMembership(reader.spaceId, reader.personId)?.role === 'owner' ||
        getResident(reader.personId)?.role === 'owner';
    return isOwner ? ['shared', 'space', 'owner'] : ['shared', 'space'];
}

export function pageVisibility(scope: BrainScopeInput | undefined, content: string): string {
    return stringMeta(parseJsonFrontmatter(content).meta.visibility, defaultVisibility(scope));
}

/**
 * Read a page as a particular person. Returns `allowed: false` with no content when the
 * page is above the reader's visibility, so knowing a path is not a way around D3.
 */
export function readWikiPageForReader(
    input: { path: string } & WikiReader
): BrainWikiPage & { allowed: boolean; origin: 'shared' | 'space' } {
    const allowedLevels = visibilityForReader(input);

    // The shared wiki first; a chat's own older pages remain readable as a fallback.
    const candidates: Array<{ scope: BrainScopeInput; origin: 'shared' | 'space' }> = [
        { scope: sharedScope({ spaceId: input.spaceId }), origin: 'shared' },
    ];
    if (input.spaceId) candidates.push({ scope: { spaceId: input.spaceId }, origin: 'space' });

    let denied: (BrainWikiPage & { origin: 'shared' | 'space' }) | null = null;
    for (const candidate of candidates) {
        const page = readWikiPage(input.path, candidate.scope);
        if (!page.exists) continue;
        if (allowedLevels.includes(pageVisibility(candidate.scope, page.content))) {
            return { ...page, allowed: true, origin: candidate.origin };
        }
        denied = { ...page, origin: candidate.origin };
    }

    if (denied) return { ...denied, content: '', allowed: false };
    return {
        path: normalizeWikiPath(input.path),
        file_path: '',
        exists: false,
        content: '',
        allowed: true,
        origin: 'shared',
    };
}

export function updateWikiPage(input: { path: string; body: string } & BrainScopeInput): BrainWikiPage {
    const relativePath = normalizeWikiPath(input.path);
    if (isWikiSpecialFile(relativePath)) {
        throw new Error(`${relativePath} is generated by the Brain Layer and cannot be edited directly.`);
    }

    // Reads prefer the shared wiki, so a chat-local write to a path that already exists there
    // would report success and change nothing anyone reads.
    if (!input.shared && input.spaceId && readWikiPage(relativePath, sharedScope(toScope(input))).exists) {
        throw new Error(
            `${relativePath} lives in the shared wiki, which is what everyone reads. Use wiki_save to change it.`
        );
    }

    const body = input.body.trim();
    if (!body) {
        throw new Error('Wiki update cannot be empty.');
    }

    const parsed = parseJsonFrontmatter(body);
    return writeWikiPage(toScope(input), relativePath, parsed.hasFrontmatter ? parsed.body : body, parsed.meta);
}

/** Used by note promotion, which supplies its own merged body and metadata. */
export function writeWikiPageInternal(
    scope: BrainScopeInput | undefined,
    relativePath: string,
    body: string,
    metaPatch?: Record<string, unknown>,
    options?: { knowledgeChanged?: boolean }
): BrainWikiPage {
    return writeWikiPage(scope, relativePath, body, metaPatch, options);
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
    const filePath = logFilePath(toScope(input));
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

export interface WikiSearchHit extends BrainWikiSummary {
    visibility: string;
    status: string;
}

/** FTS5 is unforgiving about punctuation, so queries are rebuilt from word tokens. */
function toFtsQuery(query: string): string {
    const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 12);
    return tokens.map((token) => `"${token}"`).join(' OR ');
}

/**
 * Index-first search over the wiki. Callers must pass the visibility levels the reader
 * is allowed to see (D3); there is no default that quietly widens the audience.
 */
export function searchWikiRows(
    input: { query: string; limit?: number; visibility?: string[] } & BrainScopeInput
): WikiSearchHit[] {
    const limit = clampLimit(input.limit, 8, 1, 50);
    const visibility = input.visibility?.length ? input.visibility : ['space', 'owner'];
    const placeholders = visibility.map(() => '?').join(', ');
    const db = getBrainDb(input);
    const ftsQuery = toFtsQuery(input.query);

    const columns = `p.path, p.topic, p.title, p.kind, p.excerpt, p.knowledge_updated_at, p.updated_at, p.visibility, p.status`;

    if (ftsQuery) {
        const hits = db
            .prepare(
                `SELECT ${columns} FROM wiki_fts f
                 JOIN wiki_pages p ON p.path = f.path
                 WHERE wiki_fts MATCH ? AND p.visibility IN (${placeholders})
                 ORDER BY bm25(wiki_fts) LIMIT ?`
            )
            .all(ftsQuery, ...visibility, limit) as WikiSearchHit[];
        if (hits.length > 0) return hits;
    }

    const like = `%${input.query.trim().toLowerCase()}%`;
    return db
        .prepare(
            `SELECT ${columns} FROM wiki_pages p
             WHERE (LOWER(p.title) LIKE ? OR LOWER(p.excerpt) LIKE ?) AND p.visibility IN (${placeholders})
             ORDER BY p.knowledge_updated_at DESC LIMIT ?`
        )
        .all(like, like, ...visibility, limit) as WikiSearchHit[];
}

/** Compact catalogue lines for a model prompt — the index, never the page bodies. */
export function wikiIndexDigest(input?: { limit?: number } & BrainScopeInput): string {
    const rows = getBrainDb(input)
        .prepare(
            `SELECT path, title, excerpt, knowledge_updated_at FROM wiki_pages
             ORDER BY knowledge_updated_at DESC LIMIT ?`
        )
        .all(clampLimit(input?.limit, 120, 1, 400)) as BrainWikiSummary[];

    if (rows.length === 0) return '(the wiki has no pages yet)';
    return rows
        .map((row) => `- ${row.path} — ${row.title}: ${row.excerpt.substring(0, 120)} (${row.knowledge_updated_at})`)
        .join('\n');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace one section of a page instead of rewriting the whole file (D7). A cascade
 * touches a dozen pages; rewriting each one costs a dozen full bodies in output tokens
 * and makes the diff unreadable.
 */
export function patchWikiSection(
    input: { path: string; heading: string; body: string } & BrainScopeInput
): BrainWikiPage {
    const relativePath = normalizeWikiPath(input.path);
    if (isWikiSpecialFile(relativePath)) {
        throw new Error(`${relativePath} is generated by the Brain Layer and cannot be edited directly.`);
    }

    const headingText = input.heading.replace(/^#+\s*/, '').trim();
    if (!headingText) throw new Error('A section patch needs a heading.');

    const scope: BrainScopeInput = toScope(input);
    const existing = readWikiPage(relativePath, scope);
    const parsed = parseJsonFrontmatter(existing.content);
    const lines = (parsed.body || `# ${wikiTitle(relativePath)}`).split('\n');
    const headingRe = new RegExp(`^(#{1,6})\\s+${escapeRegExp(headingText)}\\s*$`, 'i');

    const startIndex = lines.findIndex((line) => headingRe.test(line.trim()));
    const patch = input.body.trim();

    if (startIndex === -1) {
        const appended = [...lines, '', `## ${headingText}`, '', patch].join('\n');
        return writeWikiPage(scope, relativePath, appended, parsed.meta);
    }

    const level = (lines[startIndex].trim().match(/^#+/) || ['##'])[0].length;
    let endIndex = lines.length;
    for (let cursor = startIndex + 1; cursor < lines.length; cursor += 1) {
        const nextLevel = (lines[cursor].trim().match(/^(#{1,6})\s+\S/) || [])[1]?.length;
        if (nextLevel !== undefined && nextLevel <= level) {
            endIndex = cursor;
            break;
        }
    }

    const merged = [...lines.slice(0, startIndex + 1), '', patch, '', ...lines.slice(endIndex)].join('\n');
    return writeWikiPage(scope, relativePath, merged.replace(/\n{3,}/g, '\n\n'), parsed.meta);
}
