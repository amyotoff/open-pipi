import Database from 'better-sqlite3';
import { mergeSpaceOperationalPolicy } from '../core/space-preferences';

export function createTestDb(): Database.Database {
    const db = new Database(':memory:');

    db.exec(`
        CREATE TABLE IF NOT EXISTS residents (
            tg_id TEXT PRIMARY KEY,
            username TEXT,
            display_name TEXT,
            nickname TEXT,
            role TEXT DEFAULT 'resident',
            last_seen TEXT,
            joined_at TEXT,
            habits TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            type TEXT,
            status TEXT DEFAULT 'ACTIVE'
        );

        CREATE TABLE IF NOT EXISTS spaces (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            title TEXT,
            channel TEXT NOT NULL,
            external_ref TEXT NOT NULL,
            status TEXT DEFAULT 'ACTIVE',
            assistant_pack_id TEXT DEFAULT 'jeeves',
            grounding_pack_id TEXT DEFAULT 'jeeves_personal',
            policy_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'active',
            goal TEXT DEFAULT '',
            next_step TEXT DEFAULT '',
            active_pack_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_links (
            project_id TEXT NOT NULL,
            link_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, link_type, target_id)
        );

        CREATE TABLE IF NOT EXISTS memberships (
            space_id TEXT NOT NULL,
            person_id TEXT NOT NULL,
            role TEXT NOT NULL,
            base_authority INTEGER NOT NULL DEFAULT 100,
            reputation_delta INTEGER NOT NULL DEFAULT 0,
            trust_flags_json TEXT NOT NULL DEFAULT '{}',
            authority_note TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (space_id, person_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            space_id TEXT,
            chat_jid TEXT,
            sender_tg_id TEXT,
            content TEXT,
            timestamp TEXT,
            is_bot INTEGER DEFAULT 0,
            transport TEXT,
            transport_message_id TEXT
        );

        CREATE TABLE IF NOT EXISTS shopping_list (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            item TEXT NOT NULL,
            quantity TEXT DEFAULT '1',
            added_by TEXT,
            added_at TEXT,
            purchased INTEGER DEFAULT 0,
            purchased_at TEXT
        );

        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            chat_jid TEXT NOT NULL,
            sender_tg_id TEXT,
            content TEXT NOT NULL,
            remind_at TEXT NOT NULL,
            schedule_type TEXT,
            schedule_value TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            title TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'assistant_prompt',
            prompt TEXT NOT NULL,
            schedule_type TEXT NOT NULL DEFAULT 'cron',
            schedule_value TEXT NOT NULL,
            config_json TEXT DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'active',
            created_by TEXT DEFAULT 'system',
            last_run_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            status TEXT NOT NULL,
            result TEXT,
            error TEXT,
            duration_ms INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tool_execution_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            task_id TEXT,
            tool_name TEXT NOT NULL,
            run_mode TEXT NOT NULL,
            audit_mode TEXT NOT NULL,
            capabilities_json TEXT DEFAULT '[]',
            args_json TEXT DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'running',
            started_at TEXT NOT NULL,
            finished_at TEXT,
            duration_ms INTEGER DEFAULT 0,
            result_preview TEXT,
            error TEXT,
            sandbox_backend TEXT,
            sandbox_image TEXT,
            sandbox_container_id TEXT,
            workspace_root TEXT,
            network_targets_json TEXT DEFAULT '[]',
            files_read_json TEXT DEFAULT '[]',
            files_written_json TEXT DEFAULT '[]',
            artifacts_json TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS memory_sprints (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            opened_at TEXT NOT NULL,
            closes_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            cadence_days INTEGER NOT NULL DEFAULT 7,
            summary TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            task TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            added_at TEXT,
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS weather_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location TEXT,
            data TEXT,
            fetched_at TEXT
        );

        CREATE TABLE IF NOT EXISTS resident_notes (
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
        );

        CREATE TABLE IF NOT EXISTS house_diary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            entry TEXT NOT NULL,
            type TEXT DEFAULT 'daily',
            token_count INTEGER DEFAULT 0,
            chat_jid TEXT,
            scope TEXT DEFAULT 'global',
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS daily_insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            resident_tg_id TEXT,
            insight TEXT NOT NULL,
            chat_jid TEXT,
            scope TEXT DEFAULT 'global',
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS event_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT,
            details TEXT,
            timestamp TEXT
        );

        CREATE TABLE IF NOT EXISTS token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            timestamp TEXT
        );

        CREATE TABLE IF NOT EXISTS skill_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            assistant_pack_id TEXT DEFAULT 'jeeves',
            capability_gap TEXT DEFAULT '',
            skill_name TEXT,
            description TEXT,
            requested_by TEXT,
            user_request TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT,
            resolved_at TEXT,
            votes INTEGER DEFAULT 1,
            voters TEXT DEFAULT '',
            hardware_needed TEXT DEFAULT '',
            priority TEXT DEFAULT 'normal',
            implementation_ticket TEXT DEFAULT '',
            implementation_ticket_status TEXT DEFAULT '',
            implementation_ticket_created_at TEXT,
            implementation_ticket_updated_at TEXT,
            implementation_ticket_created_by TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS memory_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_type TEXT NOT NULL,
            scope_id TEXT NOT NULL,
            memory_sprint_id TEXT,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            salience REAL DEFAULT 0.5,
            source TEXT DEFAULT 'conversation',
            space_bound_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS grounding_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            subject TEXT NOT NULL,
            content TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            source_message_id TEXT,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            ref TEXT NOT NULL,
            summary TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            archived_at TEXT
        );

        CREATE TABLE IF NOT EXISTS timeline_events (
            id TEXT PRIMARY KEY,
            space_id TEXT NOT NULL,
            day TEXT NOT NULL,
            happened_at TEXT NOT NULL,
            type TEXT NOT NULL,
            ref_type TEXT,
            ref_id TEXT,
            summary TEXT NOT NULL,
            details_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL
        );
    `);

    return db;
}

