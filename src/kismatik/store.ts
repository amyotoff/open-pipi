/**
 * KISMATIK's own SQLite file. Nothing here touches the PiPi database.
 *
 * Every read and write takes the community's chat id first. A query without
 * one would mix two communities, so there is no such query in this module.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../config';
import { stemText } from './text';

export interface StoredMessage {
    chat_id: string;
    message_id: number;
    user_id: string;
    user_name: string;
    username: string | null;
    text: string;
    reply_to: number | null;
    thread_id: number | null;
    ts: number;
    chunk_id: number | null;
}

export interface Chunk {
    id: number;
    chat_id: string;
    first_ts: number;
    last_ts: number;
    msg_ids: number[];
    text: string;
    chars: number;
    closed: number;
    embedded: number;
    digested: number;
}

export type SignalKind = 'need' | 'offer';

export interface Signal {
    id: number;
    chat_id: string;
    kind: SignalKind;
    message_id: number;
    user_id: string;
    user_name: string;
    summary: string;
    created_at: number;
    expires_at: number;
    status: 'open' | 'matched' | 'expired';
}

export interface Community {
    chat_id: string;
    title: string | null;
    username: string | null;
    paused: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS communities (
    chat_id TEXT PRIMARY KEY,
    title TEXT,
    username TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    username TEXT,
    text TEXT NOT NULL,
    reply_to INTEGER,
    thread_id INTEGER,
    ts INTEGER NOT NULL,
    chunk_id INTEGER,
    PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    msg_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    chars INTEGER NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    embedded INTEGER NOT NULL DEFAULT 0,
    digested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunks_chat_open ON chunks(chat_id, closed, last_ts);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(stem, chat_id UNINDEXED, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS vectors (
    chunk_id INTEGER PRIMARY KEY,
    chat_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_chat ON vectors(chat_id, model);
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    UNIQUE (chat_id, kind, message_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS signals_fts USING fts5(stem, chat_id UNINDEXED, tokenize = 'unicode61');
CREATE TABLE IF NOT EXISTS suggestions (
    chat_id TEXT NOT NULL,
    need_id INTEGER NOT NULL,
    offer_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, need_id, offer_id)
);
CREATE TABLE IF NOT EXISTS asks (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id, day)
);
`;

let db: Database.Database | null = null;

export function kismatikDbPath(): string {
    return process.env.KISMATIK_DB_PATH || path.join(DATA_DIR, 'kismatik.sqlite');
}

export function getKismatikDb(): Database.Database {
    if (db) return db;
    const file = kismatikDbPath();
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return db;
}

export function closeKismatikDb(): void {
    db?.close();
    db = null;
}

/* ---------------------------------------------------------------- communities */

export function upsertCommunity(chatId: string, info: { title?: string | null; username?: string | null }): void {
    getKismatikDb()
        .prepare(
            `INSERT INTO communities (chat_id, title, username, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET
               title = COALESCE(excluded.title, communities.title),
               username = COALESCE(excluded.username, communities.username)`
        )
        .run(chatId, info.title ?? null, info.username ?? null, Date.now());
}

export function getCommunity(chatId: string): Community | undefined {
    return getKismatikDb().prepare(`SELECT * FROM communities WHERE chat_id = ?`).get(chatId) as Community | undefined;
}

export function setPaused(chatId: string, paused: boolean): void {
    upsertCommunity(chatId, {});
    getKismatikDb()
        .prepare(`UPDATE communities SET paused = ? WHERE chat_id = ?`)
        .run(paused ? 1 : 0, chatId);
}

export function isPaused(chatId: string): boolean {
    return getCommunity(chatId)?.paused === 1;
}

/* ------------------------------------------------------------------ messages */

export interface NewMessage {
    message_id: number;
    user_id: string;
    user_name: string;
    username?: string | null;
    text: string;
    reply_to?: number | null;
    thread_id?: number | null;
    ts: number;
}

function formatLine(message: NewMessage): string {
    const time = new Date(message.ts).toISOString().slice(0, 16).replace('T', ' ');
    return `[msg:${message.message_id}] ${message.user_name} (${time}): ${message.text.replace(/\s+/g, ' ').trim()}`;
}

