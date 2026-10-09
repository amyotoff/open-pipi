/**
 * pnpm kismatik:eval <questions.json> <chat-id>
 *
 * Offline retrieval check against an imported community: recall@k of the gold
 * posts, by question type, plus latency. No LLM calls; the embedder is
 * whatever KISMATIK_EMBEDDER selects. Items: {id, type, question, gold_post_ids}.
 */

import fs from 'node:fs';
import { retrieve } from '../kismatik/retrieve';
import { closeKismatikDb } from '../kismatik/store';

const [file, CHAT] = process.argv.slice(2);
if (!file || !CHAT) {
    console.error('Usage: pnpm kismatik:eval <questions.json> <chat-id>');
    process.exit(1);
}
const K = Number(process.env.K || 8);

(async () => {
    const items = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8')) as Array<{
        id: string;
        type: string;
        question: string;
        gold_post_ids: number[];
    }>;
    const byType = new Map<string, { n: number; hit: number; ms: number[] }>();
    const misses: string[] = [];
    for (const item of items) {
        const started = Date.now();
        const evidence = await retrieve(CHAT, item.question, K);
        const ms = Date.now() - started;
        const ids = new Set(evidence.flatMap((e) => (e.kind === 'chat' ? e.chunk.msg_ids : [])));
        const stat = byType.get(item.type) ?? { n: 0, hit: 0, ms: [] };
        stat.ms.push(ms);
        if (item.gold_post_ids.length > 0) {
            stat.n += 1;
            if (item.gold_post_ids.some((id) => ids.has(id))) stat.hit += 1;
            else
                misses.push(
                    `${item.id} [${item.type}] gold=${item.gold_post_ids.join(',')} got=${[...ids].slice(0, 8).join(',')}`
                );
        }
        byType.set(item.type, stat);
    }
    let n = 0;
    let hit = 0;
    const all: number[] = [];
    for (const [type, stat] of byType) {
        n += stat.n;
        hit += stat.hit;
        all.push(...stat.ms);
        console.log(`${type.padEnd(13)} recall@${K} ${stat.n ? `${stat.hit}/${stat.n}` : 'n/a'}`);
    }
    all.sort((a, b) => a - b);
    console.log(
        `TOTAL recall@${K} ${hit}/${n} = ${Math.round((100 * hit) / n)}%  p50 ${all[Math.floor(all.length / 2)]}ms p95 ${all[Math.floor(all.length * 0.95)]}ms`
    );
    console.log('misses:\n' + misses.join('\n'));
    closeKismatikDb();
})();