export function seedResident(
    db: Database.Database,
    resident: Partial<{
        tg_id: string;
        username: string | null;
        display_name: string | null;
        nickname: string | null;
        role: string;
        habits: string;
    }> & { tg_id: string }
): void {
    db.prepare(
        `
        INSERT INTO residents (tg_id, username, display_name, nickname, role, joined_at, habits)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
        resident.tg_id,
        resident.username || null,
        resident.display_name || null,
        resident.nickname || null,
        resident.role || 'owner',
        new Date().toISOString(),
        resident.habits || ''
    );
}

export function makeDbModuleMock(db: Database.Database) {
    const normalizePolicyJson = (policyJson?: string, defaultOnboardingState: 'new' | 'active' = 'active') =>
        JSON.stringify(
            mergeSpaceOperationalPolicy(
                policyJson,
                {},
                {
                    defaultOnboardingState,
                }
            )
        );
    const slugifyProjectTitle = (value: string) =>
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 48) || 'project';
    const getProjectLinkArrays = (projectId: string) => {
        const links = db
            .prepare(
                `
            SELECT * FROM project_links
            WHERE project_id = ?
            ORDER BY updated_at DESC, target_id ASC
        `
            )
            .all(projectId) as any[];
        return {
            linked_spaces: links.filter((link) => link.link_type === 'space').map((link) => link.target_id),
            linked_tasks: links.filter((link) => link.link_type === 'task').map((link) => link.target_id),
            linked_artifacts: links.filter((link) => link.link_type === 'artifact').map((link) => link.target_id),
        };
    };
    const getProject = (id: string) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    const getProjectSnapshot = (id: string) => {
        const project = getProject(id);
        return project ? { ...project, ...getProjectLinkArrays(project.id) } : undefined;
    };

    return {
        PROJECT_STATES: ['active', 'paused', 'someday', 'done'],
        PROJECT_LINK_TYPES: ['space', 'task', 'artifact'],
        getDb: () => db,
        closeDatabase: () => db.close(),
        getResident: (tgId: string) => db.prepare('SELECT * FROM residents WHERE tg_id = ?').get(tgId),
        getAllResidents: () => db.prepare('SELECT * FROM residents ORDER BY tg_id').all(),
        updateResidentHabits: (tgId: string, habits: string) =>
            db.prepare('UPDATE residents SET habits = ? WHERE tg_id = ?').run(habits, tgId),
        updateResidentNickname: (tgId: string, nickname: string) =>
            db.prepare('UPDATE residents SET nickname = ? WHERE tg_id = ?').run(nickname, tgId),
        getRecentMessages: (chatId: string) =>
            db.prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp').all(chatId),
        getRecentMessagesForSpace: (spaceId: string) =>
            db
                .prepare(
                    `SELECT * FROM messages WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ? ORDER BY timestamp`
                )
                .all(spaceId),
        getRecentDirectMessagesForPerson: (channel: string, personId: string, limit: number = 12) => {
            const prefix = `${channel}:`;
            const externalRef =
                channel !== 'telegram' && personId.startsWith(prefix) ? personId.slice(prefix.length) : personId;
            return db
                .prepare(
                    `SELECT * FROM messages WHERE COALESCE(space_id, ? || chat_jid) = ? ORDER BY timestamp DESC LIMIT ?`
                )
                .all(`${channel}:`, `${channel}:${externalRef}`, limit)
                .reverse();
        },
        getDirectContactStatuses: (channel: string, personIds: string[]) => {
            const unique = [...new Set(personIds.filter(Boolean))];
            if (unique.length === 0) return [];
            const placeholders = unique.map(() => '?').join(', ');
            return db
                .prepare(
                    `
                SELECT
                    m.sender_tg_id as person_id,
                    MAX(m.timestamp) as last_inbound_at,
                    COUNT(*) as inbound_count
                FROM messages m
                JOIN spaces s ON s.id = COALESCE(m.space_id, ? || m.chat_jid)
                WHERE s.channel = ?
                  AND s.kind = 'direct_chat'
                  AND m.is_bot = 0
                  AND m.sender_tg_id IN (${placeholders})
                GROUP BY m.sender_tg_id
            `
                )
                .all(`${channel}:`, channel, ...unique);
        },
        searchMessages: (query: string, options?: { spaceId?: string; limit?: number }) => {
            const normalized = query.trim().toLowerCase();
            if (!normalized) return [];
            const conditions = [
                `LOWER(COALESCE(m.content, '') || ' ' || COALESCE(s.title, '') || ' ' || COALESCE(s.external_ref, '') || ' ' || COALESCE(s.policy_json, '')) LIKE ?`,
            ];
            const values: Array<string | number> = [`%${normalized}%`];
            if (options?.spaceId) {
                conditions.push(`COALESCE(m.space_id, 'telegram:' || m.chat_jid) = ?`);
                values.push(options.spaceId);
            }
            values.push(Math.min(Math.max(options?.limit || 8, 1), 20));
            return db
                .prepare(
                    `
                SELECT
                    COALESCE(m.space_id, 'telegram:' || m.chat_jid) as space_id,
                    m.chat_jid,
                    m.sender_tg_id,
                    COALESCE(r.nickname, r.display_name, r.username, m.sender_tg_id) as sender_name,
                    s.title as space_title,
                    m.content,
                    m.timestamp,
                    m.is_bot
                FROM messages m
                LEFT JOIN residents r ON r.tg_id = m.sender_tg_id
                LEFT JOIN spaces s ON s.id = COALESCE(m.space_id, 'telegram:' || m.chat_jid)
                WHERE ${conditions.join(' AND ')}
                ORDER BY m.timestamp DESC
                LIMIT ?
            `
                )
                .all(...values);
        },
        searchRecollections: (query: string, options?: { spaceId?: string; limit?: number }) => {
            const normalized = query.trim().toLowerCase();
            if (!normalized) return [];
            const conditions = [
                `me.kind = 'recollection'`,
                `me.scope_type IN ('space', 'work', 'project')`,
                `LOWER(me.content) LIKE ?`,
            ];
            const values: Array<string | number> = [`%${normalized}%`];
            if (options?.spaceId) {
                conditions.push('me.scope_id = ?');
                values.push(options.spaceId);
            }
            values.push(Math.min(Math.max(options?.limit || 8, 1), 20));
            return db
                .prepare(
                    `
                SELECT
                    me.scope_id as space_id,
                    me.scope_type,
                    COALESCE(s.title, p.title) as space_title,
                    me.content,
                    me.updated_at
                FROM memory_entries me
                LEFT JOIN spaces s ON s.id = me.scope_id
                LEFT JOIN projects p ON p.id = me.scope_id
                WHERE ${conditions.join(' AND ')}
                ORDER BY me.updated_at DESC
                LIMIT ?
            `
                )
                .all(...values);
        },
        listMemorySprints: (spaceId: string, limit: number = 12) =>
            db
                .prepare(
                    `
                SELECT * FROM memory_sprints
                WHERE space_id = ?
                ORDER BY opened_at DESC
                LIMIT ?
            `
                )
                .all(spaceId, Math.min(Math.max(limit, 1), 24)),
        // Mirrors the real storeMessage contract: replaying a message id is a
        // no-op that reports `inserted: false`, which is how the gateway keeps
        // one transport event to one agent run.
        storeMessage: (msg: Record<string, unknown>) => {
            const channelRef = String(msg.channel_ref || msg.chat_jid || '');
            const senderId = msg.sender_id ?? msg.sender_tg_id ?? null;
            const result = db
                .prepare(
                    `
                INSERT INTO messages (
                    id, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot,
                    transport, transport_message_id
                )
                VALUES (
                    @id, @space_id, @chat_jid, @sender_tg_id, @content, @timestamp, @is_bot,
                    @transport, @transport_message_id
                )
                ON CONFLICT(id) DO NOTHING
            `
                )
                .run({
                    ...msg,
                    chat_jid: channelRef,
                    sender_tg_id: senderId,
                    transport: msg.transport ?? msg.channel ?? null,
                    transport_message_id: msg.transport_message_id ?? null,
                });

            return { inserted: result.changes > 0 };
        },
        getChat: (jid: string) => db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid),
        buildSpaceId: (channel: string, externalRef: string) => `${channel}:${externalRef}`,
        buildTelegramSpaceId: (chatId: string) => `telegram:${chatId}`,
        getSpace: (id: string) => db.prepare('SELECT * FROM spaces WHERE id = ?').get(id),
        getProject,
        getProjectSnapshot,
        resolveProjectSelector: (selector: string) => {
            const trimmed = selector.trim();
            if (!trimmed) return undefined;
            const normalized = trimmed.toLowerCase();
            const project = db
                .prepare(
                    `
                SELECT * FROM projects
                WHERE id = ?
                   OR LOWER(slug) = ?
                   OR LOWER(title) = ?
                ORDER BY
                    CASE
                        WHEN id = ? THEN 0
                        WHEN LOWER(slug) = ? THEN 1
                        ELSE 2
                    END,
                    updated_at DESC
                LIMIT 1
            `
                )
                .get(trimmed, normalized, normalized, trimmed, normalized) as any;
            return project ? { ...project, ...getProjectLinkArrays(project.id) } : undefined;
        },
        listProjects: (state?: string) => {
            const projects = state
                ? db
                      .prepare(
                          `
                    SELECT * FROM projects
                    WHERE state = ?
                    ORDER BY
                        CASE state
                            WHEN 'active' THEN 0
                            WHEN 'paused' THEN 1
                            WHEN 'someday' THEN 2
                            ELSE 3
                        END,
                        updated_at DESC,
                        title ASC
                `
                      )
                      .all(state)
                : db
                      .prepare(
                          `
                    SELECT * FROM projects
                    ORDER BY
                        CASE state
                            WHEN 'active' THEN 0
                            WHEN 'paused' THEN 1
                            WHEN 'someday' THEN 2
                            ELSE 3
                        END,
                        updated_at DESC,
                        title ASC
                `
                      )
                      .all();
            return (projects as any[]).map((project) => ({ ...project, ...getProjectLinkArrays(project.id) }));
        },
        createProject: (args: {
            title: string;
            state?: string;
            goal?: string;
            next_step?: string;
            active_pack_id?: string | null;
        }) => {
            const title = args.title.trim();
            const baseSlug = slugifyProjectTitle(title);
            let slug = baseSlug;
            let suffix = 2;
            while (db.prepare('SELECT 1 FROM projects WHERE slug = ? LIMIT 1').get(slug)) {
                slug = `${baseSlug}-${suffix}`;
                suffix += 1;
            }
            const id = `project:${slug}`;
            const now = new Date().toISOString();
            db.prepare(
                `
                INSERT INTO projects (
                    id, slug, title, state, goal, next_step, active_pack_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                id,
                slug,
                title,
                args.state || 'active',
                args.goal?.trim() || '',
                args.next_step?.trim() || '',
                args.active_pack_id?.trim() || null,
                now,
                now
            );
            return getProjectSnapshot(id);
        },
        updateProject: (
            projectId: string,
            patch: {
                title?: string;
                state?: string;
                goal?: string;
                next_step?: string;
                active_pack_id?: string | null;
            }
        ) => {
            const existing = getProject(projectId);
            if (!existing) return undefined;
            db.prepare(
                `
                UPDATE projects
                SET
                    title = ?,
                    state = ?,
                    goal = ?,
                    next_step = ?,
                    active_pack_id = ?,
                    updated_at = ?
                WHERE id = ?
            `
            ).run(
                patch.title?.trim() || existing.title,
                patch.state || existing.state,
                patch.goal !== undefined ? patch.goal.trim() : existing.goal,
                patch.next_step !== undefined ? patch.next_step.trim() : existing.next_step,
                patch.active_pack_id !== undefined ? patch.active_pack_id?.trim() || null : existing.active_pack_id,
                new Date().toISOString(),
                projectId
            );
            return getProjectSnapshot(projectId);
        },
        getProjectLinks: (projectId: string, linkType?: string) =>
            linkType
                ? db
                      .prepare(
                          `
                SELECT * FROM project_links
                WHERE project_id = ? AND link_type = ?
                ORDER BY updated_at DESC, target_id ASC
            `
                      )
                      .all(projectId, linkType)
                : db
                      .prepare(
                          `
                SELECT * FROM project_links
                WHERE project_id = ?
                ORDER BY updated_at DESC, target_id ASC
            `
                      )
                      .all(projectId),
        linkProjectTarget: (projectId: string, linkType: string, targetId: string) => {
            const trimmed = targetId.trim();
            if (!trimmed) return undefined;
            const now = new Date().toISOString();
            db.prepare(
                `
                INSERT INTO project_links (project_id, link_type, target_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(project_id, link_type, target_id) DO UPDATE SET
                    updated_at = excluded.updated_at
            `
            ).run(projectId, linkType, trimmed, now, now);
            return db
                .prepare(
                    `
                SELECT * FROM project_links
                WHERE project_id = ? AND link_type = ? AND target_id = ?
            `
                )
                .get(projectId, linkType, trimmed);
        },
        unlinkProjectTarget: (projectId: string, linkType: string, targetId: string) =>
            db
                .prepare(
                    `
                DELETE FROM project_links
                WHERE project_id = ? AND link_type = ? AND target_id = ?
            `
                )
                .run(projectId, linkType, targetId.trim()).changes,
        getActiveProjectIdForSpace: (spaceId: string) => {
            const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get(spaceId) as
                | { policy_json?: string }
                | undefined;
            const policy = row?.policy_json ? JSON.parse(row.policy_json) : {};
            return typeof policy.active_project_id === 'string' && policy.active_project_id.trim()
                ? policy.active_project_id.trim()
                : null;
        },
        getActiveProjectForSpace: (spaceId: string) => {
            const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get(spaceId) as
                | { policy_json?: string }
                | undefined;
            const policy = row?.policy_json ? JSON.parse(row.policy_json) : {};
            const projectId = typeof policy.active_project_id === 'string' ? policy.active_project_id.trim() : '';
            return projectId ? getProjectSnapshot(projectId) : undefined;
        },
        setSpaceActiveProject: (spaceId: string, projectId: string | null) => {
            if (projectId) {
                const now = new Date().toISOString();
                db.prepare(
                    `
                    INSERT INTO project_links (project_id, link_type, target_id, created_at, updated_at)
                    VALUES (?, 'space', ?, ?, ?)
                    ON CONFLICT(project_id, link_type, target_id) DO UPDATE SET
                        updated_at = excluded.updated_at
                `
                ).run(projectId, spaceId, now, now);
            }
            const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get(spaceId) as
                | { policy_json?: string }
                | undefined;
            const current = row?.policy_json ? JSON.parse(row.policy_json) : {};
            db.prepare('UPDATE spaces SET policy_json = ?, updated_at = ? WHERE id = ?').run(
                JSON.stringify({ ...current, active_project_id: projectId || null }),
                new Date().toISOString(),
                spaceId
            );
        },
        listSpaces: (status?: string) =>
            status
                ? db.prepare('SELECT * FROM spaces WHERE status = ? ORDER BY created_at ASC').all(status)
                : db.prepare('SELECT * FROM spaces ORDER BY created_at ASC').all(),
        getSpaceByChannelRef: (channel: string, externalRef: string) =>
            db.prepare('SELECT * FROM spaces WHERE channel = ? AND external_ref = ? LIMIT 1').get(channel, externalRef),
        listGroundingOverrides: (spaceId: string, options?: { includeInactive?: boolean; limit?: number }) => {
            const limit = Math.min(Math.max(options?.limit || 24, 1), 100);
            const where = options?.includeInactive ? 'space_id = ?' : "space_id = ? AND status = 'active'";
            return db
                .prepare(
                    `
                SELECT * FROM grounding_overrides
                WHERE ${where}
                ORDER BY
                    CASE status WHEN 'active' THEN 0 ELSE 1 END,
                    updated_at DESC,
                    id DESC
                LIMIT ?
            `
                )
                .all(spaceId, limit);
        },
        getSpaceGroundingLevel: (spaceId: string) => {
            const overrides = db
                .prepare(
                    `
                SELECT kind FROM grounding_overrides
                WHERE space_id = ? AND status = 'active'
            `
                )
                .all(spaceId) as Array<{ kind: string }>;

            if (overrides.length === 0) return 0;
            const kinds = new Set(overrides.map((row) => row.kind));
            if (kinds.has('rule') || kinds.has('org')) {
                return kinds.has('person') || kinds.has('place') ? 3 : 2;
            }
            return 1;
        },
        getGroundingOverride: (id: number) => db.prepare('SELECT * FROM grounding_overrides WHERE id = ?').get(id),
        upsertGroundingOverride: (args: {
            space_id: string;
            kind: string;
            subject: string;
            content: string;
            created_by?: string | null;
        }) => {
            const now = new Date().toISOString();
            const existing = db
                .prepare(
                    `
                SELECT * FROM grounding_overrides
                WHERE space_id = ? AND kind = ? AND subject = ? AND status = 'active'
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
            `
                )
                .get(args.space_id, args.kind, args.subject.trim()) as any;

            if (existing) {
                db.prepare(
                    `
                    UPDATE grounding_overrides
                    SET content = ?, created_by = COALESCE(?, created_by), updated_at = ?
                    WHERE id = ?
                `
                ).run(args.content.trim(), args.created_by || null, now, existing.id);
                return db.prepare('SELECT * FROM grounding_overrides WHERE id = ?').get(existing.id);
            }

            const result = db
                .prepare(
                    `
                INSERT INTO grounding_overrides (
                    space_id, kind, subject, content, status, created_by, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
            `
                )
                .run(
                    args.space_id,
                    args.kind,
                    args.subject.trim(),
                    args.content.trim(),
                    args.created_by || null,
                    now,
                    now
                );

            return db.prepare('SELECT * FROM grounding_overrides WHERE id = ?').get(result.lastInsertRowid);
        },
        disableGroundingOverride: (id: number) => {
            db.prepare(
                `
                UPDATE grounding_overrides SET status = 'inactive', updated_at = ? WHERE id = ?
            `
            ).run(new Date().toISOString(), id);
            return db.prepare('SELECT * FROM grounding_overrides WHERE id = ?').get(id);
        },
        getSpaceParticipants: (spaceId: string) =>
            db
                .prepare(
                    `
                SELECT
                    r.*,
                    m.space_id,
                    m.role as membership_role,
                    m.base_authority,
                    m.reputation_delta,
                    m.authority_note,
                    m.trust_flags_json
                FROM memberships m
                JOIN residents r ON r.tg_id = m.person_id
                WHERE m.space_id = ?
                ORDER BY (m.base_authority + m.reputation_delta) DESC
            `
                )
                .all(spaceId)
                .map((row: any) => ({
                    ...row,
                    effective_authority: row.base_authority + row.reputation_delta,
                    trust_flags: row.trust_flags_json ? JSON.parse(row.trust_flags_json) : {},
                })),
        ensureSpaceMembership: (spaceId: string, personId: string, role: string = 'member') => {
            const existing = db
                .prepare('SELECT * FROM memberships WHERE space_id = ? AND person_id = ?')
                .get(spaceId, personId);
            if (!existing) {
                const now = new Date().toISOString();
                db.prepare(
                    `
                    INSERT INTO memberships (space_id, person_id, role, base_authority, reputation_delta, trust_flags_json, authority_note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `
                ).run(
                    spaceId,
                    personId,
                    role,
                    role === 'owner' ? 1000 : 100,
                    0,
                    role === 'owner'
                        ? JSON.stringify({
                              can_assign_tasks: true,
                              can_change_policies: true,
                              can_override_instructions: true,
                              can_issue_high_impact_commands: true,
                          })
                        : '{}',
                    role,
                    now,
                    now
                );
            }
            return db.prepare('SELECT * FROM memberships WHERE space_id = ? AND person_id = ?').get(spaceId, personId);
        },
        getMembership: (spaceId: string, personId: string) => {
            const row = db
                .prepare(
                    `
                SELECT * FROM memberships WHERE space_id = ? AND person_id = ?
            `
                )
                .get(spaceId, personId) as any;
            return row
                ? {
                      ...row,
                      trust_flags: row.trust_flags_json ? JSON.parse(row.trust_flags_json) : {},
                  }
                : undefined;
        },
        memberHasTrustFlag: (spaceId: string, personId: string, flag: string) => {
            const row = db
                .prepare(
                    `
                SELECT trust_flags_json FROM memberships WHERE space_id = ? AND person_id = ?
            `
                )
                .get(spaceId, personId) as { trust_flags_json?: string } | undefined;
            if (!row?.trust_flags_json) return false;
            const flags = JSON.parse(row.trust_flags_json);
            return flags[flag] === true;
        },
        getMemberEffectiveAuthority: (spaceId: string, personId: string) => {
            const row = db
                .prepare(
                    `
                SELECT base_authority, reputation_delta
                FROM memberships
                WHERE space_id = ? AND person_id = ?
            `
                )
                .get(spaceId, personId) as { base_authority: number; reputation_delta: number } | undefined;
            if (!row) return null;
            return row.base_authority + row.reputation_delta;
        },
        listSkillRequests: (options?: {
            spaceId?: string | null;
            assistantPackId?: string | null;
            includeResolved?: boolean;
        }) => {
            const conditions: string[] = [];
            const values: Array<string> = [];
            if (options?.spaceId) {
                conditions.push('space_id = ?');
                values.push(options.spaceId);
            }
            if (options?.assistantPackId) {
                conditions.push('assistant_pack_id = ?');
                values.push(options.assistantPackId);
            }
            if (!options?.includeResolved) {
                conditions.push("status IN ('pending', 'in_progress')");
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            return db
                .prepare(
                    `
                SELECT * FROM skill_requests
                ${where}
                ORDER BY
                    CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                    votes DESC,
                    created_at DESC
            `
                )
                .all(...values);
        },
        getSkillRequest: (id: number) => db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(id),
        createCapabilityGapRequest: (args: {
            space_id?: string | null;
            assistant_pack_id?: string | null;
            capability_gap: string;
            skill_name?: string;
            description: string;
            requested_by: string;
            user_request: string;
            user_title?: string;
            hardware_needed?: string;
            priority?: string;
        }) => {
            const normalize = (value: string) =>
                value
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_+|_+$/g, '') || 'unknown_capability_gap';
            const normalizedGap = normalize(args.capability_gap);
            const skillName = normalize(args.skill_name || normalizedGap);
            const requestedBy = args.requested_by || 'unknown';
            const hardwareNeeded = args.hardware_needed?.trim() || '';
            const priority = args.priority || (hardwareNeeded ? 'low' : 'normal');
            const userTitle = args.user_title?.trim();
            const description = `${userTitle ? `[${userTitle}] ` : ''}${args.description.trim()}`;

            const existing = db
                .prepare(
                    `
                SELECT * FROM skill_requests
                WHERE COALESCE(space_id, '') = COALESCE(?, '')
                  AND COALESCE(assistant_pack_id, '') = COALESCE(?, '')
                  AND capability_gap = ?
                  AND status IN ('pending', 'in_progress')
                ORDER BY votes DESC, id DESC
                LIMIT 1
            `
                )
                .get(args.space_id || null, args.assistant_pack_id || null, normalizedGap) as any;

            if (existing) {
                const voters = existing.voters ? existing.voters.split(',').filter(Boolean) : [];
                if (!voters.includes(requestedBy)) voters.push(requestedBy);
                const votes = voters.length > 0 ? voters.length : (existing.votes || 1) + 1;
                const nextDescription = existing.description.includes(args.description.trim())
                    ? existing.description
                    : `${existing.description}\n---\nAdditional request: "${args.user_request}"\nNeed: ${args.description.trim()}`;
                db.prepare(
                    `
                    UPDATE skill_requests
                    SET votes = ?, voters = ?, description = ?, user_request = ?, hardware_needed = ?, priority = ?
                    WHERE id = ?
                `
                ).run(
                    votes,
                    voters.join(','),
                    nextDescription,
                    args.user_request.trim(),
                    hardwareNeeded || existing.hardware_needed || '',
                    priority,
                    existing.id
                );
                return {
                    request: db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(existing.id),
                    deduped: true,
                    votes,
                };
            }

            const createdAt = new Date().toISOString();
            const result = db
                .prepare(
                    `
                INSERT INTO skill_requests (
                    space_id,
                    assistant_pack_id,
                    capability_gap,
                    skill_name,
                    description,
                    requested_by,
                    user_request,
                    status,
                    created_at,
                    votes,
                    voters,
                    hardware_needed,
                    priority
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?)
            `
                )
                .run(
                    args.space_id || null,
                    args.assistant_pack_id || null,
                    normalizedGap,
                    skillName,
                    description,
                    requestedBy,
                    args.user_request.trim(),
                    createdAt,
                    requestedBy,
                    hardwareNeeded,
                    priority
                );
            return {
                request: db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(result.lastInsertRowid),
                deduped: false,
                votes: 1,
            };
        },
        saveImplementationTicket: (args: {
            request_id: number;
            ticket: string;
            created_by: string;
            status?: string;
        }) => {
            const existing = db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(args.request_id) as any;
            if (!existing) return undefined;

            const now = new Date().toISOString();
            db.prepare(
                `
                UPDATE skill_requests
                SET implementation_ticket = ?,
                    implementation_ticket_status = ?,
                    implementation_ticket_created_at = COALESCE(implementation_ticket_created_at, ?),
                    implementation_ticket_updated_at = ?,
                    implementation_ticket_created_by = COALESCE(NULLIF(implementation_ticket_created_by, ''), ?)
                WHERE id = ?
            `
            ).run(
                args.ticket.trim(),
                args.status || existing.implementation_ticket_status || 'draft',
                now,
                now,
                args.created_by || 'unknown',
                args.request_id
            );

            return db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(args.request_id);
        },
        clearSkillRequests: (options?: { spaceId?: string | null; assistantPackId?: string | null }) => {
            const conditions = ["status IN ('pending', 'in_progress')"];
            const values: Array<string> = [];
            if (options?.spaceId) {
                conditions.push('space_id = ?');
                values.push(options.spaceId);
            }
            if (options?.assistantPackId) {
                conditions.push('assistant_pack_id = ?');
                values.push(options.assistantPackId);
            }
            const result = db
                .prepare(
                    `
                UPDATE skill_requests SET status = 'cleared' WHERE ${conditions.join(' AND ')}
            `
                )
                .run(...values);
            return result.changes;
        },
        updateMembershipRole: (spaceId: string, personId: string, role: string) => {
            const authorityByRole: Record<string, { base: number; note: string; flags: Record<string, boolean> }> = {
                owner: {
                    base: 1000,
                    note: 'space owner',
                    flags: {
                        can_assign_tasks: true,
                        can_change_policies: true,
                        can_override_instructions: true,
                        can_issue_high_impact_commands: true,
                    },
                },
                admin: {
                    base: 1000,
                    note: 'space owner',
                    flags: {
                        can_assign_tasks: true,
                        can_change_policies: true,
                        can_override_instructions: true,
                        can_issue_high_impact_commands: true,
                    },
                },
                manager: {
                    base: 500,
                    note: 'manager',
                    flags: {
                        can_assign_tasks: true,
                        can_change_policies: false,
                        can_override_instructions: true,
                        can_issue_high_impact_commands: false,
                    },
                },
                guest: {
                    base: 30,
                    note: 'guest',
                    flags: {
                        can_assign_tasks: false,
                        can_change_policies: false,
                        can_override_instructions: false,
                        can_issue_high_impact_commands: false,
                    },
                },
                service_bot: {
                    base: 10,
                    note: 'service bot',
                    flags: {
                        can_assign_tasks: false,
                        can_change_policies: false,
                        can_override_instructions: false,
                        can_issue_high_impact_commands: false,
                    },
                },
                member: {
                    base: 100,
                    note: 'member',
                    flags: {
                        can_assign_tasks: true,
                        can_change_policies: false,
                        can_override_instructions: false,
                        can_issue_high_impact_commands: false,
                    },
                },
            };
            const preset = authorityByRole[role] || authorityByRole.member;
            db.prepare(
                `
                UPDATE memberships
                SET role = ?, base_authority = ?, trust_flags_json = ?, authority_note = ?, updated_at = ?
                WHERE space_id = ? AND person_id = ?
            `
            ).run(
                role,
                preset.base,
                JSON.stringify(preset.flags),
                preset.note,
                new Date().toISOString(),
                spaceId,
                personId
            );
            return db.prepare('SELECT * FROM memberships WHERE space_id = ? AND person_id = ?').get(spaceId, personId);
        },
        updateMembershipReputation: (spaceId: string, personId: string, reputationDelta: number) => {
            db.prepare(
                `
                UPDATE memberships SET reputation_delta = ?, updated_at = ? WHERE space_id = ? AND person_id = ?
            `
            ).run(reputationDelta, new Date().toISOString(), spaceId, personId);
            return db.prepare('SELECT * FROM memberships WHERE space_id = ? AND person_id = ?').get(spaceId, personId);
        },
        updateMembershipTrustFlag: (spaceId: string, personId: string, flag: string, enabled: boolean) => {
            const row = db
                .prepare(
                    `
                SELECT trust_flags_json FROM memberships WHERE space_id = ? AND person_id = ?
            `
                )
                .get(spaceId, personId) as { trust_flags_json?: string } | undefined;
            const flags = row?.trust_flags_json ? JSON.parse(row.trust_flags_json) : {};
            flags[flag] = enabled;
            db.prepare(
                `
                UPDATE memberships SET trust_flags_json = ?, updated_at = ? WHERE space_id = ? AND person_id = ?
            `
            ).run(JSON.stringify(flags), new Date().toISOString(), spaceId, personId);
            return db.prepare('SELECT * FROM memberships WHERE space_id = ? AND person_id = ?').get(spaceId, personId);
        },
        updateSpaceAssistantPack: (spaceId: string, assistantPackId: string) =>
            db
                .prepare('UPDATE spaces SET assistant_pack_id = ?, updated_at = ? WHERE id = ?')
                .run(assistantPackId, new Date().toISOString(), spaceId),
        updateSpaceGroundingPack: (spaceId: string, groundingPackId: string) =>
            db
                .prepare('UPDATE spaces SET grounding_pack_id = ?, updated_at = ? WHERE id = ?')
                .run(groundingPackId, new Date().toISOString(), spaceId),
        updateSpacePolicy: (spaceId: string, patch: Record<string, unknown>) => {
            const row = db.prepare('SELECT policy_json FROM spaces WHERE id = ?').get(spaceId) as
                | { policy_json?: string }
                | undefined;
            return db.prepare('UPDATE spaces SET policy_json = ?, updated_at = ? WHERE id = ?').run(
                JSON.stringify(
                    mergeSpaceOperationalPolicy(row?.policy_json, patch, {
                        defaultOnboardingState: 'active',
                    })
                ),
                new Date().toISOString(),
                spaceId
            );
        },
        upsertChat: (chat: { jid: string; type?: string; status?: string }) =>
            db
                .prepare(
                    `
                INSERT INTO chats (jid, type, status)
                VALUES (?, ?, ?)
                ON CONFLICT(jid) DO UPDATE SET type = excluded.type, status = excluded.status
            `
                )
                .run(chat.jid, chat.type || 'private', chat.status || 'ACTIVE'),
        ensureTelegramSpace: (chatId: string, chatType: string = 'private', title?: string | null) => {
            const id = `telegram:${chatId}`;
            const existing = db.prepare('SELECT id, policy_json FROM spaces WHERE id = ?').get(id) as
                | { id: string; policy_json?: string }
                | undefined;
            const policyJson = normalizePolicyJson(existing?.policy_json, existing ? 'active' : 'new');
            db.prepare(
                `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, 'telegram', ?, 'ACTIVE', 'jeeves', 'jeeves_personal', ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    title = excluded.title,
                    policy_json = excluded.policy_json,
                    updated_at = excluded.updated_at
            `
            ).run(
                id,
                chatType.includes('group') ? 'group_chat' : 'direct_chat',
                title || chatId,
                chatId,
                policyJson,
                new Date().toISOString(),
                new Date().toISOString()
            );
            return db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
        },
        upsertSpace: (space: {
            id: string;
            kind: string;
            title?: string | null;
            channel: string;
            external_ref: string;
            status?: string;
            assistant_pack_id?: string;
            grounding_pack_id?: string;
            policy_json?: string;
        }) =>
            db
                .prepare(
                    `
                INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    title = excluded.title,
                    channel = excluded.channel,
                    external_ref = excluded.external_ref,
                    status = excluded.status,
                    assistant_pack_id = excluded.assistant_pack_id,
                    grounding_pack_id = excluded.grounding_pack_id,
                    policy_json = excluded.policy_json,
                    updated_at = excluded.updated_at
            `
                )
                .run(
                    space.id,
                    space.kind,
                    space.title || null,
                    space.channel,
                    space.external_ref,
                    space.status || 'ACTIVE',
                    space.assistant_pack_id || 'jeeves',
                    space.grounding_pack_id || 'jeeves_personal',
                    normalizePolicyJson(space.policy_json, 'active'),
                    new Date().toISOString(),
                    new Date().toISOString()
                ),
        getTask: (id: string) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
        getTaskRuns: (taskId: string) =>
            db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId),
        upsertTask: (task: any) =>
            db
                .prepare(
                    `
                INSERT INTO tasks (
                    id, space_id, title, kind, prompt, schedule_type, schedule_value,
                    config_json, status, created_by, last_run_at, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    space_id = excluded.space_id,
                    title = excluded.title,
                    kind = excluded.kind,
                    prompt = excluded.prompt,
                    schedule_type = excluded.schedule_type,
                    schedule_value = excluded.schedule_value,
                    config_json = excluded.config_json,
                    status = excluded.status,
                    created_by = excluded.created_by,
                    updated_at = excluded.updated_at
            `
                )
                .run(
                    task.id,
                    task.space_id,
                    task.title,
                    task.kind || 'assistant_prompt',
                    task.prompt,
                    task.schedule_type,
                    task.schedule_value,
                    task.config_json || '{}',
                    task.status || 'active',
                    task.created_by || 'system',
                    task.last_run_at || null,
                    task.created_at || new Date().toISOString(),
                    new Date().toISOString()
                ),
        listTasks: (spaceId?: string, status?: string) => {
            if (spaceId && status) {
                return db
                    .prepare('SELECT * FROM tasks WHERE space_id = ? AND status = ? ORDER BY title ASC')
                    .all(spaceId, status);
            }
            if (spaceId) {
                return db.prepare('SELECT * FROM tasks WHERE space_id = ? ORDER BY title ASC').all(spaceId);
            }
            if (status) {
                return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY title ASC').all(status);
            }
            return db.prepare('SELECT * FROM tasks ORDER BY title ASC').all();
        },
        updateTaskLastRun: (id: string, lastRunAt: string) =>
            db
                .prepare('UPDATE tasks SET last_run_at = ?, updated_at = ? WHERE id = ?')
                .run(lastRunAt, new Date().toISOString(), id),
        updateTaskStatus: (id: string, status: string) =>
            db
                .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
                .run(status, new Date().toISOString(), id),
        recordTaskRun: (run: {
            task_id: string;
            started_at: string;
            finished_at: string;
            status: string;
            result: string | null;
            error: string | null;
            duration_ms: number;
        }) =>
            db
                .prepare(
                    `
                INSERT INTO task_runs (task_id, started_at, finished_at, status, result, error, duration_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `
                )
                .run(run.task_id, run.started_at, run.finished_at, run.status, run.result, run.error, run.duration_ms),
        deleteTask: (id: string) => db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes,
        upsertResident: (resident: Record<string, unknown>) =>
            db
                .prepare(
                    `
                INSERT INTO residents (tg_id, username, display_name, nickname, role, joined_at, habits)
                VALUES (@tg_id, @username, @display_name, @nickname, @role, @joined_at, @habits)
                ON CONFLICT(tg_id) DO UPDATE SET
                    username = excluded.username,
                    display_name = excluded.display_name,
                    nickname = excluded.nickname,
                    role = excluded.role,
                    habits = excluded.habits
            `
                )
                .run({
                    tg_id: resident.tg_id,
                    username: resident.username || null,
                    display_name: resident.display_name || null,
                    nickname: resident.nickname || null,
                    role: resident.role || 'owner',
                    joined_at: resident.joined_at || new Date().toISOString(),
                    habits: resident.habits || '',
                }),
        clearMessages: (chatId: string) => db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatId),
        logEvent: (eventType: string, details: Record<string, unknown>) =>
            db
                .prepare('INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)')
                .run(eventType, JSON.stringify(details), new Date().toISOString()),
        logTokenUsage: (model: string, inputTokens: number, outputTokens: number) =>
            db
                .prepare(
                    `
                INSERT INTO token_usage (date, model, input_tokens, output_tokens, cost_usd, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `
                )
                .run(
                    new Date().toISOString().slice(0, 10),
                    model,
                    inputTokens,
                    outputTokens,
                    0,
                    new Date().toISOString()
                ),
        getDailyTokenCost: () =>
            db
                .prepare(
                    `
                SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
                       COALESCE(SUM(output_tokens), 0) as output_tokens,
                       COALESCE(SUM(cost_usd), 0) as cost_usd,
                       COUNT(*) as calls
                FROM token_usage
            `
                )
                .get(),
        rememberMemoryEntry: (entry: {
            scope_type: string;
            scope_id: string;
            memory_sprint_id?: string | null;
            kind: string;
            content: string;
            salience?: number;
            source?: string;
            space_bound_id?: string | null;
        }) =>
            db
                .prepare(
                    `
                INSERT INTO memory_entries (
                    scope_type, scope_id, memory_sprint_id, kind, content, salience, source, space_bound_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
                )
                .run(
                    entry.scope_type,
                    entry.scope_id,
                    entry.memory_sprint_id || null,
                    entry.kind,
                    entry.content,
                    entry.salience ?? 0.5,
                    entry.source || 'conversation',
                    entry.space_bound_id || null,
                    new Date().toISOString(),
                    new Date().toISOString()
                ),
        getMemoryEntries: (scopeType?: string, scopeId?: string, kind?: string, limit: number = 20) => {
            if (scopeType && scopeId && kind) {
                return db
                    .prepare(
                        `
                    SELECT * FROM memory_entries
                    WHERE scope_type = ? AND scope_id = ? AND kind = ?
                    ORDER BY salience DESC, updated_at DESC
                    LIMIT ?
                `
                    )
                    .all(scopeType, scopeId, kind, limit);
            }
            if (scopeType && scopeId) {
                return db
                    .prepare(
                        `
                    SELECT * FROM memory_entries
                    WHERE scope_type = ? AND scope_id = ?
                    ORDER BY salience DESC, updated_at DESC
                    LIMIT ?
                `
                    )
                    .all(scopeType, scopeId, limit);
            }
            return db
                .prepare(
                    `
                SELECT * FROM memory_entries
                ORDER BY salience DESC, updated_at DESC
                LIMIT ?
            `
                )
                .all(limit);
        },
        getVisiblePersonMemoryEntries: (scopeId: string, spaceId?: string, limit: number = 20) => {
            if (!spaceId) {
                return db
                    .prepare(
                        `
                    SELECT * FROM memory_entries
                    WHERE scope_type = 'person' AND scope_id = ? AND space_bound_id IS NULL
                    ORDER BY salience DESC, updated_at DESC
                    LIMIT ?
                `
                    )
                    .all(scopeId, limit);
            }
            return db
                .prepare(
                    `
                SELECT * FROM memory_entries
                WHERE scope_type = 'person' AND scope_id = ? AND (space_bound_id IS NULL OR space_bound_id = ?)
                ORDER BY salience DESC, updated_at DESC
                LIMIT ?
            `
                )
                .all(scopeId, spaceId, limit);
        },
        deleteMemoryEntriesByContent: (fragment: string) =>
            db.prepare('DELETE FROM memory_entries WHERE content LIKE ?').run(`%${fragment}%`).changes,
        getArtifact: (id: string) => db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id),
        getArtifactByKindAndTitle: (spaceId: string, kind: string, title: string) => {
            return db
                .prepare(
                    `
                SELECT * FROM artifacts
                WHERE space_id = ? AND kind = ? AND title = ?
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
            `
                )
                .get(spaceId, kind, title);
        },
        createArtifact: (artifact: any) => {
            const now = new Date().toISOString();
            const created = artifact.created_at || now;
            db.prepare(
                `
                INSERT INTO artifacts (id, space_id, source_message_id, kind, title, ref, summary, created_at, updated_at, archived_at)
                VALUES (@id, @space_id, @source_message_id, @kind, @title, @ref, @summary, @created_at, @updated_at, @archived_at)
            `
            ).run({
                ...artifact,
                created_at: created,
                updated_at: created,
                archived_at: null,
            });
            return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifact.id);
        },
        updateArtifact: (id: string, patch: any) => {
            const existing = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as any;
            if (!existing) return undefined;
            const now = new Date().toISOString();
            db.prepare(
                `
                UPDATE artifacts
                SET ref = @ref, summary = @summary, title = @title, archived_at = @archived_at, updated_at = @updated_at
                WHERE id = @id
            `
            ).run({
                id,
                ref: patch.ref !== undefined ? patch.ref : existing.ref,
                summary: patch.summary !== undefined ? patch.summary : existing.summary,
                title: patch.title !== undefined ? patch.title : existing.title,
                archived_at: patch.archived_at !== undefined ? patch.archived_at : existing.archived_at,
                updated_at: now,
            });
            return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
        },
        listArtifacts: (spaceId: string, options?: any) => {
            const limit = options?.limit || 100;
            const includeArchived = options?.includeArchived ?? false;
            const where = includeArchived ? 'space_id = ?' : 'space_id = ? AND archived_at IS NULL';
            return db
                .prepare(`SELECT * FROM artifacts WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
                .all(spaceId, limit);
        },
        archiveOldArtifactsForKind: (spaceId: string, kind: string, currentIdToKeep: string) => {
            const now = new Date().toISOString();
            db.prepare(
                `
                UPDATE artifacts
                SET archived_at = @now, updated_at = @now
                WHERE space_id = @space_id AND kind = @kind AND id != @id AND archived_at IS NULL
            `
            ).run({ space_id: spaceId, kind, now, id: currentIdToKeep });
        },
        getLatestArtifactByKind: (spaceId: string, kind: string) => {
            return db
                .prepare(
                    `
                SELECT * FROM artifacts
                WHERE space_id = ? AND kind = ? AND archived_at IS NULL
                ORDER BY updated_at DESC
                LIMIT 1
            `
                )
                .get(spaceId, kind);
        },
        createTimelineEvent: (event: any) => {
            db.prepare(
                `
                INSERT INTO timeline_events (
                    id, space_id, day, happened_at, type, ref_type, ref_id, summary, details_json, created_at
                )
                VALUES (
                    @id, @space_id, @day, @happened_at, @type, @ref_type, @ref_id, @summary, @details_json, @created_at
                )
            `
            ).run({
                id: event.id,
                space_id: event.space_id,
                day: event.day,
                happened_at: event.happened_at,
                type: event.type,
                ref_type: event.ref_type || null,
                ref_id: event.ref_id || null,
                summary: event.summary,
                details_json: event.details_json || '{}',
                created_at: event.created_at,
            });
            return db.prepare('SELECT * FROM timeline_events WHERE id = ?').get(event.id);
        },
        listTimelineEvents: (spaceId: string, options?: any) => {
            const conditions = ['space_id = ?'];
            const values: Array<string | number> = [spaceId];

            if (options?.day) {
                conditions.push('day = ?');
                values.push(options.day);
            } else {
                if (options?.fromDay) {
                    conditions.push('day >= ?');
                    values.push(options.fromDay);
                }
                if (options?.toDay) {
                    conditions.push('day <= ?');
                    values.push(options.toDay);
                }
            }

            return db
                .prepare(
                    `
                SELECT * FROM timeline_events
                WHERE ${conditions.join(' AND ')}
                ORDER BY happened_at DESC, created_at DESC
                LIMIT ?
            `
                )
                .all(...values, options?.limit || 120);
        },
    };
}