function rowToChunk(row: any): Chunk {
    return { ...row, msg_ids: JSON.parse(row.msg_ids) };
}

function writeChunkFts(chatId: string, chunkId: number, text: string): void {
    const conn = getKismatikDb();
    conn.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`).run(chunkId);
    conn.prepare(`INSERT INTO chunks_fts (rowid, stem, chat_id) VALUES (?, ?, ?)`).run(chunkId, stemText(text), chatId);
}

/**
 * Store one message and fold it into the community's open chunk — a run of
 * messages without a long silence. Single chat messages are too short to
 * search or embed well on their own. Returns false for a duplicate.
 */
export function addMessage(chatId: string, message: NewMessage, options: { gapMs: number; maxChars: number }): boolean {
    const conn = getKismatikDb();
    return conn.transaction(() => {
        const inserted = conn
            .prepare(
                `INSERT OR IGNORE INTO messages
                 (chat_id, message_id, user_id, user_name, username, text, reply_to, thread_id, ts)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                chatId,
                message.message_id,
                message.user_id,
                message.user_name,
                message.username ?? null,
                message.text,
                message.reply_to ?? null,
                message.thread_id ?? null,
                message.ts
            );
        if (inserted.changes === 0) return false;

        const line = formatLine(message);
        const open = conn
            .prepare(`SELECT * FROM chunks WHERE chat_id = ? AND closed = 0 ORDER BY id DESC LIMIT 1`)
            .get(chatId) as any;

        const fits =
            open &&
            message.ts - open.last_ts <= options.gapMs &&
            message.ts >= open.first_ts &&
            open.chars + line.length <= options.maxChars;

        let chunkId: number;
        if (fits) {
            const ids = [...JSON.parse(open.msg_ids), message.message_id];
            const text = `${open.text}\n${line}`;
            conn.prepare(
                `UPDATE chunks SET last_ts = ?, msg_ids = ?, text = ?, chars = ?, embedded = 0 WHERE id = ?`
            ).run(message.ts, JSON.stringify(ids), text, text.length, open.id);
            chunkId = open.id;
            writeChunkFts(chatId, chunkId, text);
        } else {
            if (open) conn.prepare(`UPDATE chunks SET closed = 1 WHERE id = ?`).run(open.id);
            const created = conn
                .prepare(
                    `INSERT INTO chunks (chat_id, first_ts, last_ts, msg_ids, text, chars) VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run(chatId, message.ts, message.ts, JSON.stringify([message.message_id]), line, line.length);
            chunkId = Number(created.lastInsertRowid);
            writeChunkFts(chatId, chunkId, line);
        }
        conn.prepare(`UPDATE messages SET chunk_id = ? WHERE chat_id = ? AND message_id = ?`).run(
            chunkId,
            chatId,
            message.message_id
        );
        return true;
    })();
}

/** Close chunks that have gone quiet, so they can be embedded and digested. */
export function closeStaleChunks(chatId: string, now: number, gapMs: number): number {
    return getKismatikDb()
        .prepare(`UPDATE chunks SET closed = 1 WHERE chat_id = ? AND closed = 0 AND last_ts < ?`)
        .run(chatId, now - gapMs).changes;
}

export function getMessage(chatId: string, messageId: number): StoredMessage | undefined {
    return getKismatikDb()
        .prepare(`SELECT * FROM messages WHERE chat_id = ? AND message_id = ?`)
        .get(chatId, messageId) as StoredMessage | undefined;
}

export function getChunks(chatId: string, ids: number[]): Chunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (
        getKismatikDb()
            .prepare(`SELECT * FROM chunks WHERE chat_id = ? AND id IN (${placeholders})`)
            .all(chatId, ...ids) as any[]
    ).map(rowToChunk);
}

export function searchChunksFts(chatId: string, stemQuery: string, limit: number): Array<{ id: number; rank: number }> {
    if (!stemQuery) return [];
    return getKismatikDb()
        .prepare(
            `SELECT rowid AS id, bm25(chunks_fts) AS rank FROM chunks_fts
             WHERE chunks_fts MATCH ? AND chat_id = ? ORDER BY rank LIMIT ?`
        )
        .all(stemQuery, chatId, limit) as Array<{ id: number; rank: number }>;
}

/**
 * Remove one message from memory. The chunk is rebuilt without it and must be
 * embedded again; a wiki page compiled earlier is not rewritten.
 */
export function forgetMessage(chatId: string, messageId: number): boolean {
    const conn = getKismatikDb();
    return conn.transaction(() => {
        const message = getMessage(chatId, messageId);
        if (!message) return false;
        conn.prepare(`DELETE FROM messages WHERE chat_id = ? AND message_id = ?`).run(chatId, messageId);
        conn.prepare(`DELETE FROM signals WHERE chat_id = ? AND message_id = ?`).run(chatId, messageId);
        if (message.chunk_id !== null) {
            const chunk = getChunks(chatId, [message.chunk_id])[0];
            if (chunk) {
                const rest = chunk.msg_ids.filter((id) => id !== messageId);
                const marker = `[msg:${messageId}] `;
                const text = chunk.text
                    .split('\n')
                    .filter((line) => !line.startsWith(marker))
                    .join('\n');
                conn.prepare(`DELETE FROM vectors WHERE chunk_id = ?`).run(chunk.id);
                if (rest.length === 0) {
                    conn.prepare(`DELETE FROM chunks WHERE id = ?`).run(chunk.id);
                    conn.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`).run(chunk.id);
                } else {
                    conn.prepare(`UPDATE chunks SET msg_ids = ?, text = ?, chars = ?, embedded = 0 WHERE id = ?`).run(
                        JSON.stringify(rest),
                        text,
                        text.length,
                        chunk.id
                    );
                    writeChunkFts(chatId, chunk.id, text);
                }
            }
        }
        return true;
    })();
}

