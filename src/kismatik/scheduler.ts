import { logInfo, logWarn } from '../utils/logging';
import { kismatikConfig } from './config';
import { digestCommunity, embedPending } from './digest';
import { closeKismatikDb, isPaused } from './store';

const TICK_MS = 60_000;
/** While an imported history is being worked through, digest every few minutes. */
const BACKLOG_INTERVAL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
const lastDigest = new Map<string, number>();

async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const config = kismatikConfig();
        for (const chatId of config.chatIds) {
            if (isPaused(chatId)) continue;
            try {
                // Drain the embedding backlog a batch at a time; a backfill can be thousands of chunks.
                for (let i = 0; i < 20; i++) {
                    if ((await embedPending(chatId)) === 0) break;
                }
            } catch (error: any) {
                logWarn('KISMATIK', 'embed_failed', { chat_id: chatId, message: error?.message });
            }

            const due = (lastDigest.get(chatId) ?? 0) + config.digestIntervalMs <= Date.now();
            if (!due) continue;
            lastDigest.set(chatId, Date.now());
            const result = await digestCommunity(chatId);
            if (result.chunks > 0) logInfo('KISMATIK', 'digest', { chat_id: chatId, ...result });
            if (result.backlog) lastDigest.set(chatId, Date.now() - config.digestIntervalMs + BACKLOG_INTERVAL_MS);
        }
    } catch (error: any) {
        logWarn('KISMATIK', 'tick_failed', { message: error?.message });
    } finally {
        running = false;
    }
}

export function startKismatikScheduler(): void {
    if (timer || kismatikConfig().chatIds.size === 0) return;
    logInfo('KISMATIK', 'enabled', { chats: [...kismatikConfig().chatIds].join(',') });
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    void tick();
}

export function stopKismatikScheduler(): void {
    if (timer) clearInterval(timer);
    timer = null;
    closeKismatikDb();
}
