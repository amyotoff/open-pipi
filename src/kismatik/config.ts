/**
 * KISMATIK — community memory and matching for public Telegram groups.
 *
 * Off unless KISMATIK_CHAT_IDS lists the groups. A listed group is consumed
 * entirely by KISMATIK: its messages never reach the PiPi gateway, so the
 * owner's assistant, tools and shared wiki stay out of the community.
 */

function readList(raw: string | undefined): string[] {
    return (raw || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function readInt(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export type EmbedderKind = 'local' | 'gemini' | 'none';

export interface KismatikConfig {
    chatIds: Set<string>;
    embedder: EmbedderKind;
    localModel: string;
    geminiModel: string;
    embeddingDim: number;
    /** A new chunk starts after this much silence. */
    chunkGapMs: number;
    chunkMaxChars: number;
    digestIntervalMs: number;
    maxSuggestionsPerDay: number;
    maxAsksPerUserPerDay: number;
}

export function loadKismatikConfig(env: NodeJS.ProcessEnv = process.env): KismatikConfig {
    const embedder = env.KISMATIK_EMBEDDER;
    return {
        chatIds: new Set(readList(env.KISMATIK_CHAT_IDS)),
        embedder: embedder === 'gemini' || embedder === 'none' ? embedder : 'local',
        localModel: env.KISMATIK_LOCAL_MODEL || 'onnx-community/embeddinggemma-2-ONNX',
        geminiModel: env.KISMATIK_GEMINI_EMBED_MODEL || 'gemini-embedding-001',
        embeddingDim: readInt(env.KISMATIK_EMBEDDING_DIM, 256),
        chunkGapMs: readInt(env.KISMATIK_CHUNK_GAP_MIN, 10) * 60_000,
        chunkMaxChars: readInt(env.KISMATIK_CHUNK_MAX_CHARS, 1500),
        digestIntervalMs: readInt(env.KISMATIK_DIGEST_INTERVAL_MIN, 120) * 60_000,
        maxSuggestionsPerDay: readInt(env.KISMATIK_MAX_SUGGESTIONS_PER_DAY, 5),
        maxAsksPerUserPerDay: readInt(env.KISMATIK_MAX_ASKS_PER_USER_PER_DAY, 30),
    };
}

let current: KismatikConfig | null = null;

export function kismatikConfig(): KismatikConfig {
    if (!current) current = loadKismatikConfig();
    return current;
}

/** Tests swap configuration without touching process.env. */
export function setKismatikConfigForTest(config: Partial<KismatikConfig> | null): void {
    current = config ? { ...loadKismatikConfig({}), ...config } : null;
}

export function isKismatikChat(chatId: string | number | undefined | null): boolean {
    if (chatId === undefined || chatId === null) return false;
    return kismatikConfig().chatIds.has(String(chatId));
}

/** The brain scope a community's wiki lives in. Never the shared wiki. */
export function communitySpaceId(chatId: string): string {
    return `kismatik-${chatId}`;
}
