import { buildTelegramSpaceId, getMemoryEntries, getResident, getVisiblePersonMemoryEntries } from '../db';
import { getEntriesForActiveSprint, getOlderLongMemoryEntries } from './memory-sprint';

let memoryCache: { context: string; cachedAt: number; key: string } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateMemoryContextCache(): void {
    memoryCache = null;
}

export function getMemoryContext(
    options?: string | { residentId?: string; chatId?: string; spaceId?: string; projectId?: string }
): string {
    const residentId = typeof options === 'string' ? options : options?.residentId;
    const chatId = typeof options === 'string' ? undefined : options?.chatId;
    const projectId = typeof options === 'string' ? undefined : options?.projectId;
    const spaceId =
        typeof options === 'string' ? null : options?.spaceId || (chatId ? buildTelegramSpaceId(chatId) : null);
    const cacheKey = residentId
        ? `${residentId}:${spaceId || chatId || '__nospace'}:${projectId || '__noproject'}`
        : `__global:${spaceId || chatId || '__nospace'}:${projectId || '__noproject'}`;
    const now = Date.now();

    if (memoryCache && memoryCache.key === cacheKey && now - memoryCache.cachedAt < CACHE_TTL_MS) {
        return memoryCache.context;
    }

    const parts: string[] = [];
    const personMemory = residentId ? getVisiblePersonMemoryEntries(residentId, spaceId || undefined, 8) : [];
    const projectMemory = projectId ? getMemoryEntries('project', projectId, undefined, 8) : [];
    const spaceMemory = spaceId ? getEntriesForActiveSprint('space', spaceId, undefined, 8) : [];
    const workMemory = spaceId ? getEntriesForActiveSprint('work', spaceId, undefined, 8) : [];
    const longMemory = spaceId ? getOlderLongMemoryEntries(spaceId, 6) : [];

    if (personMemory.length > 0) {
        parts.push(
            `[PERSON MEMORY]\n${personMemory
                .map((entry) => `- ${entry.content} [${entry.kind}]${entry.space_bound_id ? ' [chat-only]' : ''}`)
                .join('\n')}`
        );
    }

    if (projectMemory.length > 0) {
        parts.push(
            `[PROJECT MEMORY]\n${projectMemory.map((entry) => `- ${entry.content} [${entry.kind}]`).join('\n')}`
        );
    }

    if (spaceMemory.length > 0) {
        parts.push(`[SPACE MEMORY]\n${spaceMemory.map((entry) => `- ${entry.content} [${entry.kind}]`).join('\n')}`);
    }

    if (workMemory.length > 0) {
        parts.push(`[WORK MEMORY]\n${workMemory.map((entry) => `- ${entry.content} [${entry.kind}]`).join('\n')}`);
    }

    if (longMemory.length > 0) {
        parts.push(`[LONG MEMORY]\n${longMemory.map((entry) => `- ${entry.content} [${entry.kind}]`).join('\n')}`);
    }

    const context = parts.length > 0 ? parts.join('\n\n') : '';
    memoryCache = { context, cachedAt: now, key: cacheKey };
    return context;
}

export function getImportantDatesContext(): string {
    const structuredDates = getMemoryEntries('person', undefined, undefined, 200)
        .filter((entry) => entry.kind === 'important_date')
        .slice(0, 12);

    if (structuredDates.length > 0) {
        const residentLookup = new Map(
            structuredDates.map((entry) => {
                const resident = getResident(entry.scope_id);
                return [
                    entry.scope_id,
                    resident?.nickname || resident?.display_name || resident?.username || entry.scope_id,
                ];
            })
        );
        return `Known important dates from memory: ${structuredDates
            .map((entry) => `${residentLookup.get(entry.scope_id)}: ${entry.content}`)
            .join('; ')}`;
    }

    return 'No important dates are currently stored in memory.';
}
