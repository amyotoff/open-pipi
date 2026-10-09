/**
 * Text embeddings behind one interface. Default is EmbeddingGemma running
 * in-process through transformers.js; the Gemini API is the fallback for
 * hosts too small to run it. Vectors from different models never mix — each
 * row records the model that made it.
 */

import path from 'node:path';
import { DATA_DIR, GEMINI_API_KEY } from '../config';
import { logInfo } from '../utils/logging';
import { kismatikConfig } from './config';

export interface Embedder {
    /** Stored with each vector; a change of model means re-embedding. */
    readonly id: string;
    embedDocuments(texts: string[]): Promise<Float32Array[]>;
    embedQuery(text: string): Promise<Float32Array>;
}

/** Matryoshka truncation: keep the first `dim` values and re-normalise. */
export function truncateAndNormalize(values: ArrayLike<number>, dim: number): Float32Array {
    const size = Math.min(dim, values.length);
    const out = new Float32Array(size);
    let norm = 0;
    for (let i = 0; i < size; i++) {
        out[i] = values[i];
        norm += values[i] * values[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < size; i++) out[i] /= norm;
    return out;
}

// EmbeddingGemma was trained with these task prefixes; leaving them out costs quality.
const queryPrompt = (text: string) => `task: search result | query: ${text}`;
// Cost grows with length squared; the opening of a long post carries its topic.
const MAX_DOCUMENT_CHARS = 2000;
const documentPrompt = (text: string) => `title: none | text: ${text.slice(0, MAX_DOCUMENT_CHARS)}`;

class LocalGemmaEmbedder implements Embedder {
    readonly id: string;
    private extractor: Promise<any> | null = null;

    constructor(
        private readonly model: string,
        private readonly dim: number,
        private readonly dtype: string
    ) {
        this.id = `${model}:${dtype}@${dim}`;
    }

    private load(): Promise<any> {
        if (!this.extractor) {
            this.extractor = (async () => {
                // Loaded lazily: the model is hundreds of megabytes and most boots never need it.
                const transformers = await import('@huggingface/transformers');
                // Kept with the data so a container rebuild does not download the model again.
                transformers.env.cacheDir = path.join(DATA_DIR, 'models');
                const started = Date.now();
                const pipe = await transformers.pipeline('feature-extraction', this.model, {
                    dtype: this.dtype as any,
                });
                logInfo('KISMATIK', 'embedder_loaded', { model: this.model, ms: Date.now() - started });
                return pipe;
            })();
            this.extractor.catch(() => {
                this.extractor = null;
            });
        }
        return this.extractor;
    }

    private async run(inputs: string[]): Promise<Float32Array[]> {
        const pipe = await this.load();
        const output = await pipe(inputs, { pooling: 'mean', normalize: true });
        const [rows, width] = output.dims as [number, number];
        const data = output.data as Float32Array;
        const result: Float32Array[] = [];
        for (let row = 0; row < rows; row++) {
            result.push(truncateAndNormalize(data.subarray(row * width, (row + 1) * width), this.dim));
        }
        return result;
    }

    embedDocuments(texts: string[]): Promise<Float32Array[]> {
        return this.run(texts.map(documentPrompt));
    }

    async embedQuery(text: string): Promise<Float32Array> {
        return (await this.run([queryPrompt(text)]))[0];
    }
}

class GeminiEmbedder implements Embedder {
    readonly id: string;

    constructor(
        private readonly model: string,
        private readonly dim: number
    ) {
        this.id = `${model}@${dim}`;
    }

    private async call(texts: string[], taskType: string): Promise<Float32Array[]> {
        if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
                body: JSON.stringify({
                    requests: texts.map((text) => ({
                        model: `models/${this.model}`,
                        content: { parts: [{ text }] },
                        taskType,
                        outputDimensionality: this.dim,
                    })),
                }),
                signal: AbortSignal.timeout(30_000),
            }
        );
        if (!response.ok) throw new Error(`Gemini embeddings HTTP ${response.status}`);
        const body = (await response.json()) as { embeddings: Array<{ values: number[] }> };
        return body.embeddings.map((embedding) => truncateAndNormalize(embedding.values, this.dim));
    }

    embedDocuments(texts: string[]): Promise<Float32Array[]> {
        return this.call(texts, 'RETRIEVAL_DOCUMENT');
    }

    async embedQuery(text: string): Promise<Float32Array> {
        return (await this.call([text], 'RETRIEVAL_QUERY'))[0];
    }
}

let current: Embedder | null | undefined;

/** Null when embeddings are switched off; search then runs on text alone. */
export function getEmbedder(): Embedder | null {
    if (current !== undefined) return current;
    const config = kismatikConfig();
    if (config.embedder === 'none') current = null;
    else if (config.embedder === 'gemini') current = new GeminiEmbedder(config.geminiModel, config.embeddingDim);
    else current = new LocalGemmaEmbedder(config.localModel, config.embeddingDim, config.localDtype);
    return current;
}

export function setEmbedderForTest(embedder: Embedder | null | undefined): void {
    current = embedder;
}
