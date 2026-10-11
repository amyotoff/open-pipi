/**
 * Recall over one community's chat: chunks by stemmed full text and by
 * vector, fused with reciprocal rank fusion, which needs no score
 * calibration. Wiki pages are chosen separately, by the model reading the
 * index (wiki.ts).
 */

import { logWarn } from '../utils/logging';
import { getEmbedder } from './embedder';
import { getChunks, loadVectors, searchChunksFts, type Chunk } from './store';
import { toStemQuery } from './text';

export type Evidence =
    | { kind: 'chat'; key: string; chunk: Chunk }
    | { kind: 'wiki'; key: string; path: string; title: string; body: string; msgIds: number[] };

const RRF_K = 60;
const LIST_DEPTH = 30;

export function rrf(lists: string[][], k = RRF_K): Array<{ key: string; score: number }> {
    const scores = new Map<string, number>();
    for (const list of lists) {
        list.forEach((key, index) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + index + 1)));
    }
    return [...scores.entries()].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score);
}

export function topKByCosine(
    query: Float32Array,
    rows: Array<{ id: number; vec: Float32Array }>,
    k: number
): Array<{ id: number; score: number }> {
    const scored = rows
        .filter((row) => row.vec.length === query.length)
        .map((row) => {
            let dot = 0;
            for (let i = 0; i < query.length; i++) dot += query[i] * row.vec[i];
            return { id: row.id, score: dot };
        });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}

async function vectorHits(chatId: string, question: string): Promise<number[]> {
    const embedder = getEmbedder();
    if (!embedder) return [];
    try {
        const rows = loadVectors(chatId, embedder.id);
        if (rows.length === 0) return [];
        const query = await embedder.embedQuery(question);
        // No absolute cut-off: EmbeddingGemma scores unrelated Russian text around 0.6,
        // so rank alone goes into fusion and the answer step rejects what does not fit.
        return topKByCosine(query, rows, LIST_DEPTH).map((hit) => hit.id);
    } catch (error: any) {
        // Text search alone still answers; a broken model must not take questions down.
        logWarn('KISMATIK', 'vector_search_failed', { chat_id: chatId, message: error?.message });
        return [];
    }
}

export async function retrieve(chatId: string, question: string, limit = 8): Promise<Evidence[]> {
    const ftsIds = searchChunksFts(chatId, toStemQuery(question), LIST_DEPTH).map((hit) => hit.id);
    const vectorIds = await vectorHits(chatId, question);
    const fused = rrf([ftsIds.map((id) => `chat:${id}`), vectorIds.map((id) => `chat:${id}`)]).slice(0, limit);

    const chunkIds = fused.map((hit) => Number(hit.key.slice(5)));
    // getChunks filters by chat id too: a vector row from elsewhere cannot surface here.
    const chunks = new Map(getChunks(chatId, chunkIds).map((chunk) => [`chat:${chunk.id}`, chunk]));
    const evidence: Evidence[] = [];
    for (const hit of fused) {
        const chunk = chunks.get(hit.key);
        if (chunk) evidence.push({ kind: 'chat', key: hit.key, chunk });
    }
    return evidence;
}
