import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import {
    deleteMemoryEntriesByContent,
    ensureTelegramSpace,
    getAllResidents,
    getDb,
    getMemoryEntries,
    getResident,
    getVisiblePersonMemoryEntries,
    listSpaces,
    rememberMemoryEntry,
    updateResidentHabits,
    updateResidentNickname,
} from '../db';
import { getMemoryContext, invalidateMemoryContextCache } from '../core/memory-context';
import { compactExpiredSprintsForActiveSpaces } from '../core/memory-sprint';
import {
    rememberPersonMemory as writePersonMemory,
    rememberSpaceMemory as writeSpaceMemory,
    rememberWorkMemory as writeWorkMemory,
} from '../core/memory-write';
import { processWithOllama } from '../core/ollama';
import { HOUSEHOLD_CHAT_ID } from '../config';
import {
    resolveChannelRefFromExecutionContext,
    resolveSpaceIdFromExecutionContext,
    RuntimeExecutionContext,
} from '../core/runtime-context';

function resolveResidentScopeId(residentName: string): string {
    const normalized = residentName.trim().toLowerCase();
    const resident = getAllResidents().find((item) =>
        [item.nickname, item.display_name, item.username, item.person_id, item.tg_id]
            .filter(Boolean)
            .some((value) => value!.toLowerCase() === normalized)
    );

    return resident?.person_id || resident?.tg_id || `name:${normalized}`;
}

function resolveResidentIdArg(args: { person_id?: string; tg_id?: string }): string | undefined {
    return args.person_id?.trim() || args.tg_id?.trim() || undefined;
}

function resolveInsightPersonIdArg(args: { person_id?: string; resident_tg_id?: string }): string | undefined {
    return args.person_id?.trim() || args.resident_tg_id?.trim() || undefined;
}

function rememberPersonMemoryBound(residentName: string, fact: string, category: string, spaceBoundId?: string): void {
    writePersonMemory(resolveResidentScopeId(residentName), category, fact, {
        salience: 0.8,
        source: 'memory_remember',
        spaceBoundId,
    });
}

function rememberScopedSpaceMemory(
    spaceId: string | undefined,
    kind: string,
    content: string,
    salience: number,
    source: string
): void {
    if (!spaceId) return;
    if (kind === 'work') {
        writeWorkMemory(spaceId, kind, content, { salience, source });
        return;
    }
    writeSpaceMemory(spaceId, kind, content, { salience, source });
}

function resolveMemorySpaceId(context?: Partial<RuntimeExecutionContext>): string | undefined {
    const resolved = resolveSpaceIdFromExecutionContext(context);
    if (resolved) return resolved;
    if (HOUSEHOLD_CHAT_ID) {
        return resolveSpaceIdFromExecutionContext({
            chatId: HOUSEHOLD_CHAT_ID,
            channel: 'telegram',
            channelRef: HOUSEHOLD_CHAT_ID,
        });
    }
    return undefined;
}

function isMemoryVisibleInSpace(entry: { space_bound_id?: string | null }, spaceId?: string): boolean {
    return !entry.space_bound_id || entry.space_bound_id === spaceId;
}

function legacyColumnExists(table: 'resident_notes' | 'daily_insights' | 'house_diary', column: string): boolean {
    try {
        const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        return rows.some((row) => row.name === column);
    } catch {
        return false;
    }
}

function currentLegacyChatJid(context?: Partial<RuntimeExecutionContext>): string | undefined {
    return resolveChannelRefFromExecutionContext(context)?.trim() || context?.chatId?.trim() || undefined;
}

function legacyVisibilityClause(
    table: 'resident_notes' | 'daily_insights' | 'house_diary',
    context?: Partial<RuntimeExecutionContext>
): { sql: string; params: string[] } {
    const hasScope = legacyColumnExists(table, 'scope');
    const hasChatJid = legacyColumnExists(table, 'chat_jid');
    if (!hasScope && !hasChatJid) return { sql: '', params: [] };

    const chatJid = currentLegacyChatJid(context);
    const clauses: string[] = [];
    const params: string[] = [];

    if (hasScope) {
        clauses.push("COALESCE(NULLIF(scope, ''), 'global') = 'global'");
    } else if (hasChatJid) {
        clauses.push("(chat_jid IS NULL OR chat_jid = '')");
    }

    if (chatJid && hasChatJid) {
        clauses.push('chat_jid = ?');
        params.push(chatJid);
    }

    if (chatJid && HOUSEHOLD_CHAT_ID && chatJid === HOUSEHOLD_CHAT_ID && hasScope) {
        clauses.push(
            hasChatJid ? "(scope = 'household' AND (chat_jid IS NULL OR chat_jid = ''))" : "scope = 'household'"
        );
    }

    return clauses.length > 0 ? { sql: ` AND (${clauses.join(' OR ')})`, params } : { sql: ' AND 1 = 0', params: [] };
}

