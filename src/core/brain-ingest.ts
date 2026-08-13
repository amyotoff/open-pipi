import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
    BrainScopeInput,
    MAX_RAW_BODY_CHARS,
    assertTextLimit,
    brainPath,
    clampLimit,
    dayStamp,
    ensureBrainDirs,
    getBrainDb,
    listMarkdownFiles,
    nowIso,
    scopedRelativePath,
    slugify,
} from './brain-store';
import { readWikiLog } from './brain-wiki';

/**
 * Capture: the synchronous half of ingest.
 *
 * A source is written to raw/ and queued, and nothing else happens inside the turn.
 * Compilation is a job with its own model budget (D4), so the raw file plus the
 * `state` column on its row is the whole queue — there is no separate queue table.
 */

export type RawSourceState = 'queued' | 'triaged' | 'compiled' | 'no_material' | 'failed';

export interface RawSource {
    path: string;
    topic: string;
    title: string;
    url: string | null;
    content_hash: string;
    collected_at: string;
    published_at: string | null;
    state: RawSourceState;
    disposition: string | null;
    attempts: number;
    last_error: string | null;
}

export interface CaptureRawInput extends BrainScopeInput {
    title: string;
    content: string;
    topic?: string;
    url?: string;
    published_at?: string;
    now?: Date;
}