/* ------------------------------------------------------------------ vectors */

export function listChunksToEmbed(chatId: string, limit: number): Chunk[] {
    return (
        getKismatikDb()
            .prepare(`SELECT * FROM chunks WHERE chat_id = ? AND closed = 1 AND embedded = 0 ORDER BY id LIMIT ?`)
            .all(chatId, limit) as any[]
    ).map(rowToChunk);
}

export function saveVector(chatId: string, chunkId: number, model: string, vec: Float32Array): void {
    const conn = getKismatikDb();
    conn.transaction(() => {
        conn.prepare(
            `INSERT INTO vectors (chunk_id, chat_id, model, dim, vec) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec`
        ).run(chunkId, chatId, model, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
        conn.prepare(`UPDATE chunks SET embedded = 1 WHERE chat_id = ? AND id = ?`).run(chatId, chunkId);
    })();
}

export function loadVectors(chatId: string, model: string): Array<{ id: number; vec: Float32Array }> {
    const rows = getKismatikDb()
        .prepare(`SELECT chunk_id, vec FROM vectors WHERE chat_id = ? AND model = ?`)
        .all(chatId, model) as Array<{ chunk_id: number; vec: Buffer }>;
    return rows.map((row) => ({
        id: row.chunk_id,
        vec: new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength)),
    }));
}

/* ------------------------------------------------------------------- digest */

export function listChunksToDigest(chatId: string, limit: number): Chunk[] {
    return (
        getKismatikDb()
            .prepare(`SELECT * FROM chunks WHERE chat_id = ? AND closed = 1 AND digested = 0 ORDER BY id LIMIT ?`)
            .all(chatId, limit) as any[]
    ).map(rowToChunk);
}

export function markDigested(chatId: string, chunkIds: number[]): void {
    const statement = getKismatikDb().prepare(`UPDATE chunks SET digested = 1 WHERE chat_id = ? AND id = ?`);
    for (const id of chunkIds) statement.run(chatId, id);
}

/* ------------------------------------------------------------------ signals */