function formatTimestampLabel(iso: string): string {
    return iso.substring(0, 16).replace('T', ' ');
}

function getStructuredDiaryEntries(spaceId: string | undefined, days: number) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const entries = spaceId
        ? getMemoryEntries('space', spaceId, 'diary', 30)
        : getMemoryEntries('space', undefined, undefined, 60).filter((entry) => entry.kind === 'diary');
    return entries
        .filter((entry) => entry.created_at >= cutoff.toISOString())
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

function getStructuredInsightEntries(spaceId: string | undefined, residentId?: string) {
    const today = new Date().toISOString().split('T')[0];
    if (residentId) {
        return getVisiblePersonMemoryEntries(residentId, spaceId, 40)
            .filter((entry) => entry.kind === 'insight' && entry.created_at.startsWith(today))
            .sort((left, right) => left.created_at.localeCompare(right.created_at));
    }

    const personInsights = getMemoryEntries('person', undefined, undefined, 100).filter(
        (entry) =>
            entry.kind === 'insight' && entry.created_at.startsWith(today) && isMemoryVisibleInSpace(entry, spaceId)
    );
    const workInsights = spaceId
        ? getMemoryEntries('work', spaceId, 'insight', 40).filter((entry) => entry.created_at.startsWith(today))
        : [];

    return [...personInsights, ...workInsights].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function getStructuredProfileLines(tgId: string, spaceId?: string): string[] {
    return getVisiblePersonMemoryEntries(tgId, spaceId, 12)
        .filter((entry) => entry.kind !== 'insight')
        .map((entry) => `${entry.content} [${entry.kind}]`);
}

const skill: SkillManifest = {
    name: 'memory',
    description: 'Long-term memory: structured participant notes, diary entries, insights, and compact summaries',
    version: '1.0.0',
    meta: {
        run_mode: 'inline',
        approval: 'none',
        cost: 'medium',
        visibility: 'all',
        pack_tags: ['jeeves', 'tutor', 'office', 'reporter'],
    },

    migrations: [
        // Legacy compatibility only. New writes should go to memory_entries.
        `CREATE TABLE IF NOT EXISTS resident_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resident_tg_id TEXT,
            resident_name TEXT,
            fact TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            source TEXT DEFAULT 'observation',
            chat_jid TEXT,
            scope TEXT DEFAULT 'global',
            created_at TEXT,
            updated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS house_diary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            entry TEXT NOT NULL,
            type TEXT DEFAULT 'daily',
            token_count INTEGER DEFAULT 0,
            chat_jid TEXT,
            scope TEXT DEFAULT 'global',
            created_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS daily_insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            resident_tg_id TEXT,
            insight TEXT NOT NULL,
            chat_jid TEXT,
            scope TEXT DEFAULT 'global',
            created_at TEXT
        )`,
        `ALTER TABLE resident_notes ADD COLUMN chat_jid TEXT`,
        `ALTER TABLE resident_notes ADD COLUMN scope TEXT DEFAULT 'global'`,
        `UPDATE resident_notes SET scope = 'global' WHERE scope IS NULL OR scope = ''`,
        `ALTER TABLE house_diary ADD COLUMN chat_jid TEXT`,
        `ALTER TABLE house_diary ADD COLUMN scope TEXT DEFAULT 'global'`,
        `UPDATE house_diary SET scope = 'global' WHERE scope IS NULL OR scope = ''`,
        `ALTER TABLE daily_insights ADD COLUMN chat_jid TEXT`,
        `ALTER TABLE daily_insights ADD COLUMN scope TEXT DEFAULT 'global'`,
        `UPDATE daily_insights SET scope = 'global' WHERE scope IS NULL OR scope = ''`,
        `CREATE INDEX IF NOT EXISTS idx_diary_date ON house_diary(date)`,
        `CREATE INDEX IF NOT EXISTS idx_notes_resident ON resident_notes(resident_tg_id)`,
        `CREATE INDEX IF NOT EXISTS idx_notes_scope_chat ON resident_notes(scope, chat_jid)`,
        `CREATE INDEX IF NOT EXISTS idx_insights_date ON daily_insights(date)`,
        `CREATE INDEX IF NOT EXISTS idx_insights_scope_chat_date ON daily_insights(scope, chat_jid, date)`,
        `CREATE INDEX IF NOT EXISTS idx_diary_scope_chat_date ON house_diary(scope, chat_jid, date)`,
    ],

    tools: [
        {
            name: 'memory_remember',
            description:
                'Save a personal fact or preference about a resident. Use when you learn something worth remembering: preferences, habits, dislikes, important dates, allergies, etc. Examples: "sir prefers Earl Grey", "madam is allergic to cats", "guest room is kept at 22C". Set chat_only=true when the fact only matters in the current chat (e.g. a topic discussed privately in DM, or a group-specific agreement).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    resident_name: {
                        type: Type.STRING,
                        description: 'Name of the resident or "household" for general facts.',
                    },
                    fact: { type: Type.STRING, description: 'The fact to remember. Be concise but specific.' },
                    category: {
                        type: Type.STRING,
                        description: 'Category of the fact.',
                        enum: ['preference', 'dislike', 'allergy', 'schedule', 'important_date', 'habit', 'general'],
                    },
                    chat_only: {
                        type: Type.BOOLEAN,
                        description:
                            'When true, this memory is only recalled in the current chat (DM or group). Use for confidential DM topics, group-specific agreements, or context that should not leak across chats. Default: false (memory is global).',
                    },
                },
                required: ['resident_name', 'fact', 'category'],
            },
        },
        {
            name: 'memory_forget',
            description: 'Remove an outdated or incorrect fact about a resident.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    fact_fragment: { type: Type.STRING, description: 'Part of the fact text to find and remove.' },
                },
                required: ['fact_fragment'],
            },
        },
        {
            name: 'memory_recall',
            description: 'Recall everything known about a specific resident or topic.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'Resident name or topic to recall.' },
                },
                required: ['query'],
            },
        },
        {
            name: 'diary_write',
            description:
                'Write a diary entry for today. Called automatically by cron, but can also be triggered manually.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    entry: { type: Type.STRING, description: 'The diary entry text.' },
                },
                required: ['entry'],
            },
        },
        {
            name: 'diary_read',
            description: 'Read diary entries for a specific date or recent days.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    days_back: { type: Type.INTEGER, description: 'How many days back to read (default 3, max 14).' },
                },
            },
        },
        {
            name: 'resident_set_name',
            description:
                'Set how a resident prefers to be called (nickname). Use when someone introduces themselves or asks to be called differently.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: { type: Type.STRING, description: 'Participant ID of the resident.' },
                    nickname: { type: Type.STRING, description: 'How the person wants to be called.' },
                },
                required: ['person_id', 'nickname'],
            },
        },
        {
            name: 'resident_learn_habit',
            description:
                'Learn a habit, preference, like, or dislike about a resident. Call this when you notice or are told something about a person: what they like/dislike, their routines, food preferences, sleep schedule, etc. Keep each entry short (under 60 chars).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: { type: Type.STRING, description: 'Participant ID of the resident.' },
                    habit: {
                        type: Type.STRING,
                        description:
                            'Short description of the habit or preference. E.g. "likes coffee in the morning", "avoids gluten", "keeps late hours".',
                    },
                },
                required: ['person_id', 'habit'],
            },
        },
        {
            name: 'resident_profile',
            description: 'View the profile and habits of a resident or all residents.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: { type: Type.STRING, description: 'Participant ID. Omit to see all residents.' },
                },
            },
        },
        {
            name: 'activity_log',
            description:
                'Show recent activity: tool calls, reboots, events. Use when asked "what did you do today?", "when was the last reboot?", "show me your activity".',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    type: {
                        type: Type.STRING,
                        description: 'Filter by event type: "tool_call", "reboot", or "all". Default: "all".',
                        enum: ['tool_call', 'reboot', 'all'],
                    },
                    limit: { type: Type.INTEGER, description: 'Max entries to show (default 20, max 50).' },
                },
            },
        },
        {
            name: 'insight_add',
            description:
                'Record a real-time insight about today: something notable about a participant, the chat mood, a recurring theme, or anything worth remembering but not formal enough for memory_remember. Call this proactively when you notice patterns.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    insight: { type: Type.STRING, description: 'The insight text. Be concise (under 100 chars).' },
                    person_id: {
                        type: Type.STRING,
                        description:
                            'Participant ID if insight is about a specific resident. Omit for general household insights.',
                    },
                },
                required: ['insight'],
            },
        },
        {
            name: 'insight_today',
            description:
                "Show all insights recorded today. Use when asked about today's observations, mood, or patterns.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    person_id: { type: Type.STRING, description: 'Filter by participant. Omit for all insights.' },
                },
            },
        },
    ],

    handlers: {
        async memory_remember(
            args: { resident_name: string; fact: string; category: string; chat_only?: boolean },
            context?: Partial<RuntimeExecutionContext>
        ) {
            const loweredName = args.resident_name.trim().toLowerCase();
            const spaceBoundId = args.chat_only ? resolveMemorySpaceId(context) : undefined;

            if (loweredName === 'household' || loweredName === 'group') {
                const spaceId = resolveMemorySpaceId(context);
                if (!spaceId) {
                    return '[TOOL_RESULT] Group memory needs an active space or default household space.';
                }
                rememberScopedSpaceMemory(spaceId, args.category, args.fact, 0.75, 'memory_remember');
            } else {
                rememberPersonMemoryBound(args.resident_name, args.fact, args.category, spaceBoundId);
            }

            invalidateCache();
            const boundLabel = spaceBoundId ? ' (chat-only)' : '';
            return `[TOOL_RESULT] Remembered about ${args.resident_name}: "${args.fact}" [${args.category}]${boundLabel}`;
        },

        async memory_forget(args: { fact_fragment: string }) {
            const db = getDb();
            const result = db.prepare('DELETE FROM resident_notes WHERE fact LIKE ?').run(`%${args.fact_fragment}%`);
            const genericDeleted = deleteMemoryEntriesByContent(args.fact_fragment);
            invalidateCache();
            const deleted = result.changes + genericDeleted;
            return deleted > 0
                ? `[TOOL_RESULT] Deleted ${deleted} note(s) containing "${args.fact_fragment}".`
                : `[TOOL_RESULT] No notes containing "${args.fact_fragment}" were found.`;
        },

        async memory_recall(args: { query: string }, context?: Partial<RuntimeExecutionContext>) {
            const db = getDb();
            const normalizedQuery = args.query.trim().toLowerCase();
            const resolvedScopeId = resolveResidentScopeId(args.query);
            const spaceId = resolveMemorySpaceId(context);
            const structuredMatches = getMemoryEntries(undefined, undefined, undefined, 80).filter(
                (entry) =>
                    isMemoryVisibleInSpace(entry, spaceId) &&
                    (entry.scope_id.toLowerCase() === resolvedScopeId.toLowerCase() ||
                        entry.scope_id.toLowerCase().includes(normalizedQuery) ||
                        entry.content.toLowerCase().includes(normalizedQuery) ||
                        entry.kind.toLowerCase().includes(normalizedQuery))
            );

            if (structuredMatches.length > 0) {
                const genericLines = structuredMatches.map(
                    (n) =>
                        `- [${n.kind}] ${n.scope_type}:${n.scope_id}: ${n.content}${n.space_bound_id ? ` [chat-only: ${n.space_bound_id}]` : ''}`
                );
                return '[TOOL_RESULT] From memory:\n' + [...new Set(genericLines)].join('\n');
            }

            const visibility = legacyVisibilityClause('resident_notes', context);
            const notes = db
                .prepare(
                    `SELECT * FROM resident_notes
                     WHERE (resident_name LIKE ? OR fact LIKE ?)
                     ${visibility.sql}
                     ORDER BY updated_at DESC`
                )
                .all(`%${args.query}%`, `%${args.query}%`, ...visibility.params) as any[];

            if (notes.length === 0) {
                return `[TOOL_RESULT] I do not have anything stored about "${args.query}".`;
            }

            const noteLines = notes.map((n: any) => `- [${n.category}] ${n.resident_name}: ${n.fact}`);
            return '[TOOL_RESULT] From memory:\n' + [...new Set(noteLines)].join('\n');
        },

        async diary_write(args: { entry: string }, context?: Partial<RuntimeExecutionContext>) {
            const spaceId = resolveMemorySpaceId(context);
            if (!spaceId) {
                return '[TOOL_RESULT] Diary write requires an active chat space.';
            }
            const tokenEstimate = Math.ceil(args.entry.length / 4); // rough estimate
            const today = new Date().toISOString().split('T')[0];
            rememberScopedSpaceMemory(spaceId, 'diary', args.entry, 0.45, 'diary_write');

            invalidateCache();
            return `[TOOL_RESULT] Saved a diary entry for ${today} (${tokenEstimate} token estimate).`;
        },

        async diary_read(args: { days_back?: number }, context?: Partial<RuntimeExecutionContext>) {
            const db = getDb();
            const days = Math.min(args.days_back || 3, 14);
            const structuredEntries = getStructuredDiaryEntries(resolveMemorySpaceId(context), days);

            if (structuredEntries.length > 0) {
                const structuredLines = structuredEntries.map(
                    (entry) => `[${formatTimestampLabel(entry.created_at)}] ${entry.content}`
                );
                return '[TOOL_RESULT] Diary:\n' + [...new Set(structuredLines)].join('\n\n');
            }

            const since = new Date();
            since.setDate(since.getDate() - days);
            const sinceStr = since.toISOString().split('T')[0];
            const visibility = legacyVisibilityClause('house_diary', context);
            const entries = db
                .prepare(
                    `SELECT * FROM house_diary
                     WHERE date >= ?
                     ${visibility.sql}
                     ORDER BY date DESC, created_at DESC`
                )
                .all(sinceStr, ...visibility.params) as any[];

            if (entries.length === 0) {
                return '[TOOL_RESULT] No diary entries were found for that period.';
            }

            const legacyLines = entries.map((entry: any) => `[${entry.date}] ${entry.entry}`);
            return '[TOOL_RESULT] Diary:\n' + [...new Set(legacyLines)].join('\n\n');
        },

        async resident_set_name(args: { person_id?: string; tg_id?: string; nickname: string }) {
            const personId = resolveResidentIdArg(args);
            if (!personId) return '[TOOL_RESULT] person_id is required.';
            const resident = getResident(personId);
            if (!resident) return `[TOOL_RESULT] Participant ${personId} was not found.`;

            updateResidentNickname(personId, args.nickname);
            invalidateCache();
            return `[TOOL_RESULT] Understood. I will use "${args.nickname}".`;
        },

        async resident_learn_habit(args: { person_id?: string; tg_id?: string; habit: string }) {
            const personId = resolveResidentIdArg(args);
            if (!personId) return '[TOOL_RESULT] person_id is required.';
            const resident = getResident(personId);
            if (!resident) return `[TOOL_RESULT] Participant ${personId} was not found.`;

            const habit = args.habit.trim().substring(0, 80);
            const current = resident.habits || '';
            const habits = current ? `${current}; ${habit}` : habit;

            // Auto-compact if over 500 chars
            const compacted = habits.length > 500 ? compactHabits(habits) : habits;
            updateResidentHabits(personId, compacted);
            writePersonMemory(personId, 'habit', habit, {
                salience: 0.7,
                source: 'resident_learn_habit',
            });
            invalidateCache();

            const name = resident.nickname || resident.display_name || personId;
            return `[TOOL_RESULT] Stored this preference for ${name}: "${habit}".`;
        },

        async resident_profile(
            args: { person_id?: string; tg_id?: string },
            context?: Partial<RuntimeExecutionContext>
        ) {
            const spaceId = resolveMemorySpaceId(context);
            const personId = resolveResidentIdArg(args);
            if (personId) {
                const r = getResident(personId);
                if (!r) return `[TOOL_RESULT] Participant ${personId} was not found.`;
                const structuredLines = getStructuredProfileLines(personId, spaceId);
                const profile = formatResidentProfile(r);
                return structuredLines.length > 0
                    ? `[TOOL_RESULT] ${profile}\n  Structured memory: ${structuredLines.join('; ')}`
                    : `[TOOL_RESULT] ${profile}`;
            }

            const all = getAllResidents();
            if (all.length === 0) return '[TOOL_RESULT] No participants are registered yet.';
            return (
                '[TOOL_RESULT] Participants:\n' +
                all
                    .map((resident) => {
                        const structuredLines = getStructuredProfileLines(
                            resident.person_id || resident.tg_id,
                            spaceId
                        );
                        const profile = formatResidentProfile(resident);
                        return structuredLines.length > 0
                            ? `${profile}\n  Structured memory: ${structuredLines.join('; ')}`
                            : profile;
                    })
                    .join('\n\n')
            );
        },

        async activity_log(args: { type?: string; limit?: number }) {
            const db = getDb();
            const limit = Math.min(Math.max(args.limit || 20, 1), 50);
            const filterType = args.type || 'all';

            let query = 'SELECT * FROM event_log';
            const params: any[] = [];

            if (filterType !== 'all') {
                query += ' WHERE event_type = ?';
                params.push(filterType);
            }
            query += ' ORDER BY timestamp DESC LIMIT ?';
            params.push(limit);

            const events = db.prepare(query).all(...params) as any[];
            if (events.length === 0) return '[TOOL_RESULT] The activity log is empty.';

            const lines = events.map((e: any) => {
                const details = JSON.parse(e.details || '{}');
                const time = e.timestamp.substring(11, 19);
                const date = e.timestamp.substring(0, 10);

                if (e.event_type === 'reboot') {
                    return `[${date} ${time}] REBOOT`;
                }
                if (e.event_type === 'tool_call') {
                    const status = details.ok ? 'OK' : `ERR: ${details.error}`;
                    const duration = details.duration_ms ? ` (${details.duration_ms}ms)` : '';
                    return `[${date} ${time}] ${details.tool}${duration} — ${status}`;
                }
                return `[${date} ${time}] ${e.event_type}: ${JSON.stringify(details).substring(0, 100)}`;
            });

            return `[TOOL_RESULT] Activity log (${events.length} entries):\n${lines.join('\n')}`;
        },

        async insight_add(
            args: { insight: string; person_id?: string; resident_tg_id?: string },
            context?: Partial<RuntimeExecutionContext>
        ) {
            const insight = args.insight.trim().substring(0, 150);
            const todayPrefix = new Date().toISOString().split('T')[0];
            const personId = resolveInsightPersonIdArg(args);

            if (personId) {
                const spaceId = resolveMemorySpaceId(context);
                const existing = getVisiblePersonMemoryEntries(personId, spaceId, 40).find(
                    (entry) =>
                        entry.kind === 'insight' &&
                        entry.created_at.startsWith(todayPrefix) &&
                        entry.content.toLowerCase().startsWith(insight.substring(0, 30).toLowerCase())
                );
                writePersonMemory(personId, 'insight', insight, {
                    salience: 0.65,
                    source: 'insight_add',
                    spaceBoundId: spaceId,
                });
                invalidateCache();
                return existing
                    ? `[TOOL_RESULT] Updated the insight.`
                    : `[TOOL_RESULT] Recorded today's insight: "${insight}"`;
            } else {
                const spaceId = resolveMemorySpaceId(context);
                if (!spaceId) {
                    return '[TOOL_RESULT] General insights require an active chat space.';
                }
                const existing = getMemoryEntries('work', spaceId, 'insight', 40).find(
                    (entry) =>
                        entry.created_at.startsWith(todayPrefix) &&
                        entry.content.toLowerCase().startsWith(insight.substring(0, 30).toLowerCase())
                );
                writeWorkMemory(spaceId, 'insight', insight, {
                    salience: 0.6,
                    source: 'insight_add',
                });
                invalidateCache();
                return existing
                    ? `[TOOL_RESULT] Updated the insight.`
                    : `[TOOL_RESULT] Recorded today's insight: "${insight}"`;
            }
        },

        async insight_today(
            args: { person_id?: string; resident_tg_id?: string },
            context?: Partial<RuntimeExecutionContext>
        ) {
            const db = getDb();
            const personId = resolveInsightPersonIdArg(args);
            const structuredLines = getStructuredInsightEntries(resolveMemorySpaceId(context), personId).map(
                (entry) => {
                    const who = entry.scope_type === 'person' ? ` [${entry.scope_id}]` : '';
                    return `[${entry.created_at.substring(11, 16)}]${who} ${entry.content}`;
                }
            );

            if (structuredLines.length > 0) {
                const lines = [...new Set(structuredLines)];
                return `[TOOL_RESULT] Today's insights (${lines.length}):\n${lines.join('\n')}`;
            }

            const today = new Date().toISOString().split('T')[0];
            let insights: any[];
            const visibility = legacyVisibilityClause('daily_insights', context);
            if (personId) {
                insights = db
                    .prepare(
                        `SELECT * FROM daily_insights
                         WHERE date = ?
                           AND (resident_tg_id = ? OR resident_tg_id IS NULL)
                         ${visibility.sql}
                         ORDER BY created_at`
                    )
                    .all(today, personId, ...visibility.params) as any[];
            } else {
                insights = db
                    .prepare(
                        `SELECT * FROM daily_insights
                         WHERE date = ?
                         ${visibility.sql}
                         ORDER BY created_at`
                    )
                    .all(today, ...visibility.params) as any[];
            }

            if (insights.length === 0) return '[TOOL_RESULT] No insights have been recorded for today yet.';

            const legacyLines = insights.map((i: any) => {
                const time = i.created_at.substring(11, 16);
                const who = i.resident_tg_id ? ` [${i.resident_tg_id}]` : '';
                return `[${time}]${who} ${i.insight}`;
            });
            return `[TOOL_RESULT] Today's insights (${legacyLines.length}):\n${legacyLines.join('\n')}`;
        },
    },

    crons: [
        {
            expression: '0 23 * * *', // 23:00 — write daily diary
            description: 'Daily diary entry',
            handler: async () => {
                const db = getDb();
                if (!HOUSEHOLD_CHAT_ID) return;
                ensureTelegramSpace(HOUSEHOLD_CHAT_ID, 'group', HOUSEHOLD_CHAT_ID);
                const today = new Date().toISOString().split('T')[0];
                const householdSpaceId = resolveMemorySpaceId({
                    chatId: HOUSEHOLD_CHAT_ID,
                    channel: 'telegram',
                    channelRef: HOUSEHOLD_CHAT_ID,
                });
                const existing = getStructuredDiaryEntries(householdSpaceId, 1).find((entry) =>
                    entry.created_at.startsWith(today)
                );
                if (existing) return;

                // Gather events from today
                const events = db
                    .prepare('SELECT * FROM event_log WHERE timestamp >= ? ORDER BY timestamp')
                    .all(today + 'T00:00:00') as any[];

                if (events.length === 0) {
                    writeSpaceMemory(householdSpaceId!, 'diary', 'A quiet day with nothing particularly noteworthy.', {
                        salience: 0.35,
                        source: 'diary_cron',
                    });
                    return;
                }

                // Summarize events via Ollama
                const eventSummary = events
                    .map((e: any) => {
                        const details = JSON.parse(e.details || '{}');
                        return `${e.event_type}: ${JSON.stringify(details)}`;
                    })
                    .join('; ');

                const result = await processWithOllama(
                    `Write a short diary note for the day in 3-5 sentences, in Jeeves style. Events: ${eventSummary}`,
                    'You are Jeeves keeping a private diary. Write briefly, clearly, and with a light touch of wit.'
                );

                const entry = result.text || `Events of the day: ${eventSummary}`;
                writeSpaceMemory(householdSpaceId!, 'diary', entry, {
                    salience: 0.4,
                    source: 'diary_cron',
                });
            },
        },
        {
            expression: '0 4 * * 0', // Sunday 04:00 — weekly compaction
            description: 'Weekly memory compaction',
            handler: async () => {
                const compactedSprints = compactExpiredSprintsForActiveSpaces();
                if (compactedSprints > 0) {
                    console.log(`[MEMORY] Compacted ${compactedSprints} memory sprint(s) across active spaces`);
                }
                await compactDiary();
            },
        },
        {
            expression: '0 4 * * 0', // Sunday 04:00 — clean old insights
            description: 'Cleanup of old insights (older than 7 days)',
            handler: async () => {
                const db = getDb();
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - 7);
                const cutoffStr = cutoff.toISOString().split('T')[0];
                const result = db.prepare('DELETE FROM daily_insights WHERE date < ?').run(cutoffStr);
                if (result.changes > 0) {
                    console.log(`[MEMORY] Cleaned ${result.changes} old daily insights`);
                }
                invalidateCache();
            },
        },
    ],
};