export interface CaptureRawResult {
    source: RawSource;
    file_path: string;
    duplicate: boolean;
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEADER_FIELD_RE = /^>\s*([A-Za-z-]+):\s*(.*)$/;
/** Written into the Source field when a source has no URL, so rebuild can tell the two apart. */
const PASTED_SOURCE = 'pasted into the assistant';

function normalizeContent(content: string): string {
    return content.replace(/\r\n/g, '\n').trim();
}

/**
 * The raw header is line-based, so a value containing a newline would both truncate the
 * field and let the rest of the string pose as another header line — which is how a
 * crafted title could rewrite `Collected:` and break the D1 round-trip.
 */
function headerValue(value: string): string {
    return value
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hashContent(content: string): string {
    return createHash('sha256').update(normalizeContent(content), 'utf-8').digest('hex');
}

function normalizeDay(value: string | undefined): string | null {
    const trimmed = (value || '').trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
    return ISO_DAY_RE.test(trimmed) ? trimmed : null;
}

/** Reuse an existing raw topic directory when the slug matches case-insensitively. */
function resolveTopicDirectory(scope: BrainScopeInput | undefined, topic: string | undefined): string {
    const requested = slugify(topic || 'inbox', 40);
    const rawRoot = brainPath(scope, 'raw');
    if (!fs.existsSync(rawRoot)) return requested;

    const existing = fs
        .readdirSync(rawRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    return existing.find((name) => name.toLowerCase() === requested.toLowerCase()) || requested;
}

function renderRawFile(input: {
    title: string;
    url?: string;
    collectedDay: string;
    publishedDay: string | null;
    content: string;
}): string {
    return [
        `# ${input.title.trim()}`,
        '',
        `> Source: ${input.url?.trim() || PASTED_SOURCE}`,
        `> Collected: ${input.collectedDay}`,
        `> Published: ${input.publishedDay || 'Unknown'}`,
        '',
        normalizeContent(input.content),
        '',
    ].join('\n');
}

function parseRawFile(raw: string): { title: string; fields: Record<string, string>; body: string } {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const title = lines[0]?.startsWith('# ') ? lines[0].substring(2).trim() : '';
    const fields: Record<string, string> = {};

    let cursor = 1;
    while (cursor < lines.length) {
        const line = lines[cursor];
        const field = line.match(HEADER_FIELD_RE);
        if (field) {
            fields[field[1].toLowerCase()] = field[2].trim();
            cursor += 1;
            continue;
        }
        if (line.trim() === '' && Object.keys(fields).length === 0) {
            cursor += 1;
            continue;
        }
        if (line.trim() === '') {
            cursor += 1;
            break;
        }
        break;
    }

    return { title, fields, body: lines.slice(cursor).join('\n').trim() };
}

function upsertRawSource(scope: BrainScopeInput | undefined, source: RawSource): void {
    getBrainDb(scope)
        .prepare(
            `
        INSERT INTO raw_sources (
            path, topic, title, url, content_hash, collected_at, published_at, state, disposition, attempts, last_error
        ) VALUES (
            @path, @topic, @title, @url, @content_hash, @collected_at, @published_at, @state, @disposition, @attempts, @last_error
        )
        ON CONFLICT(path) DO UPDATE SET
            topic = excluded.topic,
            title = excluded.title,
            url = excluded.url,
            content_hash = excluded.content_hash,
            collected_at = excluded.collected_at,
            published_at = excluded.published_at,
            state = excluded.state,
            disposition = excluded.disposition,
            attempts = excluded.attempts,
            last_error = excluded.last_error
    `
        )
        .run(source);
}

export function getRawSourceByHash(contentHash: string, scope?: BrainScopeInput): RawSource | undefined {
    return getBrainDb(scope).prepare('SELECT * FROM raw_sources WHERE content_hash = ?').get(contentHash) as
        | RawSource
        | undefined;
}

export function getRawSource(rawPath: string, scope?: BrainScopeInput): RawSource | undefined {
    return getBrainDb(scope).prepare('SELECT * FROM raw_sources WHERE path = ?').get(rawPath) as RawSource | undefined;
}

export function listRawSources(input?: { state?: RawSourceState; limit?: number } & BrainScopeInput): RawSource[] {
    const limit = clampLimit(input?.limit, 20, 1, 200);
    const db = getBrainDb(input);
    return input?.state
        ? (db
              .prepare('SELECT * FROM raw_sources WHERE state = ? ORDER BY collected_at ASC, path ASC LIMIT ?')
              .all(input.state, limit) as RawSource[])
        : (db
              .prepare('SELECT * FROM raw_sources ORDER BY collected_at DESC, path ASC LIMIT ?')
              .all(limit) as RawSource[]);
}

/**
 * Write a source into raw/ and queue it. raw/ is immutable: a second capture of the
 * same content returns the existing row instead of writing a near-duplicate file.
 */
export function captureRawSource(input: CaptureRawInput): CaptureRawResult {
    const scope: BrainScopeInput = { spaceId: input.spaceId };
    const title = headerValue(input.title);
    const url = input.url ? headerValue(input.url) : undefined;
    const content = normalizeContent(input.content);

    if (!title) throw new Error('A captured source needs a title.');
    if (!content) throw new Error('A captured source cannot be empty.');
    assertTextLimit('Captured source', content, MAX_RAW_BODY_CHARS);

    ensureBrainDirs(scope);
    const contentHash = hashContent(content);
    const existing = getRawSourceByHash(contentHash, scope);
    if (existing) {
        return { source: existing, file_path: existing.path, duplicate: true };
    }

    // Day precision, matching the Collected field in the file, so a rebuilt row is identical.
    const collectedDay = dayStamp(nowIso(input.now));
    const publishedDay = normalizeDay(input.published_at);
    const topic = resolveTopicDirectory(scope, input.topic);
    const fileName = `${publishedDay || collectedDay}-${slugify(title)}-${contentHash.substring(0, 8)}.md`;
    const absolutePath = brainPath(scope, 'raw', topic, fileName);
    const relativePath = path.posix.join('raw', topic, fileName);

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, renderRawFile({ title, url, collectedDay, publishedDay, content }), 'utf-8');

    const source: RawSource = {
        path: relativePath,
        topic,
        title,
        url: url || null,
        content_hash: contentHash,
        collected_at: collectedDay,
        published_at: publishedDay,
        state: 'queued',
        disposition: null,
        attempts: 0,
        last_error: null,
    };

    upsertRawSource(scope, source);
    return { source, file_path: scopedRelativePath(scope, absolutePath), duplicate: false };
}

/**
 * Recover the raw inventory from files alone (D1). Process state that is not in the
 * file — whether a source has been compiled — is recovered from wiki/log.md, whose
 * ingest entries carry the raw path and its disposition.
 */
export function reindexRawTree(scope?: BrainScopeInput): number {
    const rawRoot = brainPath(scope, 'raw');
    const logged = new Map<string, { state: RawSourceState; disposition: string | null }>();

    for (const entry of readWikiLog(scope)) {
        if (entry.action !== 'ingest') continue;

        const noMaterial = entry.subject.match(/^no material:\s*(\S+)$/i);
        const rawPath = noMaterial ? noMaterial[1] : entry.details.Raw;
        if (!rawPath) continue;

        const disposition = entry.details.Disposition || (noMaterial ? 'No material' : null);
        logged.set(rawPath.trim(), {
            state: disposition?.toLowerCase() === 'no material' ? 'no_material' : 'compiled',
            disposition,
        });
    }

    let count = 0;
    for (const filePath of listMarkdownFiles(rawRoot)) {
        const relative = path.posix.join('raw', path.relative(rawRoot, filePath).split(path.sep).join(path.posix.sep));
        const parsed = parseRawFile(fs.readFileSync(filePath, 'utf-8'));
        const recorded = logged.get(relative);
        const source = parsed.fields.source?.trim() || '';
        const url = source && source !== PASTED_SOURCE ? source : null;

        upsertRawSource(scope, {
            path: relative,
            topic: path.posix.dirname(relative).replace(/^raw\/?/, '') || 'inbox',
            title: parsed.title || path.posix.basename(relative, '.md'),
            url,
            content_hash: hashContent(parsed.body),
            collected_at: normalizeDay(parsed.fields.collected) || dayStamp(nowIso()),
            published_at: normalizeDay(parsed.fields.published),
            state: recorded?.state || 'queued',
            disposition: recorded?.disposition || null,
            attempts: 0,
            last_error: null,
        });
        count += 1;
    }

    return count;
}