export function addSignal(
    chatId: string,
    signal: Omit<Signal, 'id' | 'chat_id' | 'status' | 'created_at'> & { created_at?: number }
): number | null {
    const conn = getKismatikDb();
    return conn.transaction(() => {
        const result = conn
            .prepare(
                `INSERT OR IGNORE INTO signals (chat_id, kind, message_id, user_id, user_name, summary, created_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                chatId,
                signal.kind,
                signal.message_id,
                signal.user_id,
                signal.user_name,
                signal.summary,
                signal.created_at ?? Date.now(),
                signal.expires_at
            );
        if (result.changes === 0) return null;
        const id = Number(result.lastInsertRowid);
        conn.prepare(`INSERT INTO signals_fts (rowid, stem, chat_id) VALUES (?, ?, ?)`).run(
            id,
            stemText(signal.summary),
            chatId
        );
        return id;
    })();
}

export function getSignal(chatId: string, id: number): Signal | undefined {
    return getKismatikDb().prepare(`SELECT * FROM signals WHERE chat_id = ? AND id = ?`).get(chatId, id) as
        | Signal
        | undefined;
}

export function searchOpenSignals(
    chatId: string,
    kind: SignalKind,
    stemQuery: string,
    now: number,
    limit: number
): Signal[] {
    if (!stemQuery) return [];
    return getKismatikDb()
        .prepare(
            `SELECT s.* FROM signals_fts f JOIN signals s ON s.id = f.rowid
             WHERE signals_fts MATCH ? AND f.chat_id = ? AND s.chat_id = ? AND s.kind = ?
               AND s.status = 'open' AND s.expires_at > ?
             ORDER BY bm25(signals_fts) LIMIT ?`
        )
        .all(stemQuery, chatId, chatId, kind, now, limit) as Signal[];
}

export function setSignalStatus(chatId: string, id: number, status: Signal['status']): void {
    getKismatikDb().prepare(`UPDATE signals SET status = ? WHERE chat_id = ? AND id = ?`).run(status, chatId, id);
}

export function expireSignals(chatId: string, now: number): number {
    return getKismatikDb()
        .prepare(`UPDATE signals SET status = 'expired' WHERE chat_id = ? AND status = 'open' AND expires_at <= ?`)
        .run(chatId, now).changes;
}

/** Records a suggestion once. False if this pair was already suggested. */
export function recordSuggestion(chatId: string, needId: number, offerId: number, now: number): boolean {
    return (
        getKismatikDb()
            .prepare(`INSERT OR IGNORE INTO suggestions (chat_id, need_id, offer_id, created_at) VALUES (?, ?, ?, ?)`)
            .run(chatId, needId, offerId, now).changes === 1
    );
}

export function countSuggestionsSince(chatId: string, since: number): number {
    const row = getKismatikDb()
        .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE chat_id = ? AND created_at >= ?`)
        .get(chatId, since) as { n: number };
    return row.n;
}

/* --------------------------------------------------------------------- asks */

/** Counts an ask and says whether it is within today's allowance. */
export function takeAsk(chatId: string, userId: string, day: string, limit: number): boolean {
    const conn = getKismatikDb();
    return conn.transaction(() => {
        const row = conn
            .prepare(`SELECT count FROM asks WHERE chat_id = ? AND user_id = ? AND day = ?`)
            .get(chatId, userId, day) as { count: number } | undefined;
        if ((row?.count ?? 0) >= limit) return false;
        conn.prepare(
            `INSERT INTO asks (chat_id, user_id, day, count) VALUES (?, ?, ?, 1)
             ON CONFLICT(chat_id, user_id, day) DO UPDATE SET count = count + 1`
        ).run(chatId, userId, day);
        return true;
    })();
}

export function communityStats(chatId: string): Record<string, number> {
    const conn = getKismatikDb();
    const count = (sql: string) => (conn.prepare(sql).get(chatId) as { n: number }).n;
    return {
        messages: count(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`),
        chunks: count(`SELECT COUNT(*) AS n FROM chunks WHERE chat_id = ?`),
        embedded: count(`SELECT COUNT(*) AS n FROM vectors WHERE chat_id = ?`),
        digested: count(`SELECT COUNT(*) AS n FROM chunks WHERE chat_id = ? AND digested = 1`),
        needs: count(`SELECT COUNT(*) AS n FROM signals WHERE chat_id = ? AND kind = 'need' AND status = 'open'`),
        offers: count(`SELECT COUNT(*) AS n FROM signals WHERE chat_id = ? AND kind = 'offer' AND status = 'open'`),
        suggestions: count(`SELECT COUNT(*) AS n FROM suggestions WHERE chat_id = ?`),
    };
}