function invalidateCache() {
    invalidateMemoryContextCache();
}

function compactHabits(habits: string): string {
    // Split into individual habits, deduplicate, keep unique ones
    const items = habits
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);

    // Remove exact duplicates
    const unique = [...new Set(items)];

    // Remove near-duplicates (items that are substrings of others)
    const filtered = unique.filter(
        (item, i) => !unique.some((other, j) => j !== i && other.length > item.length && other.includes(item))
    );

    // If still over 500 chars, keep the most recent entries
    let result = filtered.join('; ');
    if (result.length > 500) {
        // Keep last N entries that fit in 500 chars
        const kept: string[] = [];
        let len = 0;
        for (let i = filtered.length - 1; i >= 0; i--) {
            const add = filtered[i].length + (kept.length ? 2 : 0); // +2 for "; "
            if (len + add > 480) break;
            kept.unshift(filtered[i]);
            len += add;
        }
        result = kept.join('; ');
    }

    return result;
}

import { Resident } from '../db';

function formatResidentProfile(r: Resident): string {
    const personId = r.person_id || r.tg_id;
    const name = r.nickname || r.display_name || r.username || personId;
    const parts = [`${name} (person_id: ${personId}, role: ${r.role})`];
    if (r.nickname && r.display_name) parts[0] = `${r.nickname} (${r.display_name}, person_id: ${personId})`;
    if (r.habits) parts.push(`Habits and preferences: ${r.habits}`);
    if (!r.habits) parts.push('Habits and preferences: not yet known');
    return parts.join('\n  ');
}

function activeLegacyDiaryChatJids(): string[] {
    const chatJids = listSpaces('ACTIVE')
        .filter((space) => space.channel === 'telegram')
        .map((space) => space.external_ref)
        .filter(Boolean);

    if (HOUSEHOLD_CHAT_ID && !chatJids.includes(HOUSEHOLD_CHAT_ID)) {
        chatJids.unshift(HOUSEHOLD_CHAT_ID);
    }

    return [...new Set(chatJids)];
}

function legacyDiarySelection(chatJid: string): { sql: string; params: string[] } | null {
    const hasChatJid = legacyColumnExists('house_diary', 'chat_jid');
    if (!hasChatJid) {
        return HOUSEHOLD_CHAT_ID && chatJid === HOUSEHOLD_CHAT_ID ? { sql: '', params: [] } : null;
    }

    const clauses = ['chat_jid = ?'];
    const params = [chatJid];
    if (HOUSEHOLD_CHAT_ID && chatJid === HOUSEHOLD_CHAT_ID) {
        clauses.push("chat_jid IS NULL OR chat_jid = ''");
    }
    return { sql: ` AND (${clauses.join(' OR ')})`, params };
}

async function compactDiary() {
    const db = getDb();

    // Get entries older than 7 days that haven't been compacted
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    for (const chatJid of activeLegacyDiaryChatJids()) {
        ensureTelegramSpace(chatJid, chatJid === HOUSEHOLD_CHAT_ID ? 'group' : 'private', chatJid);
        const selection = legacyDiarySelection(chatJid);
        if (!selection) continue;

        const oldEntries = db
            .prepare(
                `SELECT * FROM house_diary
                 WHERE date < ? AND type = 'daily'
                 ${selection.sql}
                 ORDER BY date`
            )
            .all(cutoffStr, ...selection.params) as any[];

        if (oldEntries.length < 3) continue; // Not enough to compact

        // Group by week
        const weeks: Record<string, any[]> = {};
        for (const entry of oldEntries) {
            const [year, month, day] = String(entry.date).split('-').map(Number);
            const d = new Date(Date.UTC(year, month - 1, day, 12));
            const weekStart = new Date(d);
            weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
            const weekKey = weekStart.toISOString().split('T')[0];
            if (!weeks[weekKey]) weeks[weekKey] = [];
            weeks[weekKey].push(entry);
        }

        for (const [weekStart, entries] of Object.entries(weeks)) {
            if (entries.length < 2) continue;

            const merged = entries.map((e: any) => `[${e.date}] ${e.entry}`).join('\n');
            const weekEnd = entries[entries.length - 1].date;

            // Summarize via Ollama
            const result = await processWithOllama(
                `Compress these daily diary entries into one short weekly summary in 3-5 sentences. Preserve the important events.\n\n${merged}`,
                'You are Jeeves keeping a diary. Write briefly, clearly, and without flourish.'
            );

            const compacted = result.text || (merged.length > 500 ? merged.substring(0, 500) + '...' : merged);
            rememberMemoryEntry({
                scope_type: 'space',
                scope_id: resolveMemorySpaceId({
                    chatId: chatJid,
                    channel: 'telegram',
                    channelRef: chatJid,
                })!,
                memory_sprint_id: null,
                kind: 'recollection',
                content: `Legacy diary recollection for week ${weekStart}..${weekEnd}: ${compacted}`,
                salience: 0.55,
                source: 'legacy_diary_compaction',
            });

            // Delete originals
            const ids = entries.map((e: any) => e.id);
            db.prepare(`DELETE FROM house_diary WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);

            console.log(`[MEMORY] Compacted ${entries.length} diary entries for ${chatJid} week ${weekStart}`);
        }
    }

    invalidateCache();
}

export { getMemoryContext };

export default skill;
