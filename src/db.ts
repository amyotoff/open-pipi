import Database from 'better-sqlite3';
import { DB_PATH } from './config';
import { authorityPresetForRole, effectiveAuthority, hasTrustFlag, TrustFlag, TrustFlags } from './core/authority';
import { mergeSpaceOperationalPolicy, type SpaceOnboardingState } from './core/space-preferences';
import type { GroundingOverride, GroundingOverrideKind } from './core/grounding-types';

let db: Database.Database | undefined;

function configureDatabase(database: Database.Database): void {
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.pragma('synchronous = NORMAL');
    database.pragma('foreign_keys = ON');
}

function createSchema(database: Database.Database): void {
    database.exec(`
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_channel_external_ref
            ON spaces(channel, external_ref);

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
        CREATE INDEX IF NOT EXISTS idx_projects_state_updated
            ON projects(state, updated_at DESC);

        CREATE TABLE IF NOT EXISTS project_links (
            project_id TEXT NOT NULL,
            link_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, link_type, target_id)
        );
        CREATE INDEX IF NOT EXISTS idx_project_links_type_target_updated
            ON project_links(link_type, target_id, updated_at DESC);

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
        CREATE INDEX IF NOT EXISTS idx_memberships_space_role ON memberships(space_id, role);

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            space_id TEXT,
            chat_jid TEXT,
            sender_tg_id TEXT,
            content TEXT,
            timestamp TEXT,
            is_bot INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp);

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
        CREATE INDEX IF NOT EXISTS idx_shopping_list_space_purchased_added
            ON shopping_list(space_id, purchased, added_at);
        CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            task TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            added_at TEXT,
            completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_todos_space_status_added
            ON todos(space_id, status, added_at);
        CREATE TABLE IF NOT EXISTS event_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT,
            details TEXT,
            timestamp TEXT
        );

        CREATE TABLE IF NOT EXISTS weather_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location TEXT,
            data TEXT,
            fetched_at TEXT
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
            implementation_ticket TEXT DEFAULT '',
            implementation_ticket_status TEXT DEFAULT '',
            implementation_ticket_created_at TEXT,
            implementation_ticket_updated_at TEXT,
            implementation_ticket_created_by TEXT DEFAULT ''
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
        CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date);

        CREATE TABLE IF NOT EXISTS system_metrics_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            temp_c REAL,
            ram_percent INTEGER,
            swap_used_mb INTEGER,
            disk_percent INTEGER,
            throttle_hex TEXT,
            internet_ok INTEGER DEFAULT 1,
            ollama_ok INTEGER DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_system_metrics_history_timestamp ON system_metrics_history(timestamp);

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
        CREATE INDEX IF NOT EXISTS idx_reminders_status_time ON reminders(status, remind_at);

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
        CREATE INDEX IF NOT EXISTS idx_tasks_space_status ON tasks(space_id, status);

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
        CREATE INDEX IF NOT EXISTS idx_task_runs_task_started_at ON task_runs(task_id, started_at);

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
        CREATE INDEX IF NOT EXISTS idx_tool_execution_log_space_started
            ON tool_execution_log(space_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_execution_log_task_started
            ON tool_execution_log(task_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS tool_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            task_id TEXT,
            tool_name TEXT NOT NULL,
            run_mode TEXT NOT NULL,
            audit_mode TEXT NOT NULL,
            args_json TEXT DEFAULT '{}',
            result_text TEXT,
            status TEXT NOT NULL,
            error TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            duration_ms INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_tool_logs_space_started
            ON tool_logs(space_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_logs_task_started
            ON tool_logs(task_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_logs_tool_started
            ON tool_logs(tool_name, started_at DESC);

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
        CREATE INDEX IF NOT EXISTS idx_memory_sprints_space_status
            ON memory_sprints(space_id, status, opened_at DESC);

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
        CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_updated
            ON memory_entries(scope_type, scope_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_sprint_updated
            ON memory_entries(scope_type, scope_id, memory_sprint_id, updated_at DESC);

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
        CREATE INDEX IF NOT EXISTS idx_grounding_overrides_space_status_updated
            ON grounding_overrides(space_id, status, updated_at DESC);

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
        CREATE INDEX IF NOT EXISTS idx_artifacts_space_kind_updated
            ON artifacts(space_id, kind, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_artifacts_space_archived
            ON artifacts(space_id, archived_at);

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
        CREATE INDEX IF NOT EXISTS idx_timeline_events_space_day_happened
            ON timeline_events(space_id, day, happened_at DESC);
        CREATE INDEX IF NOT EXISTS idx_timeline_events_space_happened
            ON timeline_events(space_id, happened_at DESC);

        -- Which external endpoint routes into which space. A space may hold
        -- several bindings (Telegram and Web at once); an endpoint holds one.
        CREATE TABLE IF NOT EXISTS transport_bindings (
            id TEXT PRIMARY KEY,
            transport TEXT NOT NULL,
            endpoint_id TEXT NOT NULL,
            endpoint_type TEXT NOT NULL,
            thread_id TEXT,
            -- SQLite treats NULLs as distinct in unique indexes, so "no thread"
            -- has to be a concrete value for the endpoint index to mean anything.
            normalized_thread_id TEXT NOT NULL DEFAULT '',
            space_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        -- Uniqueness spans every status: a disabled binding still owns its
        -- endpoint, and re-enabling it is an UPDATE rather than a race.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_transport_bindings_endpoint
            ON transport_bindings(transport, endpoint_id, normalized_thread_id);
        CREATE INDEX IF NOT EXISTS idx_transport_bindings_space
            ON transport_bindings(space_id, status);

        -- One person, many external accounts. participant_id points at
        -- residents.tg_id, which stays the person id everything else uses.
        CREATE TABLE IF NOT EXISTS participant_identities (
            id TEXT PRIMARY KEY,
            participant_id TEXT NOT NULL,
            transport TEXT NOT NULL,
            external_user_id TEXT NOT NULL,
            username TEXT,
            display_name TEXT,
            verified_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_identities_external
            ON participant_identities(transport, external_user_id);
        CREATE INDEX IF NOT EXISTS idx_participant_identities_participant
            ON participant_identities(participant_id);

        -- Durable outbound queue. Entries are written before any send is
        -- attempted, so a crash mid-delivery loses nothing.
        CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL,
            space_id TEXT,
            message_id TEXT,
            transport TEXT NOT NULL,
            endpoint_id TEXT NOT NULL,
            endpoint_type TEXT NOT NULL DEFAULT '',
            thread_id TEXT,
            payload_json TEXT NOT NULL,
            -- Carried from the inbound message, so one turn can be followed from
            -- "someone said this" to "the answer went out".
            correlation_id TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at TEXT,
            last_error TEXT,
            claimed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sent_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency
            ON outbox(idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_outbox_status_next_retry
            ON outbox(status, next_retry_at);
        -- Delivery is FIFO per endpoint, so the worker reads in this order.
        CREATE INDEX IF NOT EXISTS idx_outbox_endpoint_created
            ON outbox(transport, endpoint_id, created_at);

        -- Local Web accounts. participant_id points at an existing participant,
        -- which is what makes a Web login the same person as their Telegram
        -- account rather than a stranger with the same name.
        CREATE TABLE IF NOT EXISTS web_accounts (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            participant_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_web_accounts_participant
            ON web_accounts(participant_id);

        -- Sessions are stored hashed: a stolen database must not hand over live
        -- sessions the way a stolen cookie would.
        CREATE TABLE IF NOT EXISTS web_sessions (
            token_hash TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_web_sessions_expires
            ON web_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_web_sessions_username
            ON web_sessions(username);
    `);
}

function hasColumn(database: Database.Database, table: string, column: string): boolean {
    const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
}

function dropColumnIfExists(database: Database.Database, table: string, column: string): void {
    if (!hasColumn(database, table, column)) return;
    database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

function runMigrations(database: Database.Database): void {
    try {
        database.exec('ALTER TABLE residents ADD COLUMN nickname TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE residents ADD COLUMN habits TEXT DEFAULT ""');
    } catch {}
    try {
        database.exec("UPDATE residents SET role = 'owner' WHERE role = 'resident'");
    } catch {}

    try {
        database.exec('ALTER TABLE skill_requests ADD COLUMN votes INTEGER DEFAULT 1');
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN voters TEXT DEFAULT ''");
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN hardware_needed TEXT DEFAULT ''");
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN priority TEXT DEFAULT 'normal'");
    } catch {}
    try {
        database.exec('ALTER TABLE skill_requests ADD COLUMN space_id TEXT');
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN assistant_pack_id TEXT DEFAULT 'jeeves'");
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN capability_gap TEXT DEFAULT ''");
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN implementation_ticket TEXT DEFAULT ''");
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN implementation_ticket_status TEXT DEFAULT ''");
    } catch {}
    try {
        database.exec('ALTER TABLE skill_requests ADD COLUMN implementation_ticket_created_at TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE skill_requests ADD COLUMN implementation_ticket_updated_at TEXT');
    } catch {}
    try {
        database.exec("ALTER TABLE skill_requests ADD COLUMN implementation_ticket_created_by TEXT DEFAULT ''");
    } catch {}
    try {
        database.exec('ALTER TABLE messages ADD COLUMN space_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE shopping_list ADD COLUMN space_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE reminders ADD COLUMN space_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE reminders ADD COLUMN schedule_type TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE reminders ADD COLUMN schedule_value TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE todos ADD COLUMN space_id TEXT');
    } catch {}
    try {
        database.exec("ALTER TABLE spaces ADD COLUMN policy_json TEXT DEFAULT '{}'");
    } catch {}
    try {
        database.exec("ALTER TABLE spaces ADD COLUMN grounding_pack_id TEXT DEFAULT 'jeeves_personal'");
    } catch {}
    // Human-facing space identity, so Web routes never have to expose or parse
    // a space id (which still carries a transport prefix for historical rows).
    try {
        database.exec('ALTER TABLE spaces ADD COLUMN slug TEXT');
    } catch {}
    try {
        database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug) WHERE slug IS NOT NULL');
    } catch {}
    // Which transport a message came from, and its id on that transport —
    // needed to reply in-thread once delivery is asynchronous.
    try {
        database.exec('ALTER TABLE messages ADD COLUMN transport TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE messages ADD COLUMN transport_message_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE outbox ADD COLUMN correlation_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE projects ADD COLUMN active_pack_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE memory_entries ADD COLUMN memory_sprint_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE memory_entries ADD COLUMN space_bound_id TEXT');
    } catch {}
    try {
        database.exec('ALTER TABLE resident_notes ADD COLUMN chat_jid TEXT');
    } catch {}
    try {
        database.exec("ALTER TABLE resident_notes ADD COLUMN scope TEXT DEFAULT 'global'");
    } catch {}
    try {
        database.exec("UPDATE resident_notes SET scope = 'global' WHERE scope IS NULL OR scope = ''");
    } catch {}
    try {
        database.exec('ALTER TABLE house_diary ADD COLUMN chat_jid TEXT');
    } catch {}
    try {
        database.exec("ALTER TABLE house_diary ADD COLUMN scope TEXT DEFAULT 'global'");
    } catch {}
    try {
        database.exec("UPDATE house_diary SET scope = 'global' WHERE scope IS NULL OR scope = ''");
    } catch {}
    try {
        database.exec('ALTER TABLE daily_insights ADD COLUMN chat_jid TEXT');
    } catch {}
    try {
        database.exec("ALTER TABLE daily_insights ADD COLUMN scope TEXT DEFAULT 'global'");
    } catch {}
    try {
        database.exec("UPDATE daily_insights SET scope = 'global' WHERE scope IS NULL OR scope = ''");
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_notes_scope_chat ON resident_notes(scope, chat_jid)');
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_insights_scope_chat_date ON daily_insights(scope, chat_jid, date)'
        );
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_diary_scope_chat_date ON house_diary(scope, chat_jid, date)');
    } catch {}
    try {
        database.exec("ALTER TABLE tasks ADD COLUMN config_json TEXT DEFAULT '{}'");
    } catch {}
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            task TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            added_at TEXT,
            completed_at TEXT
        )`);
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_todos_space_status_added ON todos(space_id, status, added_at)');
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_shopping_list_space_purchased_added ON shopping_list(space_id, purchased, added_at)'
        );
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_messages_space_timestamp ON messages(space_id, timestamp)');
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_skill_requests_space_status ON skill_requests(space_id, status)');
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_skill_requests_pack_gap_status ON skill_requests(assistant_pack_id, capability_gap, status)'
        );
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_memory_sprints_space_status ON memory_sprints(space_id, status, opened_at DESC)'
        );
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_sprint_updated ON memory_entries(scope_type, scope_id, memory_sprint_id, updated_at DESC)'
        );
    } catch {}
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'active',
            goal TEXT DEFAULT '',
            next_step TEXT DEFAULT '',
            active_pack_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`);
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_projects_state_updated ON projects(state, updated_at DESC)');
    } catch {}
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS project_links (
            project_id TEXT NOT NULL,
            link_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, link_type, target_id)
        )`);
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_project_links_type_target_updated ON project_links(link_type, target_id, updated_at DESC)'
        );
    } catch {}
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS grounding_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        space_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`);
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_grounding_overrides_space_status_updated ON grounding_overrides(space_id, status, updated_at DESC)'
        );
    } catch {}
    // Keep this defensive CREATE TABLE in migrations for databases created
    // before tool_execution_log moved into createSchema().
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS tool_execution_log (
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
        )`);
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_tool_execution_log_space_started ON tool_execution_log(space_id, started_at DESC)'
        );
    } catch {}
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_tool_execution_log_task_started ON tool_execution_log(task_id, started_at DESC)'
        );
    } catch {}
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS tool_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT,
            task_id TEXT,
            tool_name TEXT NOT NULL,
            run_mode TEXT NOT NULL,
            audit_mode TEXT NOT NULL,
            args_json TEXT DEFAULT '{}',
            result_text TEXT,
            status TEXT NOT NULL,
            error TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            duration_ms INTEGER DEFAULT 0
        )`);
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_tool_logs_space_started ON tool_logs(space_id, started_at DESC)');
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_tool_logs_task_started ON tool_logs(task_id, started_at DESC)');
    } catch {}
    try {
        database.exec('CREATE INDEX IF NOT EXISTS idx_tool_logs_tool_started ON tool_logs(tool_name, started_at DESC)');
    } catch {}

    try {
        database.exec(`CREATE TABLE IF NOT EXISTS skill_request_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER,
            old_status TEXT,
            new_status TEXT,
            changed_by TEXT,
            note TEXT,
            changed_at TEXT
        )`);
    } catch {}

    try {
        database.exec(`CREATE TABLE IF NOT EXISTS artifacts (
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
        )`);
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_artifacts_space_kind_updated ON artifacts(space_id, kind, updated_at DESC)'
        );
        database.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_space_archived ON artifacts(space_id, archived_at)');
    } catch {}
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS timeline_events (
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
        )`);
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_timeline_events_space_day_happened ON timeline_events(space_id, day, happened_at DESC)'
        );
        database.exec(
            'CREATE INDEX IF NOT EXISTS idx_timeline_events_space_happened ON timeline_events(space_id, happened_at DESC)'
        );
    } catch {}

    // Deep cleanup of legacy pre-Open PiPi household artifacts
    try {
        dropColumnIfExists(database, 'residents', 'ip_address');
    } catch {}
    try {
        dropColumnIfExists(database, 'residents', 'mac_address');
    } catch {}
    try {
        dropColumnIfExists(database, 'residents', 'ble_mac');
    } catch {}
    try {
        dropColumnIfExists(database, 'residents', 'is_home');
    } catch {}
    try {
        dropColumnIfExists(database, 'chats', 'language');
    } catch {}

    try {
        database.exec('DROP TABLE IF EXISTS cleaning_tasks');
    } catch {}
    try {
        database.exec('DROP TABLE IF EXISTS cleaning_log');
    } catch {}
    try {
        database.exec('DROP TABLE IF EXISTS known_devices');
    } catch {}
    try {
        database.exec('DROP TABLE IF EXISTS sensor_readings');
    } catch {}
    try {
        database.exec('DROP TABLE IF EXISTS ble_devices');
    } catch {}

    database.exec(`
        INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, created_at, updated_at)
        SELECT
            'telegram:' || jid,
            CASE
                WHEN type LIKE '%group%' THEN 'group_chat'
                ELSE 'direct_chat'
            END,
            jid,
            'telegram',
            jid,
            COALESCE(status, 'ACTIVE'),
            'jeeves',
            datetime('now'),
            datetime('now')
        FROM chats
        WHERE NOT EXISTS (
            SELECT 1 FROM spaces s WHERE s.id = 'telegram:' || chats.jid
        );
    `);

    database.exec(`
        UPDATE spaces
        SET grounding_pack_id = 'jeeves_personal'
        WHERE grounding_pack_id IS NULL OR grounding_pack_id = '';
    `);

    database.exec(`
        UPDATE messages
        SET space_id = 'telegram:' || chat_jid
        WHERE space_id IS NULL AND chat_jid IS NOT NULL;
    `);

    database.exec(`
        UPDATE reminders
        SET space_id = 'telegram:' || chat_jid
        WHERE space_id IS NULL AND chat_jid IS NOT NULL;
    `);

    database.exec(`
        UPDATE todos
        SET space_id = (
            SELECT id
            FROM spaces
            ORDER BY created_at ASC, id ASC
            LIMIT 1
        )
        WHERE space_id IS NULL
          AND 1 = (SELECT COUNT(*) FROM spaces);
    `);

    backfillTransportTopology(database);
}

/**
 * Give every pre-existing space a transport binding and every pre-existing
 * resident a transport identity, so routing can stop reading `spaces.channel`
 * and person ids can stop being parsed for their transport prefix.
 *
 * Purely additive and safe to re-run: nothing is dropped, and every statement
 * is a conditional insert. Existing Telegram chats keep working without the
 * operator reconnecting anything.
 */
function backfillTransportTopology(database: Database.Database): void {
    // A legacy space stores exactly one endpoint, in `channel` + `external_ref`.
    // `spaces` already enforces UNIQUE(channel, external_ref), so this can never
    // collide with the binding endpoint index.
    database.exec(`
        INSERT INTO transport_bindings (
            id, transport, endpoint_id, endpoint_type, thread_id,
            normalized_thread_id, space_id, status, created_at, updated_at
        )
        SELECT
            -- Built from the endpoint, not the space id, so this agrees with
            -- ensureTransportBinding by construction rather than by coincidence
            -- of legacy space ids happening to be "<channel>:<external ref>".
            'binding:' || s.channel || ':' || s.external_ref,
            s.channel,
            s.external_ref,
            CASE WHEN s.kind LIKE '%group%' THEN 'group' ELSE 'direct' END,
            NULL,
            '',
            s.id,
            CASE WHEN UPPER(COALESCE(s.status, 'ACTIVE')) = 'ACTIVE' THEN 'active' ELSE 'disabled' END,
            COALESCE(s.created_at, datetime('now')),
            datetime('now')
        FROM spaces s
        WHERE COALESCE(s.channel, '') != ''
          -- An endpoint-less space cannot be routed to. Inventing a binding for
          -- it would hide that; leaving it out surfaces it in the topology
          -- report for a human to look at.
          AND COALESCE(s.external_ref, '') != ''
          AND NOT EXISTS (
              SELECT 1 FROM transport_bindings b
              WHERE b.transport = s.channel
                AND b.endpoint_id = s.external_ref
                AND b.normalized_thread_id = ''
          );
    `);

    // Person ids carry their transport by string convention: a bare id is
    // Telegram, anything else is "<transport>:<external id>". Splitting on the
    // first colon recovers the pair without guessing.
    //
    // OR IGNORE, not merge: if two residents somehow claim one external
    // account, the first keeps it and the mismatch surfaces in the topology
    // report rather than silently fusing two people.
    database.exec(`
        INSERT OR IGNORE INTO participant_identities (
            id, participant_id, transport, external_user_id,
            username, display_name, created_at, updated_at
        )
        SELECT
            'identity:' || r.tg_id,
            r.tg_id,
            CASE
                WHEN INSTR(r.tg_id, ':') > 0 THEN SUBSTR(r.tg_id, 1, INSTR(r.tg_id, ':') - 1)
                ELSE 'telegram'
            END,
            CASE
                WHEN INSTR(r.tg_id, ':') > 0 THEN SUBSTR(r.tg_id, INSTR(r.tg_id, ':') + 1)
                ELSE r.tg_id
            END,
            r.username,
            r.display_name,
            COALESCE(r.joined_at, datetime('now')),
            datetime('now')
        FROM residents r
        WHERE r.tg_id IS NOT NULL
          AND r.tg_id != ''
          AND NOT EXISTS (
              SELECT 1 FROM participant_identities pi WHERE pi.participant_id = r.tg_id
          );
    `);
}

export function initDatabase(): void {
    if (!db) {
        db = new Database(DB_PATH);
        configureDatabase(db);
        createSchema(db);
        runMigrations(db);

        const integrity = db.pragma('integrity_check(1)', { simple: true });
        if (integrity !== 'ok') {
            throw new Error(`SQLite integrity check failed: ${integrity}`);
        }
    }
}

export function getDb(): Database.Database {
    if (!db) initDatabase();
    return db!;
}

export function closeDatabase(): void {
    if (!db) return;

    try {
        db.pragma('wal_checkpoint(PASSIVE)');
        db.pragma('optimize');
    } finally {
        db.close();
        db = undefined;
    }
}

// ==========================================
// Residents
// ==========================================

export interface Resident {
    tg_id: string;
    person_id?: string;
    username: string | null;
    display_name: string | null;
    nickname: string | null;
    role: string;
    last_seen: string | null;
    joined_at: string;
    habits: string;
}

export function getResident(tg_id: string): Resident | undefined {
    return getDb().prepare('SELECT *, tg_id as person_id FROM residents WHERE tg_id = ?').get(tg_id) as
        | Resident
        | undefined;
}

/**
 * Recover the (transport, external account) pair a legacy person id encodes.
 *
 * Person ids carry their transport by string convention: a bare id is Telegram,
 * anything else is "<transport>:<external id>". This is the one place that
 * knows it, so the convention can be retired by changing a single function once
 * every person id has an identity row.
 */
export function splitLegacyPersonId(personId: string): { transport: string; externalUserId: string } {
    const separator = personId.indexOf(':');
    if (separator <= 0) return { transport: 'telegram', externalUserId: personId };

    return {
        transport: personId.slice(0, separator),
        externalUserId: personId.slice(separator + 1),
    };
}

export function upsertResident(r: Partial<Resident> & { tg_id: string }): void {
    const existing = getResident(r.tg_id);
    // Every participant keeps at least one identity from the moment it exists.
    // Leaving that to the startup backfill would make the invariant hold only
    // after a restart, and the resolver would silently miss anyone who joined
    // since boot.
    const legacy = splitLegacyPersonId(r.tg_id);
    const ensureIdentity = () => {
        if (!r.tg_id) return;
        ensureParticipantIdentity({
            participantId: r.tg_id,
            transport: legacy.transport,
            externalUserId: legacy.externalUserId,
            username: r.username ?? existing?.username ?? null,
            displayName: r.display_name ?? existing?.display_name ?? null,
        });
    };

    if (existing) {
        const toUpdate = { ...existing, ...r };
        getDb()
            .prepare(
                `
            UPDATE residents SET username = @username, display_name = @display_name, nickname = @nickname, role = @role,
            last_seen = @last_seen, habits = @habits
            WHERE tg_id = @tg_id
        `
            )
            .run(toUpdate);
    } else {
        getDb()
            .prepare(
                `
            INSERT INTO residents (tg_id, username, display_name, nickname, role, last_seen, joined_at, habits)
            VALUES (@tg_id, @username, @display_name, @nickname, @role, @last_seen, @joined_at, @habits)
        `
            )
            .run({
                tg_id: r.tg_id,
                username: r.username || null,
                display_name: r.display_name || null,
                nickname: r.nickname || null,
                role: r.role || 'owner',
                last_seen: r.last_seen || null,
                joined_at: r.joined_at || new Date().toISOString(),
                habits: r.habits || '',
            });
    }

    ensureIdentity();
}

export function updateResidentHabits(tg_id: string, habits: string): void {
    getDb().prepare('UPDATE residents SET habits = ? WHERE tg_id = ?').run(habits, tg_id);
}

export function updateResidentNickname(tg_id: string, nickname: string): void {
    getDb().prepare('UPDATE residents SET nickname = ? WHERE tg_id = ?').run(nickname, tg_id);
}

export function getAllResidents(): Resident[] {
    return getDb().prepare('SELECT *, tg_id as person_id FROM residents').all() as Resident[];
}

// ==========================================
// Chats
// ==========================================

export interface Chat {
    jid: string;
    type: string;
    status: string;
}

export interface Space {
    id: string;
    kind: string;
    /** Human-facing identity for web routes; null for spaces that never got one. */
    slug: string | null;
    title: string | null;
    channel: string;
    external_ref: string;
    status: string;
    assistant_pack_id: string;
    grounding_pack_id: string;
    policy_json: string | null;
    created_at: string;
    updated_at: string;
}

export interface Membership {
    space_id: string;
    person_id: string;
    role: string;
    base_authority: number;
    reputation_delta: number;
    trust_flags_json: string;
    authority_note: string | null;
    created_at: string;
    updated_at: string;
}

export const PROJECT_STATES = ['active', 'paused', 'someday', 'done'] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const PROJECT_LINK_TYPES = ['space', 'task', 'artifact'] as const;
export type ProjectLinkType = (typeof PROJECT_LINK_TYPES)[number];

export interface Project {
    id: string;
    slug: string;
    title: string;
    state: ProjectState;
    goal: string;
    next_step: string;
    active_pack_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface ProjectLink {
    project_id: string;
    link_type: ProjectLinkType;
    target_id: string;
    created_at: string;
    updated_at: string;
}

export interface ProjectSnapshot extends Project {
    linked_spaces: string[];
    linked_tasks: string[];
    linked_artifacts: string[];
}

export interface SpaceParticipant extends Resident {
    space_id: string;
    membership_role: string;
    base_authority: number;
    reputation_delta: number;
    effective_authority: number;
    authority_note: string | null;
    trust_flags: TrustFlags;
}

export interface Task {
    id: string;
    space_id: string;
    title: string;
    kind: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    config_json: string | null;
    status: string;
    created_by: string | null;
    last_run_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface TaskRun {
    id?: number;
    task_id: string;
    started_at: string;
    finished_at: string;
    status: string;
    result: string | null;
    error: string | null;
    duration_ms: number;
}

export interface ToolExecutionLog {
    id?: number;
    space_id: string | null;
    task_id: string | null;
    tool_name: string;
    run_mode: string;
    audit_mode: string;
    capabilities_json: string;
    args_json: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    duration_ms: number;
    result_preview: string | null;
    error: string | null;
    sandbox_backend: string | null;
    sandbox_image: string | null;
    sandbox_container_id: string | null;
    workspace_root: string | null;
    network_targets_json: string;
    files_read_json: string;
    files_written_json: string;
    artifacts_json: string;
}

export interface ToolLog {
    id?: number;
    space_id: string | null;
    task_id: string | null;
    tool_name: string;
    run_mode: string;
    audit_mode: string;
    args_json: string;
    result_text: string | null;
    status: string;
    error: string | null;
    started_at: string;
    finished_at: string;
    duration_ms: number;
}

export interface ToolLogQuery {
    space_id?: string;
    task_id?: string;
    tool_name?: string;
    status?: string;
    q?: string;
    started_after?: string;
    started_before?: string;
    limit?: number;
    offset?: number;
}

export interface ToolLogSummary {
    total: number;
    by_status: Record<string, number>;
    by_tool: Array<{ tool_name: string; count: number }>;
}

export interface MemoryEntry {
    id?: number;
    scope_type: string;
    scope_id: string;
    memory_sprint_id?: string | null;
    kind: string;
    content: string;
    salience: number;
    source: string;
    /** When set, this person-scoped memory is only surfaced in the given space. */
    space_bound_id?: string | null;
    created_at: string;
    updated_at: string;
}

export interface MemorySprint {
    id: string;
    space_id: string;
    opened_at: string;
    closes_at: string;
    status: string;
    cadence_days: number;
    summary: string | null;
    created_at: string;
    updated_at: string;
}

export type { GroundingOverride, GroundingOverrideKind } from './core/grounding-types';

export interface SkillRequest {
    id?: number;
    space_id?: string | null;
    assistant_pack_id?: string | null;
    capability_gap?: string | null;
    skill_name: string;
    description: string;
    requested_by: string;
    user_request: string;
    status: string;
    created_at: string;
    resolved_at?: string | null;
    votes?: number;
    voters?: string;
    hardware_needed?: string;
    priority?: string;
    implementation_ticket?: string;
    implementation_ticket_status?: string;
    implementation_ticket_created_at?: string | null;
    implementation_ticket_updated_at?: string | null;
    implementation_ticket_created_by?: string;
}

export function buildSpaceId(channel: string, externalRef: string): string {
    return `${channel}:${externalRef}`;
}

export function buildTelegramSpaceId(chatJid: string): string {
    return buildSpaceId('telegram', chatJid);
}

function spaceKindFromChatType(chatType: string | null | undefined): string {
    return chatType && chatType.includes('group') ? 'group_chat' : 'direct_chat';
}

function nowIso(): string {
    return new Date().toISOString();
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function normalizeSpacePolicyJson(
    raw: string | null | undefined,
    options?: { defaultOnboardingState?: SpaceOnboardingState }
): string {
    return JSON.stringify(mergeSpaceOperationalPolicy(raw, {}, options));
}

function resolveTrustFlags(raw: string | null | undefined, role: string): TrustFlags {
    const fallback = { ...authorityPresetForRole(role).trust_flags };
    if (!raw) return fallback;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return fallback;
        }

        return {
            ...fallback,
            ...(parsed as Partial<TrustFlags>),
        };
    } catch {
        return fallback;
    }
}

function stringifyTrustFlags(trustFlags: TrustFlags): string {
    return JSON.stringify(trustFlags);
}

function clampLimit(value: number | undefined, fallback: number, min: number, max: number): number {
    return Math.min(Math.max(value || fallback, min), max);
}

type SqlFilterValue = string | number;
type SqlFilter = {
    condition: string;
    enabled?: boolean;
    value?: SqlFilterValue | null | undefined;
};

const MESSAGE_SPACE_SQL = `COALESCE(m.space_id, 'telegram:' || m.chat_jid)`;
const RECENT_MESSAGES_WINDOW_DAYS = 7;

function buildSqlFilters(filters: SqlFilter[]): { where: string; values: SqlFilterValue[] } {
    const activeFilters = filters.filter(
        (filter) => filter.enabled === true || (filter.value !== undefined && filter.value !== null)
    );

    return {
        where: activeFilters.length > 0 ? `WHERE ${activeFilters.map((filter) => filter.condition).join(' AND ')}` : '',
        values: activeFilters
            .filter((filter) => filter.value !== undefined && filter.value !== null)
            .map((filter) => filter.value as SqlFilterValue),
    };
}

function normalizeSearchTerm(query: string): string {
    return query.trim().toLowerCase();
}

function slugifyProjectTitle(value: string): string {
    return (
        value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 48) || 'project'
    );
}

function isProjectState(value: string | null | undefined): value is ProjectState {
    return typeof value === 'string' && (PROJECT_STATES as readonly string[]).includes(value);
}

function normalizeProjectState(value: string | null | undefined, fallback: ProjectState = 'active'): ProjectState {
    return isProjectState(value) ? value : fallback;
}

function isProjectLinkType(value: string | null | undefined): value is ProjectLinkType {
    return typeof value === 'string' && (PROJECT_LINK_TYPES as readonly string[]).includes(value);
}

function recentTimestampCutoff(days: number = RECENT_MESSAGES_WINDOW_DAYS): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function retentionCutoff(daysToKeep: number): string {
    return recentTimestampCutoff(Math.max(daysToKeep, 1));
}

export function getSpace(id: string): Space | undefined {
    return getDb().prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined;
}

function allocateUniqueProjectSlug(title: string): string {
    const baseSlug = slugifyProjectTitle(title);
    let candidate = baseSlug;
    let suffix = 2;

    while (getDb().prepare('SELECT 1 FROM projects WHERE slug = ? LIMIT 1').get(candidate)) {
        candidate = `${baseSlug}-${suffix}`;
        suffix += 1;
    }

    return candidate;
}

function getProjectLinkArrays(
    projectId: string
): Pick<ProjectSnapshot, 'linked_spaces' | 'linked_tasks' | 'linked_artifacts'> {
    const links = getDb()
        .prepare(
            `
        SELECT * FROM project_links
        WHERE project_id = ?
        ORDER BY updated_at DESC, target_id ASC
    `
        )
        .all(projectId) as ProjectLink[];

    return {
        linked_spaces: links.filter((link) => link.link_type === 'space').map((link) => link.target_id),
        linked_tasks: links.filter((link) => link.link_type === 'task').map((link) => link.target_id),
        linked_artifacts: links.filter((link) => link.link_type === 'artifact').map((link) => link.target_id),
    };
}

function toProjectSnapshot(project: Project | undefined): ProjectSnapshot | undefined {
    if (!project) return undefined;

    return {
        ...project,
        ...getProjectLinkArrays(project.id),
    };
}

export function getProject(id: string): Project | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM projects WHERE id = ?
    `
        )
        .get(id) as Project | undefined;
}

export function getProjectSnapshot(id: string): ProjectSnapshot | undefined {
    return toProjectSnapshot(getProject(id));
}

export function resolveProjectSelector(selector: string): ProjectSnapshot | undefined {
    const trimmed = selector.trim();
    if (!trimmed) return undefined;

    const normalized = trimmed.toLowerCase();
    const project = getDb()
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
        .get(trimmed, normalized, normalized, trimmed, normalized) as Project | undefined;

    return toProjectSnapshot(project);
}

export function listProjects(state?: ProjectState): ProjectSnapshot[] {
    const normalizedState = state ? normalizeProjectState(state, state) : undefined;
    const projects = normalizedState
        ? (getDb()
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
              .all(normalizedState) as Project[])
        : (getDb()
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
              .all() as Project[]);

    return projects
        .map((project) => toProjectSnapshot(project))
        .filter((project): project is ProjectSnapshot => Boolean(project));
}

export function createProject(args: {
    title: string;
    state?: ProjectState;
    goal?: string;
    next_step?: string;
    active_pack_id?: string | null;
}): ProjectSnapshot {
    const title = args.title.trim();
    if (!title) {
        throw new Error('Project title cannot be empty.');
    }

    const slug = allocateUniqueProjectSlug(title);
    const id = `project:${slug}`;
    const now = nowIso();
    getDb()
        .prepare(
            `
        INSERT INTO projects (
            id, slug, title, state, goal, next_step, active_pack_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
        )
        .run(
            id,
            slug,
            title,
            normalizeProjectState(args.state),
            args.goal?.trim() || '',
            args.next_step?.trim() || '',
            args.active_pack_id?.trim() || null,
            now,
            now
        );

    return getProjectSnapshot(id)!;
}

export function updateProject(
    projectId: string,
    patch: {
        title?: string;
        state?: ProjectState;
        goal?: string;
        next_step?: string;
        active_pack_id?: string | null;
    }
): ProjectSnapshot | undefined {
    const existing = getProject(projectId);
    if (!existing) return undefined;

    getDb()
        .prepare(
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
        )
        .run(
            patch.title?.trim() || existing.title,
            normalizeProjectState(patch.state, existing.state),
            patch.goal !== undefined ? patch.goal.trim() : existing.goal,
            patch.next_step !== undefined ? patch.next_step.trim() : existing.next_step,
            patch.active_pack_id !== undefined ? patch.active_pack_id?.trim() || null : existing.active_pack_id,
            nowIso(),
            projectId
        );

    return getProjectSnapshot(projectId);
}

export function getProjectLinks(projectId: string, linkType?: ProjectLinkType): ProjectLink[] {
    if (linkType) {
        return getDb()
            .prepare(
                `
            SELECT * FROM project_links
            WHERE project_id = ? AND link_type = ?
            ORDER BY updated_at DESC, target_id ASC
        `
            )
            .all(projectId, linkType) as ProjectLink[];
    }

    return getDb()
        .prepare(
            `
        SELECT * FROM project_links
        WHERE project_id = ?
        ORDER BY updated_at DESC, target_id ASC
    `
        )
        .all(projectId) as ProjectLink[];
}

export function linkProjectTarget(
    projectId: string,
    linkType: ProjectLinkType,
    targetId: string
): ProjectLink | undefined {
    const normalizedTargetId = targetId.trim();
    if (!normalizedTargetId || !getProject(projectId) || !isProjectLinkType(linkType)) {
        return undefined;
    }

    const now = nowIso();
    getDb()
        .prepare(
            `
        INSERT INTO project_links (
            project_id, link_type, target_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, link_type, target_id) DO UPDATE SET
            updated_at = excluded.updated_at
    `
        )
        .run(projectId, linkType, normalizedTargetId, now, now);

    return getDb()
        .prepare(
            `
        SELECT * FROM project_links
        WHERE project_id = ? AND link_type = ? AND target_id = ?
    `
        )
        .get(projectId, linkType, normalizedTargetId) as ProjectLink | undefined;
}

export function unlinkProjectTarget(projectId: string, linkType: ProjectLinkType, targetId: string): number {
    const normalizedTargetId = targetId.trim();
    if (!normalizedTargetId || !isProjectLinkType(linkType)) {
        return 0;
    }

    const result = getDb()
        .prepare(
            `
        DELETE FROM project_links
        WHERE project_id = ? AND link_type = ? AND target_id = ?
    `
        )
        .run(projectId, linkType, normalizedTargetId);

    return result.changes;
}

export function getActiveProjectIdForSpace(spaceId: string): string | null {
    const space = getSpace(spaceId);
    if (!space) return null;

    const raw = parseJsonRecord(space.policy_json);
    const projectId = typeof raw.active_project_id === 'string' ? raw.active_project_id.trim() : '';
    return projectId || null;
}

export function getActiveProjectForSpace(spaceId: string): ProjectSnapshot | undefined {
    const projectId = getActiveProjectIdForSpace(spaceId);
    return projectId ? getProjectSnapshot(projectId) : undefined;
}

export function setSpaceActiveProject(spaceId: string, projectId: string | null): void {
    if (projectId) {
        linkProjectTarget(projectId, 'space', spaceId);
    }

    updateSpacePolicy(spaceId, { active_project_id: projectId || null });
}

export function listSpaces(status?: string): Space[] {
    if (status) {
        return getDb()
            .prepare(
                `
            SELECT * FROM spaces WHERE status = ? ORDER BY created_at ASC
        `
            )
            .all(status) as Space[];
    }

    return getDb()
        .prepare(
            `
        SELECT * FROM spaces ORDER BY created_at ASC
    `
        )
        .all() as Space[];
}

export interface SpaceSummary extends Space {
    last_message_at: string | null;
    last_message_preview: string | null;
}

/**
 * The spaces one participant belongs to, most recently active first.
 *
 * Membership is the whole access rule for the Web client: a person sees the
 * conversations they are part of and nothing else, which is the same rule that
 * already governs every other surface.
 */
export function listSpacesForParticipant(participantId: string, limit: number = 100): SpaceSummary[] {
    return getDb()
        .prepare(
            `
        SELECT
            s.*,
            (SELECT MAX(m.timestamp) FROM messages m WHERE m.space_id = s.id) AS last_message_at,
            (SELECT m.content FROM messages m WHERE m.space_id = s.id
             ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 1) AS last_message_preview
        FROM spaces s
        JOIN memberships mem ON mem.space_id = s.id
        WHERE mem.person_id = ?
          AND s.status = 'ACTIVE'
        ORDER BY COALESCE(last_message_at, s.created_at) DESC, s.id ASC
        LIMIT ?
    `
        )
        .all(participantId, clampLimit(limit, 100, 1, 500)) as SpaceSummary[];
}

export function isSpaceMember(spaceId: string, participantId: string): boolean {
    return Boolean(getMembership(spaceId, participantId));
}

export function getSpaceByChannelRef(channel: string, externalRef: string): Space | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM spaces WHERE channel = ? AND external_ref = ? LIMIT 1
    `
        )
        .get(channel, externalRef) as Space | undefined;
}

export function updateSpaceAssistantPack(spaceId: string, assistantPackId: string): void {
    const existing = getSpace(spaceId);
    if (!existing) return;

    upsertSpace({
        ...existing,
        assistant_pack_id: assistantPackId,
    });
}

export function updateSpaceGroundingPack(spaceId: string, groundingPackId: string): void {
    const existing = getSpace(spaceId);
    if (!existing) return;

    upsertSpace({
        ...existing,
        grounding_pack_id: groundingPackId,
    });
}

/**
 * Archive a space, or bring it back.
 *
 * Archiving hides it: the Web client lists only `ACTIVE` spaces, and so do the
 * background passes that sweep every space looking for work. Nothing is
 * deleted — history, memory and bindings all stay where they are.
 */
export function updateSpaceStatus(spaceId: string, status: 'ACTIVE' | 'ARCHIVED'): void {
    const existing = getSpace(spaceId);
    if (!existing) return;

    upsertSpace({ ...existing, status });
}

export function updateSpacePolicy(spaceId: string, patch: Record<string, unknown>): void {
    const existing = getSpace(spaceId);
    if (!existing) return;

    upsertSpace({
        ...existing,
        policy_json: JSON.stringify(
            mergeSpaceOperationalPolicy(existing.policy_json, patch, { defaultOnboardingState: 'active' })
        ),
    });
}

export function upsertSpace(
    space: Partial<Space> & {
        id: string;
        kind: string;
        channel: string;
        external_ref: string;
    }
): void {
    const existing = getSpace(space.id);
    const now = nowIso();
    const defaultOnboardingState: SpaceOnboardingState = existing ? 'active' : 'new';
    getDb()
        .prepare(
            `
        INSERT INTO spaces (id, kind, title, channel, external_ref, status, assistant_pack_id, grounding_pack_id, policy_json, created_at, updated_at)
        VALUES (@id, @kind, @title, @channel, @external_ref, @status, @assistant_pack_id, @grounding_pack_id, @policy_json, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
            kind = @kind,
            title = @title,
            channel = @channel,
            external_ref = @external_ref,
            status = @status,
            assistant_pack_id = @assistant_pack_id,
            grounding_pack_id = @grounding_pack_id,
            policy_json = @policy_json,
            updated_at = @updated_at
    `
        )
        .run({
            id: space.id,
            kind: space.kind,
            title: space.title ?? existing?.title ?? null,
            channel: space.channel,
            external_ref: space.external_ref,
            status: space.status || existing?.status || 'ACTIVE',
            assistant_pack_id: space.assistant_pack_id || existing?.assistant_pack_id || getDefaultPackId(),
            grounding_pack_id: space.grounding_pack_id || existing?.grounding_pack_id || getDefaultGroundingId(),
            policy_json: normalizeSpacePolicyJson(space.policy_json || existing?.policy_json, {
                defaultOnboardingState,
            }),
            created_at: space.created_at || existing?.created_at || now,
            updated_at: now,
        });
}

function getDefaultPackId(): string {
    return process.env.BOOTSTRAP_PACK || 'jeeves';
}

function getDefaultGroundingId(): string {
    return process.env.BOOTSTRAP_GROUNDING || 'jeeves_personal';
}

export function ensureSpace(
    channel: string,
    externalRef: string,
    options?: {
        kind?: string;
        title?: string | null;
        status?: string;
        assistant_pack_id?: string;
        grounding_pack_id?: string;
        policy_json?: string;
    }
): Space {
    const id = buildSpaceId(channel, externalRef);
    upsertSpace({
        id,
        kind: options?.kind || 'direct_chat',
        title: options?.title || externalRef,
        channel,
        external_ref: externalRef,
        status: options?.status || 'ACTIVE',
        // Leave pack/grounding undefined unless explicitly requested:
        // upsertSpace falls back to the existing row first, so re-ensuring
        // a space (e.g. on every incoming message) must not reset a
        // previously switched pack back to the default.
        assistant_pack_id: options?.assistant_pack_id,
        grounding_pack_id: options?.grounding_pack_id,
        policy_json: options?.policy_json,
    });

    // Every space keeps a binding from the moment it exists. Leaving this to the
    // startup backfill would make the invariant hold only after a restart, and
    // a space created today would route through the legacy columns until then.
    // ensureTransportBinding returns early when the endpoint is already bound,
    // so this stays a single indexed read on the inbound path.
    ensureTransportBinding({
        transport: channel,
        endpointId: externalRef,
        endpointType: (options?.kind || 'direct_chat') === 'direct_chat' ? 'direct' : 'group',
        spaceId: id,
    });

    return getSpace(id)!;
}

export function ensureTelegramSpace(chatJid: string, chatType: string = 'private', title?: string | null): Space {
    return ensureSpace('telegram', chatJid, {
        kind: spaceKindFromChatType(chatType),
        title: title || chatJid,
        status: 'ACTIVE',
    });
}

// ==========================================
// Transport bindings and participant identities
// ==========================================

export interface TransportBinding {
    id: string;
    transport: string;
    endpoint_id: string;
    endpoint_type: string;
    thread_id: string | null;
    normalized_thread_id: string;
    space_id: string;
    status: string;
    created_at: string;
    updated_at: string;
}

export interface ParticipantIdentity {
    id: string;
    participant_id: string;
    transport: string;
    external_user_id: string;
    username: string | null;
    display_name: string | null;
    verified_at: string | null;
    created_at: string;
    updated_at: string;
}

/** Empty string, not NULL — see the note on the endpoint unique index. */
export function normalizeBindingThreadId(threadId?: string | null): string {
    return threadId ? String(threadId) : '';
}

export function getTransportBinding(
    transport: string,
    endpointId: string,
    threadId?: string | null
): TransportBinding | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM transport_bindings
        WHERE transport = ? AND endpoint_id = ? AND normalized_thread_id = ?
        LIMIT 1
    `
        )
        .get(transport, endpointId, normalizeBindingThreadId(threadId)) as TransportBinding | undefined;
}

export function listTransportBindingsForSpace(
    spaceId: string,
    options?: { includeDisabled?: boolean }
): TransportBinding[] {
    const where = options?.includeDisabled ? 'space_id = ?' : "space_id = ? AND status = 'active'";

    return getDb()
        .prepare(`SELECT * FROM transport_bindings WHERE ${where} ORDER BY created_at ASC, id ASC`)
        .all(spaceId) as TransportBinding[];
}

/**
 * Bind an endpoint to a space, or return the binding that already owns it.
 *
 * An endpoint belongs to one space. Re-binding it elsewhere is a deliberate
 * move rather than a side effect of a message arriving, so this never steals an
 * endpoint from another space — callers that mean to re-point one say so.
 */
export function ensureTransportBinding(input: {
    transport: string;
    endpointId: string;
    endpointType: string;
    threadId?: string | null;
    spaceId: string;
}): TransportBinding {
    const existing = getTransportBinding(input.transport, input.endpointId, input.threadId);
    if (existing) return existing;

    const normalizedThreadId = normalizeBindingThreadId(input.threadId);
    const now = nowIso();
    const id = `binding:${input.transport}:${input.endpointId}${normalizedThreadId ? `:${normalizedThreadId}` : ''}`;

    getDb()
        .prepare(
            `
        INSERT INTO transport_bindings (
            id, transport, endpoint_id, endpoint_type, thread_id,
            normalized_thread_id, space_id, status, created_at, updated_at
        )
        VALUES (@id, @transport, @endpoint_id, @endpoint_type, @thread_id,
                @normalized_thread_id, @space_id, 'active', @created_at, @updated_at)
    `
        )
        .run({
            id,
            transport: input.transport,
            endpoint_id: input.endpointId,
            endpoint_type: input.endpointType,
            thread_id: input.threadId ?? null,
            normalized_thread_id: normalizedThreadId,
            space_id: input.spaceId,
            created_at: now,
            updated_at: now,
        });

    return getTransportBinding(input.transport, input.endpointId, input.threadId)!;
}

/**
 * Point an external account at a participant, moving it if it was pointed
 * elsewhere.
 *
 * Unlike ensureParticipantIdentity this *does* reassign, because it exists for
 * the deliberate operator action of linking an account. A login must never do
 * this — that is how one person silently becomes another.
 */
export function linkParticipantIdentity(input: {
    participantId: string;
    transport: string;
    externalUserId: string;
    displayName?: string | null;
}): ParticipantIdentity {
    getDb()
        .prepare('DELETE FROM participant_identities WHERE transport = ? AND external_user_id = ?')
        .run(input.transport, input.externalUserId);

    return ensureParticipantIdentity({
        participantId: input.participantId,
        transport: input.transport,
        externalUserId: input.externalUserId,
        displayName: input.displayName ?? null,
    });
}

export function getParticipantIdentity(transport: string, externalUserId: string): ParticipantIdentity | undefined {
    return getDb()
        .prepare('SELECT * FROM participant_identities WHERE transport = ? AND external_user_id = ? LIMIT 1')
        .get(transport, externalUserId) as ParticipantIdentity | undefined;
}

export function listParticipantIdentities(participantId: string): ParticipantIdentity[] {
    return getDb()
        .prepare('SELECT * FROM participant_identities WHERE participant_id = ? ORDER BY created_at ASC, id ASC')
        .all(participantId) as ParticipantIdentity[];
}

/**
 * Attach an external account to a participant, refreshing the display fields.
 *
 * An external account already claimed by someone else is left alone: merging
 * two people is a decision a human makes, never a side effect of a login.
 */
export function ensureParticipantIdentity(input: {
    participantId: string;
    transport: string;
    externalUserId: string;
    username?: string | null;
    displayName?: string | null;
}): ParticipantIdentity {
    const existing = getParticipantIdentity(input.transport, input.externalUserId);
    const now = nowIso();

    if (existing) {
        if (existing.participant_id !== input.participantId) return existing;

        // upsertResident sits on a hot path — every command resolves a sender —
        // so an unconditional UPDATE here would write to disk on each one and
        // churn updated_at for nothing. Only write when something actually moved.
        const nextUsername = input.username ?? existing.username;
        const nextDisplayName = input.displayName ?? existing.display_name;
        if (nextUsername === existing.username && nextDisplayName === existing.display_name) {
            return existing;
        }

        getDb()
            .prepare(
                `
            UPDATE participant_identities
            SET username = @username, display_name = @display_name, updated_at = @updated_at
            WHERE id = @id
        `
            )
            .run({
                id: existing.id,
                username: nextUsername,
                display_name: nextDisplayName,
                updated_at: now,
            });

        return getParticipantIdentity(input.transport, input.externalUserId)!;
    }

    getDb()
        .prepare(
            `
        INSERT INTO participant_identities (
            id, participant_id, transport, external_user_id,
            username, display_name, created_at, updated_at
        )
        VALUES (@id, @participant_id, @transport, @external_user_id,
                @username, @display_name, @created_at, @updated_at)
    `
        )
        .run({
            id: `identity:${input.transport}:${input.externalUserId}`,
            participant_id: input.participantId,
            transport: input.transport,
            external_user_id: input.externalUserId,
            username: input.username ?? null,
            display_name: input.displayName ?? null,
            created_at: now,
            updated_at: now,
        });

    return getParticipantIdentity(input.transport, input.externalUserId)!;
}

export interface TransportTopologyReport {
    spaces: number;
    bindings: number;
    /** Spaces with no binding at all — these would fall back to legacy routing. */
    spaces_without_binding: string[];
    participants: number;
    identities: number;
    /** Participants whose external account was already claimed by someone else. */
    participants_without_identity: string[];
}

/**
 * Describe what the topology backfill produced, so an operator can see whether
 * anything needs a human decision instead of discovering it during a rollout.
 */
export function getTransportTopologyReport(): TransportTopologyReport {
    const database = getDb();
    const countOf = (table: string): number =>
        (database.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;

    const spacesWithoutBinding = database
        .prepare(
            `
        SELECT s.id FROM spaces s
        WHERE NOT EXISTS (SELECT 1 FROM transport_bindings b WHERE b.space_id = s.id)
        ORDER BY s.id
    `
        )
        .all() as Array<{ id: string }>;

    const participantsWithoutIdentity = database
        .prepare(
            `
        SELECT r.tg_id FROM residents r
        WHERE NOT EXISTS (SELECT 1 FROM participant_identities pi WHERE pi.participant_id = r.tg_id)
        ORDER BY r.tg_id
    `
        )
        .all() as Array<{ tg_id: string }>;

    return {
        spaces: countOf('spaces'),
        bindings: countOf('transport_bindings'),
        spaces_without_binding: spacesWithoutBinding.map((row) => row.id),
        participants: countOf('residents'),
        identities: countOf('participant_identities'),
        participants_without_identity: participantsWithoutIdentity.map((row) => row.tg_id),
    };
}

export function listGroundingOverrides(
    spaceId: string,
    options?: { includeInactive?: boolean; limit?: number }
): GroundingOverride[] {
    const limit = clampLimit(options?.limit, 24, 1, 100);
    const where = options?.includeInactive ? 'space_id = ?' : "space_id = ? AND status = 'active'";

    return getDb()
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
        .all(spaceId, limit) as GroundingOverride[];
}

export function getSpaceGroundingLevel(spaceId: string): 0 | 1 | 2 | 3 {
    const overrides = listGroundingOverrides(spaceId);
    if (overrides.length === 0) return 0;
    const kinds = new Set(overrides.map((o) => o.kind));
    if (kinds.size >= 3) return 3;
    if (kinds.has('rule') || kinds.has('org')) return 2;
    return 1;
}

export function getGroundingOverride(id: number): GroundingOverride | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM grounding_overrides WHERE id = ?
    `
        )
        .get(id) as GroundingOverride | undefined;
}

export function upsertGroundingOverride(args: {
    space_id: string;
    kind: GroundingOverrideKind;
    subject: string;
    content: string;
    created_by?: string | null;
}): GroundingOverride {
    const now = nowIso();
    const normalizedSubject = args.subject.trim();
    const normalizedContent = args.content.trim();
    const existing = getDb()
        .prepare(
            `
        SELECT * FROM grounding_overrides
        WHERE space_id = ? AND kind = ? AND subject = ? AND status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
    `
        )
        .get(args.space_id, args.kind, normalizedSubject) as GroundingOverride | undefined;

    if (existing) {
        getDb()
            .prepare(
                `
            UPDATE grounding_overrides
            SET content = ?, created_by = COALESCE(?, created_by), updated_at = ?
            WHERE id = ?
        `
            )
            .run(normalizedContent, args.created_by || null, now, existing.id);
        return getGroundingOverride(existing.id)!;
    }

    const result = getDb()
        .prepare(
            `
        INSERT INTO grounding_overrides (
            space_id, kind, subject, content, status, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `
        )
        .run(args.space_id, args.kind, normalizedSubject, normalizedContent, args.created_by || null, now, now);

    return getGroundingOverride(Number(result.lastInsertRowid))!;
}

export function disableGroundingOverride(id: number): GroundingOverride | undefined {
    const existing = getGroundingOverride(id);
    if (!existing) return undefined;

    getDb()
        .prepare(
            `
        UPDATE grounding_overrides
        SET status = 'inactive', updated_at = ?
        WHERE id = ?
    `
        )
        .run(nowIso(), id);

    return getGroundingOverride(id);
}

export function getMembership(spaceId: string, personId: string): Membership | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM memberships WHERE space_id = ? AND person_id = ?
    `
        )
        .get(spaceId, personId) as Membership | undefined;
}

function buildMembershipRecord(
    membership: Partial<Membership> & { space_id: string; person_id: string; role: string }
): Membership {
    const preset = authorityPresetForRole(membership.role);
    const now = nowIso();

    return {
        space_id: membership.space_id,
        person_id: membership.person_id,
        role: membership.role,
        base_authority: membership.base_authority ?? preset.base_authority,
        reputation_delta: membership.reputation_delta ?? preset.reputation_delta,
        trust_flags_json: stringifyTrustFlags(resolveTrustFlags(membership.trust_flags_json, membership.role)),
        authority_note: membership.authority_note ?? preset.authority_note,
        created_at: membership.created_at || now,
        updated_at: now,
    };
}

function mutateMembership(
    spaceId: string,
    personId: string,
    mutate: (existing: Membership) => Partial<Membership> & { role?: string }
): Membership | undefined {
    const existing = getMembership(spaceId, personId);
    if (!existing) return undefined;

    const patch = mutate(existing);
    upsertMembership({
        ...existing,
        ...patch,
        space_id: spaceId,
        person_id: personId,
        role: patch.role ?? existing.role,
        created_at: existing.created_at,
    });
    return getMembership(spaceId, personId);
}

export function upsertMembership(
    membership: Partial<Membership> & { space_id: string; person_id: string; role: string }
): void {
    getDb()
        .prepare(
            `
        INSERT INTO memberships (
            space_id, person_id, role, base_authority, reputation_delta,
            trust_flags_json, authority_note, created_at, updated_at
        )
        VALUES (
            @space_id, @person_id, @role, @base_authority, @reputation_delta,
            @trust_flags_json, @authority_note, @created_at, @updated_at
        )
        ON CONFLICT(space_id, person_id) DO UPDATE SET
            role = @role,
            base_authority = @base_authority,
            reputation_delta = @reputation_delta,
            trust_flags_json = @trust_flags_json,
            authority_note = @authority_note,
            updated_at = @updated_at
    `
        )
        .run(buildMembershipRecord(membership));
}

export function ensureSpaceMembership(spaceId: string, personId: string, role: string = 'member'): Membership {
    const existing = getMembership(spaceId, personId);
    if (!existing) {
        upsertMembership({ space_id: spaceId, person_id: personId, role });
    }
    return getMembership(spaceId, personId)!;
}

export function updateMembershipRole(spaceId: string, personId: string, role: string): Membership | undefined {
    const preset = authorityPresetForRole(role);
    return mutateMembership(spaceId, personId, (existing) => ({
        role,
        base_authority: preset.base_authority,
        reputation_delta: existing.reputation_delta,
        trust_flags_json: stringifyTrustFlags(preset.trust_flags),
        authority_note: preset.authority_note,
    }));
}

export function updateMembershipReputation(
    spaceId: string,
    personId: string,
    reputationDelta: number
): Membership | undefined {
    return mutateMembership(spaceId, personId, (existing) => ({
        reputation_delta: reputationDelta,
        trust_flags_json: existing.trust_flags_json,
        authority_note: existing.authority_note || '',
    }));
}

export function updateMembershipTrustFlag(
    spaceId: string,
    personId: string,
    flag: TrustFlag,
    enabled: boolean
): Membership | undefined {
    return mutateMembership(spaceId, personId, (existing) => {
        const currentFlags = resolveTrustFlags(existing.trust_flags_json, existing.role);
        currentFlags[flag] = enabled;

        return {
            trust_flags_json: stringifyTrustFlags(currentFlags),
            authority_note: existing.authority_note || '',
        };
    });
}

export function getSpaceParticipants(spaceId: string): SpaceParticipant[] {
    const rows = getDb()
        .prepare(
            `
        SELECT
            r.tg_id,
            r.username,
            r.display_name,
            r.nickname,
            r.role,
            r.last_seen,
            r.joined_at,
            r.habits,
            m.space_id,
            m.role as membership_role,
            m.base_authority,
            m.reputation_delta,
            m.trust_flags_json,
            m.authority_note
        FROM memberships m
        JOIN residents r ON r.tg_id = m.person_id
        WHERE m.space_id = ?
        ORDER BY (m.base_authority + m.reputation_delta) DESC, COALESCE(r.nickname, r.display_name, r.username, r.tg_id) ASC
    `
        )
        .all(spaceId) as Array<Membership & Resident>;

    return rows.map((row) => {
        const membershipRole = (row as any).membership_role as string;

        return {
            tg_id: row.tg_id,
            person_id: row.tg_id,
            username: row.username,
            display_name: row.display_name,
            nickname: row.nickname,
            role: row.role,
            last_seen: row.last_seen,
            joined_at: row.joined_at,
            habits: row.habits,
            space_id: row.space_id,
            membership_role: (row as any).membership_role,
            base_authority: row.base_authority,
            reputation_delta: row.reputation_delta,
            effective_authority: effectiveAuthority(row),
            authority_note: row.authority_note,
            trust_flags: resolveTrustFlags(row.trust_flags_json, membershipRole),
        };
    });
}

export function memberHasTrustFlag(spaceId: string, personId: string, flag: TrustFlag): boolean {
    const membership = getMembership(spaceId, personId);
    if (!membership) return false;
    return hasTrustFlag({ trust_flags: resolveTrustFlags(membership.trust_flags_json, membership.role) }, flag);
}

export function getMemberEffectiveAuthority(spaceId: string, personId: string): number | null {
    const membership = getMembership(spaceId, personId);
    if (!membership) return null;
    return effectiveAuthority(membership);
}

function normalizeCapabilityGap(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized || 'unknown_capability_gap';
}

export function listSkillRequests(options?: {
    spaceId?: string | null;
    assistantPackId?: string | null;
    includeResolved?: boolean;
}): SkillRequest[] {
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return getDb()
        .prepare(
            `
        SELECT * FROM skill_requests
        ${whereClause}
        ORDER BY
            CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
            votes DESC,
            created_at DESC
    `
        )
        .all(...values) as SkillRequest[];
}

export function getSkillRequest(id: number): SkillRequest | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM skill_requests WHERE id = ?
    `
        )
        .get(id) as SkillRequest | undefined;
}

export function createCapabilityGapRequest(args: {
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
}): { request: SkillRequest; deduped: boolean; votes: number } {
    const db = getDb();
    const normalizedGap = normalizeCapabilityGap(args.capability_gap);
    const skillName = normalizeCapabilityGap(args.skill_name || normalizedGap);
    const requestedBy = args.requested_by || 'unknown';
    const userTitle = args.user_title?.trim();
    const hardwareNeeded = args.hardware_needed?.trim() || '';
    const description = [userTitle ? `[${userTitle}] ` : '', args.description.trim()].join('');
    const priority = args.priority || (hardwareNeeded ? 'low' : 'normal');

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
        .get(args.space_id || null, args.assistant_pack_id || null, normalizedGap) as SkillRequest | undefined;

    if (existing) {
        const voters = existing.voters ? existing.voters.split(',').filter(Boolean) : [];
        if (!voters.includes(requestedBy)) {
            voters.push(requestedBy);
        }
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

        const updated = db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(existing.id) as SkillRequest;
        return { request: updated, deduped: true, votes };
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

    const request = db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(result.lastInsertRowid) as SkillRequest;
    return { request, deduped: false, votes: 1 };
}

export function clearSkillRequests(options?: { spaceId?: string | null; assistantPackId?: string | null }): number {
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

    const result = getDb()
        .prepare(
            `
        UPDATE skill_requests
        SET status = 'cleared'
        WHERE ${conditions.join(' AND ')}
    `
        )
        .run(...values);

    return result.changes;
}

export function saveImplementationTicket(args: {
    request_id: number;
    ticket: string;
    created_by: string;
    status?: string;
}): SkillRequest | undefined {
    const existing = getSkillRequest(args.request_id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    getDb()
        .prepare(
            `
        UPDATE skill_requests
        SET implementation_ticket = ?,
            implementation_ticket_status = ?,
            implementation_ticket_created_at = COALESCE(implementation_ticket_created_at, ?),
            implementation_ticket_updated_at = ?,
            implementation_ticket_created_by = COALESCE(NULLIF(implementation_ticket_created_by, ''), ?)
        WHERE id = ?
    `
        )
        .run(
            args.ticket.trim(),
            args.status || existing.implementation_ticket_status || 'draft',
            now,
            now,
            args.created_by || 'unknown',
            args.request_id
        );

    return getSkillRequest(args.request_id);
}

export function getChat(jid: string): Chat | undefined {
    return getDb().prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as Chat | undefined;
}

export function upsertChat(chat: Partial<Chat> & { jid: string }): void {
    getDb()
        .prepare(
            `
        INSERT INTO chats (jid, type, status)
        VALUES (@jid, @type, @status)
        ON CONFLICT(jid) DO UPDATE SET type = @type, status = @status
    `
        )
        .run({
            jid: chat.jid,
            type: chat.type || 'private',
            status: chat.status || 'ACTIVE',
        });

    ensureTelegramSpace(chat.jid, chat.type || 'private', chat.jid);
}

// ==========================================
// Tasks
// ==========================================

export function getTask(id: string): Task | undefined {
    return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

function buildTaskRecord(
    task: Partial<Task> & {
        id: string;
        space_id: string;
        title: string;
        prompt: string;
        schedule_type: string;
        schedule_value: string;
    }
): Task {
    const now = nowIso();

    return {
        id: task.id,
        space_id: task.space_id,
        title: task.title,
        kind: task.kind || 'assistant_prompt',
        prompt: task.prompt,
        schedule_type: task.schedule_type,
        schedule_value: task.schedule_value,
        config_json: task.config_json || '{}',
        status: task.status || 'active',
        created_by: task.created_by || 'system',
        last_run_at: task.last_run_at || null,
        created_at: task.created_at || now,
        updated_at: now,
    };
}

export function upsertTask(
    task: Partial<Task> & {
        id: string;
        space_id: string;
        title: string;
        prompt: string;
        schedule_type: string;
        schedule_value: string;
    }
): void {
    getDb()
        .prepare(
            `
        INSERT INTO tasks (
            id, space_id, title, kind, prompt, schedule_type, schedule_value,
            config_json, status, created_by, last_run_at, created_at, updated_at
        )
        VALUES (
            @id, @space_id, @title, @kind, @prompt, @schedule_type, @schedule_value,
            @config_json, @status, @created_by, @last_run_at, @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            space_id = @space_id,
            title = @title,
            kind = @kind,
            prompt = @prompt,
            schedule_type = @schedule_type,
            schedule_value = @schedule_value,
            config_json = @config_json,
            status = @status,
            created_by = @created_by,
            updated_at = @updated_at
    `
        )
        .run(buildTaskRecord(task));
}

export function listTasks(spaceId?: string, status?: string): Task[] {
    const conditions: string[] = [];
    const values: string[] = [];

    if (spaceId) {
        conditions.push('space_id = ?');
        values.push(spaceId);
    }

    if (status) {
        conditions.push('status = ?');
        values.push(status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return getDb()
        .prepare(
            `
        SELECT * FROM tasks ${where} ORDER BY title ASC
    `
        )
        .all(...values) as Task[];
}

export function updateTaskLastRun(id: string, lastRunAt: string): void {
    getDb()
        .prepare(
            `
        UPDATE tasks SET last_run_at = ?, updated_at = ? WHERE id = ?
    `
        )
        .run(lastRunAt, nowIso(), id);
}

export function updateTaskStatus(id: string, status: string): void {
    getDb()
        .prepare(
            `
        UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
    `
        )
        .run(status, nowIso(), id);
}

export function deleteTask(id: string): number {
    const result = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes;
}

export function recordTaskRun(run: TaskRun): void {
    getDb()
        .prepare(
            `
        INSERT INTO task_runs (
            task_id, started_at, finished_at, status, result, error, duration_ms
        )
        VALUES (
            @task_id, @started_at, @finished_at, @status, @result, @error, @duration_ms
        )
    `
        )
        .run({
            task_id: run.task_id,
            started_at: run.started_at,
            finished_at: run.finished_at,
            status: run.status,
            result: run.result ?? null,
            error: run.error ?? null,
            duration_ms: run.duration_ms,
        });
}

export function getTaskRuns(taskId: string): TaskRun[] {
    return getDb()
        .prepare(
            `
        SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC
    `
        )
        .all(taskId) as TaskRun[];
}

// ==========================================
// Memory Entries
// ==========================================

function buildMemoryEntryRecord(
    entry: Partial<MemoryEntry> & {
        scope_type: string;
        scope_id: string;
        kind: string;
        content: string;
    }
): MemoryEntry {
    const now = nowIso();

    return {
        scope_type: entry.scope_type,
        scope_id: entry.scope_id,
        memory_sprint_id: entry.memory_sprint_id || null,
        kind: entry.kind,
        content: entry.content,
        salience: entry.salience ?? 0.5,
        source: entry.source || 'conversation',
        space_bound_id: entry.space_bound_id || null,
        created_at: entry.created_at || now,
        updated_at: now,
    };
}

function findExistingMemoryEntryId(
    entry: Pick<MemoryEntry, 'scope_type' | 'scope_id' | 'memory_sprint_id' | 'kind' | 'content' | 'space_bound_id'>
): number | undefined {
    const prefix = entry.content.substring(0, 40);
    const existing = getDb()
        .prepare(
            `
        SELECT id FROM memory_entries
        WHERE scope_type = ?
          AND scope_id = ?
          AND COALESCE(memory_sprint_id, '') = COALESCE(?, '')
          AND kind = ?
          AND COALESCE(space_bound_id, '') = COALESCE(?, '')
          AND content LIKE ?
        LIMIT 1
    `
        )
        .get(
            entry.scope_type,
            entry.scope_id,
            entry.memory_sprint_id || null,
            entry.kind,
            entry.space_bound_id || null,
            `${prefix}%`
        ) as { id: number } | undefined;

    return existing?.id;
}

export function rememberMemoryEntry(
    entry: Partial<MemoryEntry> & {
        scope_type: string;
        scope_id: string;
        kind: string;
        content: string;
    }
): void {
    const record = buildMemoryEntryRecord(entry);
    const existingId = findExistingMemoryEntryId(record);

    if (existingId) {
        getDb()
            .prepare(
                `
            UPDATE memory_entries
            SET memory_sprint_id = ?, content = ?, salience = ?, source = ?, space_bound_id = ?, updated_at = ?
            WHERE id = ?
        `
            )
            .run(
                record.memory_sprint_id,
                record.content,
                record.salience,
                record.source,
                record.space_bound_id,
                record.updated_at,
                existingId
            );
        return;
    }

    getDb()
        .prepare(
            `
        INSERT INTO memory_entries (
            scope_type, scope_id, memory_sprint_id, kind, content, salience, source, space_bound_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
        )
        .run(
            record.scope_type,
            record.scope_id,
            record.memory_sprint_id,
            record.kind,
            record.content,
            record.salience,
            record.source,
            record.space_bound_id,
            record.created_at,
            record.updated_at
        );
}

export function getMemoryEntries(
    scopeType?: string,
    scopeId?: string,
    kind?: string,
    limit: number = 20
): MemoryEntry[] {
    const filters =
        scopeType && scopeId && kind
            ? [
                  { condition: 'scope_type = ?', value: scopeType },
                  { condition: 'scope_id = ?', value: scopeId },
                  { condition: 'kind = ?', value: kind },
              ]
            : scopeType && scopeId
              ? [
                    { condition: 'scope_type = ?', value: scopeType },
                    { condition: 'scope_id = ?', value: scopeId },
                ]
              : scopeType
                ? [{ condition: 'scope_type = ?', value: scopeType }]
                : [];

    const { where, values } = buildSqlFilters(filters);

    return getDb()
        .prepare(
            `
        SELECT * FROM memory_entries
        ${where}
        ORDER BY salience DESC, updated_at DESC
        LIMIT ?
    `
        )
        .all(...values, limit) as MemoryEntry[];
}

export function getVisiblePersonMemoryEntries(scopeId: string, spaceId?: string, limit: number = 20): MemoryEntry[] {
    if (!spaceId) {
        return getDb()
            .prepare(
                `
            SELECT * FROM memory_entries
            WHERE scope_type = 'person' AND scope_id = ? AND space_bound_id IS NULL
            ORDER BY salience DESC, updated_at DESC
            LIMIT ?
        `
            )
            .all(scopeId, limit) as MemoryEntry[];
    }

    return getDb()
        .prepare(
            `
        SELECT * FROM memory_entries
        WHERE scope_type = 'person' AND scope_id = ? AND (space_bound_id IS NULL OR space_bound_id = ?)
        ORDER BY salience DESC, updated_at DESC
        LIMIT ?
    `
        )
        .all(scopeId, spaceId, limit) as MemoryEntry[];
}

export function deleteMemoryEntriesByContent(fragment: string): number {
    const result = getDb()
        .prepare(
            `
        DELETE FROM memory_entries WHERE content LIKE ?
    `
        )
        .run(`%${fragment}%`);
    return result.changes;
}

// ==========================================
// Messages
// ==========================================

export interface Message {
    id: string;
    space_id?: string | null;
    channel?: string;
    channel_ref?: string;
    sender_id?: string | null;
    content: string;
    timestamp: string;
    is_bot: number;
    chat_jid?: string;
    sender_tg_id?: string | null;
    /** Transport the message travelled on, independent of the space id. */
    transport?: string | null;
    /** Id on that transport, used to reply in-thread after async delivery. */
    transport_message_id?: string | null;
}

export interface MessageSearchHit {
    space_id: string | null;
    channel_ref: string;
    sender_id: string | null;
    sender_name: string | null;
    space_title: string | null;
    content: string;
    timestamp: string;
    is_bot: number;
    chat_jid?: string;
    sender_tg_id?: string | null;
}

export interface DirectContactStatus {
    person_id: string;
    last_inbound_at: string;
    inbound_count: number;
}

export interface RecollectionSearchHit {
    space_id: string;
    scope_type: string;
    space_title: string | null;
    content: string;
    updated_at: string;
}

function normalizeStoredMessage(
    msg: Message
): Required<
    Pick<
        Message,
        | 'id'
        | 'space_id'
        | 'chat_jid'
        | 'sender_tg_id'
        | 'content'
        | 'timestamp'
        | 'is_bot'
        | 'channel_ref'
        | 'sender_id'
    >
> &
    Message {
    const channelRef = msg.channel_ref || msg.chat_jid;
    if (!channelRef) {
        throw new Error('storeMessage requires channel_ref (or legacy chat_jid).');
    }

    // Only consulted when the caller gave no space id, in which case there is
    // no space id to read a transport out of either — so this never parses one.
    const inferredChannel = msg.channel || 'telegram';
    const senderId = msg.sender_id ?? msg.sender_tg_id ?? null;

    return {
        ...msg,
        channel_ref: channelRef,
        sender_id: senderId,
        space_id: msg.space_id || buildSpaceId(inferredChannel, channelRef),
        chat_jid: channelRef,
        sender_tg_id: senderId,
        // Deliberately not inferred from the space id. That guess is right only
        // while every space id happens to start with its channel, and it would
        // start writing nonsense the moment one does not. An unrecorded
        // transport is honest; a wrong one is a trap.
        transport: msg.transport ?? msg.channel ?? null,
        transport_message_id: msg.transport_message_id ?? null,
    };
}

function listRecentMessagesByWhere(whereClause: string, values: SqlFilterValue[], limit: number): Message[] {
    return getDb()
        .prepare(
            `
        SELECT *, chat_jid as channel_ref, sender_tg_id as sender_id
        FROM messages
        WHERE ${whereClause} AND timestamp > ?
        ORDER BY timestamp DESC
        LIMIT ?
    `
        )
        .all(...values, recentTimestampCutoff(), limit)
        .reverse() as Message[];
}

/**
 * Persist a message, reporting whether it was new.
 *
 * `inserted: false` means this exact message id is already stored — a replayed
 * transport event. The gateway relies on that signal to run the agent exactly
 * once per message, so the return value is the deduplication guarantee, not a
 * convenience.
 */
export function storeMessage(msg: Message): { inserted: boolean } {
    const result = getDb()
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
        .run(normalizeStoredMessage(msg));

    return { inserted: result.changes > 0 };
}

export function getRecentMessages(chat_jid: string, limit: number = 30): Message[] {
    return listRecentMessagesByWhere('chat_jid = ?', [chat_jid], limit);
}

export function getRecentMessagesForSpace(spaceId: string, limit: number = 30): Message[] {
    return listRecentMessagesByWhere(`COALESCE(space_id, 'telegram:' || chat_jid) = ?`, [spaceId], limit);
}

function directExternalRefForPerson(channel: string, personId: string): string {
    const prefix = `${channel}:`;
    return channel !== 'telegram' && personId.startsWith(prefix) ? personId.substring(prefix.length) : personId;
}

export function getRecentDirectMessagesForPerson(channel: string, personId: string, limit: number = 12): Message[] {
    const directSpaceId = buildSpaceId(channel, directExternalRefForPerson(channel, personId));
    return getRecentMessagesForSpace(directSpaceId, limit);
}

export function getDirectContactStatuses(channel: string, personIds: string[]): DirectContactStatus[] {
    const uniquePersonIds = [...new Set(personIds.filter(Boolean))];
    if (uniquePersonIds.length === 0) return [];

    const placeholders = uniquePersonIds.map(() => '?').join(', ');
    return getDb()
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
        .all(`${channel}:`, channel, ...uniquePersonIds) as DirectContactStatus[];
}

export function searchMessages(query: string, options?: { spaceId?: string; limit?: number }): MessageSearchHit[] {
    const normalized = normalizeSearchTerm(query);
    if (!normalized) return [];

    const { where, values } = buildSqlFilters([
        {
            condition: `LOWER(COALESCE(m.content, '') || ' ' || COALESCE(s.title, '') || ' ' || COALESCE(s.external_ref, '') || ' ' || COALESCE(s.policy_json, '')) LIKE ?`,
            value: `%${normalized}%`,
        },
        { condition: `${MESSAGE_SPACE_SQL} = ?`, value: options?.spaceId },
    ]);

    return getDb()
        .prepare(
            `
        SELECT
            ${MESSAGE_SPACE_SQL} as space_id,
            m.chat_jid as channel_ref,
            m.sender_tg_id as sender_id,
            COALESCE(r.nickname, r.display_name, r.username, m.sender_tg_id) as sender_name,
            s.title as space_title,
            m.content,
            m.timestamp,
            m.is_bot,
            m.chat_jid,
            m.sender_tg_id
        FROM messages m
        LEFT JOIN residents r ON r.tg_id = m.sender_tg_id
        LEFT JOIN spaces s ON s.id = ${MESSAGE_SPACE_SQL}
        ${where}
        ORDER BY m.timestamp DESC
        LIMIT ?
    `
        )
        .all(...values, clampLimit(options?.limit, 8, 1, 20)) as MessageSearchHit[];
}

export function searchRecollections(
    query: string,
    options?: { spaceId?: string; limit?: number }
): RecollectionSearchHit[] {
    const normalized = normalizeSearchTerm(query);
    if (!normalized) return [];

    const { where, values } = buildSqlFilters([
        { condition: `me.kind = 'recollection'`, enabled: true },
        { condition: `me.scope_type IN ('space', 'work', 'project')`, enabled: true },
        { condition: 'LOWER(me.content) LIKE ?', value: `%${normalized}%` },
        { condition: 'me.scope_id = ?', value: options?.spaceId },
    ]);

    return getDb()
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
        ${where}
        ORDER BY me.updated_at DESC
        LIMIT ?
    `
        )
        .all(...values, clampLimit(options?.limit, 8, 1, 20)) as RecollectionSearchHit[];
}

export function listMemorySprints(spaceId: string, limit: number = 12): MemorySprint[] {
    return getDb()
        .prepare(
            `
        SELECT * FROM memory_sprints
        WHERE space_id = ?
        ORDER BY opened_at DESC
        LIMIT ?
    `
        )
        .all(spaceId, clampLimit(limit, 12, 1, 24)) as MemorySprint[];
}

export function getOldMessages(chat_jid: string, olderThanDays: number = 7): Message[] {
    const cutoff = recentTimestampCutoff(olderThanDays);
    return getDb()
        .prepare(
            `
        SELECT *, chat_jid as channel_ref, sender_tg_id as sender_id
        FROM messages WHERE chat_jid = ? AND timestamp <= ? ORDER BY timestamp ASC
    `
        )
        .all(chat_jid, cutoff) as Message[];
}

export function deleteOldMessages(chat_jid: string, olderThanDays: number = 7): number {
    const cutoff = recentTimestampCutoff(olderThanDays);
    const result = getDb()
        .prepare(
            `
        DELETE FROM messages WHERE chat_jid = ? AND timestamp <= ?
    `
        )
        .run(chat_jid, cutoff);
    return result.changes;
}

export function clearMessages(chat_jid: string): void {
    getDb().prepare('DELETE FROM messages WHERE chat_jid = ?').run(chat_jid);
}

export function clearMessagesForSpace(spaceId: string): void {
    getDb()
        .prepare(
            `
        DELETE FROM messages
        WHERE COALESCE(space_id, 'telegram:' || chat_jid) = ?
    `
        )
        .run(spaceId);
}

// ==========================================
// Event Log
// ==========================================

export function logEvent(event_type: string, details: Record<string, any>): void {
    getDb()
        .prepare(
            `
        INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)
    `
        )
        .run(event_type, JSON.stringify(details), nowIso());
}

function uniqueStringList(values: Array<string | null | undefined>): string[] {
    return Array.from(new Set(values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)));
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? uniqueStringList(parsed) : [];
    } catch {
        return [];
    }
}

function mergeJsonStringArray(
    existingRaw: string | null | undefined,
    nextValues: Array<string | null | undefined> = []
): string {
    return JSON.stringify(uniqueStringList([...parseJsonStringArray(existingRaw), ...nextValues]));
}

export function beginToolExecutionLog(entry: {
    space_id?: string | null;
    task_id?: string | null;
    tool_name: string;
    run_mode: string;
    audit_mode: string;
    capabilities: string[];
    args?: Record<string, any>;
    workspace_root?: string | null;
    sandbox_backend?: string | null;
    sandbox_image?: string | null;
    sandbox_container_id?: string | null;
}): number {
    const now = nowIso();
    const result = getDb()
        .prepare(
            `
        INSERT INTO tool_execution_log (
            space_id,
            task_id,
            tool_name,
            run_mode,
            audit_mode,
            capabilities_json,
            args_json,
            status,
            started_at,
            workspace_root,
            sandbox_backend,
            sandbox_image,
            sandbox_container_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
    `
        )
        .run(
            entry.space_id || null,
            entry.task_id || null,
            entry.tool_name,
            entry.run_mode,
            entry.audit_mode,
            JSON.stringify(uniqueStringList(entry.capabilities)),
            JSON.stringify(entry.args || {}),
            now,
            entry.workspace_root || null,
            entry.sandbox_backend || null,
            entry.sandbox_image || null,
            entry.sandbox_container_id || null
        );

    return Number(result.lastInsertRowid);
}

export function getToolExecutionLog(id: number): ToolExecutionLog | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM tool_execution_log WHERE id = ?
    `
        )
        .get(id) as ToolExecutionLog | undefined;
}

export function listToolExecutionLogsForTask(taskId: string): ToolExecutionLog[] {
    return getDb()
        .prepare(
            `
        SELECT * FROM tool_execution_log WHERE task_id = ? ORDER BY started_at DESC
    `
        )
        .all(taskId) as ToolExecutionLog[];
}

export function appendToolExecutionLogData(
    id: number,
    patch: {
        network_targets?: string[];
        files_read?: string[];
        files_written?: string[];
        artifacts?: string[];
        sandbox_backend?: string | null;
        sandbox_image?: string | null;
        sandbox_container_id?: string | null;
        workspace_root?: string | null;
    }
): void {
    const existing = getToolExecutionLog(id);
    if (!existing) return;

    getDb()
        .prepare(
            `
        UPDATE tool_execution_log
        SET network_targets_json = ?,
            files_read_json = ?,
            files_written_json = ?,
            artifacts_json = ?,
            sandbox_backend = COALESCE(?, sandbox_backend),
            sandbox_image = COALESCE(?, sandbox_image),
            sandbox_container_id = COALESCE(?, sandbox_container_id),
            workspace_root = COALESCE(?, workspace_root)
        WHERE id = ?
    `
        )
        .run(
            mergeJsonStringArray(existing.network_targets_json, patch.network_targets),
            mergeJsonStringArray(existing.files_read_json, patch.files_read),
            mergeJsonStringArray(existing.files_written_json, patch.files_written),
            mergeJsonStringArray(existing.artifacts_json, patch.artifacts),
            patch.sandbox_backend || null,
            patch.sandbox_image || null,
            patch.sandbox_container_id || null,
            patch.workspace_root || null,
            id
        );
}

export function finishToolExecutionLog(
    id: number,
    patch: {
        status: string;
        result_preview?: string | null;
        error?: string | null;
        duration_ms?: number;
    }
): void {
    getDb()
        .prepare(
            `
        UPDATE tool_execution_log
        SET status = ?,
            finished_at = ?,
            duration_ms = ?,
            result_preview = ?,
            error = ?
        WHERE id = ?
    `
        )
        .run(patch.status, nowIso(), patch.duration_ms || 0, patch.result_preview || null, patch.error || null, id);
}

export function deleteToolExecutionLog(id: number): void {
    getDb().prepare('DELETE FROM tool_execution_log WHERE id = ?').run(id);
}

export function insertToolLog(entry: {
    space_id?: string | null;
    task_id?: string | null;
    tool_name: string;
    run_mode: string;
    audit_mode: string;
    args?: Record<string, any>;
    result_text?: string | null;
    status: string;
    error?: string | null;
    started_at: string;
    finished_at: string;
    duration_ms?: number;
}): number {
    const result = getDb()
        .prepare(
            `
        INSERT INTO tool_logs (
            space_id,
            task_id,
            tool_name,
            run_mode,
            audit_mode,
            args_json,
            result_text,
            status,
            error,
            started_at,
            finished_at,
            duration_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
        )
        .run(
            entry.space_id || null,
            entry.task_id || null,
            entry.tool_name,
            entry.run_mode,
            entry.audit_mode,
            JSON.stringify(entry.args || {}),
            entry.result_text ?? null,
            entry.status,
            entry.error ?? null,
            entry.started_at,
            entry.finished_at,
            entry.duration_ms || 0
        );

    return Number(result.lastInsertRowid);
}

export function getToolLogsForTask(taskId: string): ToolLog[] {
    return getDb()
        .prepare(
            `
        SELECT * FROM tool_logs WHERE task_id = ? ORDER BY started_at DESC
    `
        )
        .all(taskId) as ToolLog[];
}

export function getToolLog(id: number): ToolLog | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM tool_logs WHERE id = ?
    `
        )
        .get(id) as ToolLog | undefined;
}

function buildToolLogWhereClause(filters: ToolLogQuery): { whereSql: string; params: any[] } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.space_id) {
        conditions.push('space_id = ?');
        params.push(filters.space_id);
    }
    if (filters.task_id) {
        conditions.push('task_id = ?');
        params.push(filters.task_id);
    }
    if (filters.tool_name) {
        conditions.push('tool_name = ?');
        params.push(filters.tool_name);
    }
    if (filters.status) {
        conditions.push('status = ?');
        params.push(filters.status);
    }
    if (filters.started_after) {
        conditions.push('started_at >= ?');
        params.push(filters.started_after);
    }
    if (filters.started_before) {
        conditions.push('started_at <= ?');
        params.push(filters.started_before);
    }

    const q = filters.q?.trim();
    if (q) {
        const pattern = `%${q}%`;
        conditions.push(
            `(tool_name LIKE ? OR args_json LIKE ? OR COALESCE(result_text, '') LIKE ? OR COALESCE(error, '') LIKE ?)`
        );
        params.push(pattern, pattern, pattern, pattern);
    }

    return {
        whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
        params,
    };
}

function normalizeToolLogPage(filters: ToolLogQuery): { limit: number; offset: number } {
    const rawLimit = Number(filters.limit ?? 50);
    const rawOffset = Number(filters.offset ?? 0);
    const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    return { limit, offset };
}

export function queryToolLogs(filters: ToolLogQuery = {}): {
    items: ToolLog[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
} {
    const { whereSql, params } = buildToolLogWhereClause(filters);
    const { limit, offset } = normalizeToolLogPage(filters);

    const totalRow = getDb()
        .prepare(
            `
        SELECT COUNT(*) as total
        FROM tool_logs
        ${whereSql}
    `
        )
        .get(...params) as { total: number };

    const items = getDb()
        .prepare(
            `
        SELECT *
        FROM tool_logs
        ${whereSql}
        ORDER BY started_at DESC, id DESC
        LIMIT ? OFFSET ?
    `
        )
        .all(...params, limit, offset) as ToolLog[];

    return {
        items,
        total: totalRow?.total || 0,
        limit,
        offset,
        has_more: offset + items.length < (totalRow?.total || 0),
    };
}

export function summarizeToolLogs(filters: ToolLogQuery = {}): ToolLogSummary {
    const { whereSql, params } = buildToolLogWhereClause(filters);

    const totalRow = getDb()
        .prepare(
            `
        SELECT COUNT(*) as total
        FROM tool_logs
        ${whereSql}
    `
        )
        .get(...params) as { total: number };

    const statusRows = getDb()
        .prepare(
            `
        SELECT status, COUNT(*) as count
        FROM tool_logs
        ${whereSql}
        GROUP BY status
    `
        )
        .all(...params) as Array<{ status: string; count: number }>;

    const toolRows = getDb()
        .prepare(
            `
        SELECT tool_name, COUNT(*) as count
        FROM tool_logs
        ${whereSql}
        GROUP BY tool_name
        ORDER BY count DESC, tool_name ASC
        LIMIT 10
    `
        )
        .all(...params) as Array<{ tool_name: string; count: number }>;

    const by_status: Record<string, number> = {};
    for (const row of statusRows) {
        by_status[row.status] = row.count;
    }

    return {
        total: totalRow?.total || 0,
        by_status,
        by_tool: toolRows,
    };
}

// ==========================================
// Token Usage
// ==========================================

// Gemini token pricing (per 1M tokens).
// Gemini 3 Pro Preview uses a higher tier once the prompt exceeds 200k input tokens.
const PRICING: Record<string, { input: number; output: number }> = {
    'gemini-2.5-flash': { input: 0.15, output: 0.6 },
    'gemini-2.5-pro': { input: 1.25, output: 10.0 },
    'gemini-3-pro-preview': { input: 2.0, output: 12.0 },
};

function resolvePricing(model: string, inputTokens: number): { input: number; output: number } {
    if (model === 'gemini-3-pro-preview' && inputTokens > 200_000) {
        return { input: 4.0, output: 18.0 };
    }

    return PRICING[model] || PRICING['gemini-2.5-flash'];
}

export function logTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
    const today = new Date().toISOString().split('T')[0];
    const isLocal = model.startsWith('ollama:');
    const pricing = isLocal ? { input: 0, output: 0 } : resolvePricing(model, inputTokens);
    const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

    getDb()
        .prepare(
            `
        INSERT INTO token_usage (date, model, input_tokens, output_tokens, cost_usd, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `
        )
        .run(today, model, inputTokens, outputTokens, cost, new Date().toISOString());
}

export function getDailyTokenCost(date?: string): {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    calls: number;
} {
    const day = date || new Date().toISOString().split('T')[0];
    const row = getDb()
        .prepare(
            `
        SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
               COALESCE(SUM(output_tokens), 0) as output_tokens,
               COALESCE(SUM(cost_usd), 0) as cost_usd,
               COUNT(*) as calls
        FROM token_usage WHERE date = ?
    `
        )
        .get(day) as any;
    return row;
}

export interface SystemMetricsHistorySample {
    timestamp: string;
    temp_c: number;
    ram_percent: number;
    swap_used_mb: number;
    disk_percent: number;
    throttle_hex: string;
    internet_ok: number;
    ollama_ok: number;
}

export function storeSystemMetricsSample(sample: SystemMetricsHistorySample): void {
    getDb()
        .prepare(
            `
        INSERT INTO system_metrics_history (
            timestamp, temp_c, ram_percent, swap_used_mb, disk_percent,
            throttle_hex, internet_ok, ollama_ok
        ) VALUES (
            @timestamp, @temp_c, @ram_percent, @swap_used_mb, @disk_percent,
            @throttle_hex, @internet_ok, @ollama_ok
        )
    `
        )
        .run(sample);
}

export function getSystemMetricsSummary(hours: number): {
    samples: number;
    first_timestamp: string | null;
    last_timestamp: string | null;
    temp_min: number | null;
    temp_avg: number | null;
    temp_max: number | null;
    ram_peak: number | null;
    swap_peak_mb: number | null;
    disk_peak: number | null;
    throttled_samples: number;
    internet_down_samples: number;
    ollama_down_samples: number;
} {
    const safeHours = Math.min(Math.max(hours, 1), 24 * 14);
    const cutoff = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();

    return getDb()
        .prepare(
            `
        SELECT
            COUNT(*) as samples,
            MIN(timestamp) as first_timestamp,
            MAX(timestamp) as last_timestamp,
            MIN(temp_c) as temp_min,
            AVG(temp_c) as temp_avg,
            MAX(temp_c) as temp_max,
            MAX(ram_percent) as ram_peak,
            MAX(swap_used_mb) as swap_peak_mb,
            MAX(disk_percent) as disk_peak,
            SUM(CASE WHEN throttle_hex IS NOT NULL AND throttle_hex != '0x0' THEN 1 ELSE 0 END) as throttled_samples,
            SUM(CASE WHEN internet_ok = 0 THEN 1 ELSE 0 END) as internet_down_samples,
            SUM(CASE WHEN ollama_ok = 0 THEN 1 ELSE 0 END) as ollama_down_samples
        FROM system_metrics_history
        WHERE timestamp >= ?
    `
        )
        .get(cutoff) as any;
}

export function cleanupSystemMetricsHistory(daysToKeep: number = 14): number {
    const cutoff = retentionCutoff(daysToKeep);
    const result = getDb()
        .prepare(
            `
        DELETE FROM system_metrics_history WHERE timestamp < ?
    `
        )
        .run(cutoff);
    return result.changes;
}

export function cleanupToolExecutionLogs(daysToKeep: number = 30): number {
    const cutoff = retentionCutoff(daysToKeep);
    const result = getDb()
        .prepare(
            `
        DELETE FROM tool_execution_log WHERE started_at < ?
    `
        )
        .run(cutoff);
    return result.changes;
}

export function cleanupToolLogs(daysToKeep: number = 30): number {
    const cutoff = retentionCutoff(daysToKeep);
    const result = getDb()
        .prepare(
            `
        DELETE FROM tool_logs WHERE started_at < ?
    `
        )
        .run(cutoff);
    return result.changes;
}

// ==========================================
// Artifacts
// ==========================================

export interface Artifact {
    id: string;
    space_id: string;
    source_message_id: string | null;
    kind: string;
    title: string;
    ref: string;
    summary: string;
    created_at: string;
    updated_at: string | null;
    archived_at: string | null;
}

export interface TimelineEvent {
    id: string;
    space_id: string;
    day: string;
    happened_at: string;
    type: string;
    ref_type: string | null;
    ref_id: string | null;
    summary: string;
    details_json: string | null;
    created_at: string;
}

export function getArtifact(id: string): Artifact | undefined {
    return getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Artifact | undefined;
}

export function getArtifactByKindAndTitle(spaceId: string, kind: string, title: string): Artifact | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM artifacts
        WHERE space_id = ? AND kind = ? AND title = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
    `
        )
        .get(spaceId, kind, title) as Artifact | undefined;
}

export function createArtifact(
    artifact: Omit<Artifact, 'created_at' | 'updated_at' | 'archived_at'> & { created_at?: string }
): Artifact {
    const now = nowIso();
    const created = artifact.created_at || now;
    getDb()
        .prepare(
            `
        INSERT INTO artifacts (id, space_id, source_message_id, kind, title, ref, summary, created_at, updated_at, archived_at)
        VALUES (@id, @space_id, @source_message_id, @kind, @title, @ref, @summary, @created_at, @updated_at, @archived_at)
    `
        )
        .run({
            ...artifact,
            created_at: created,
            updated_at: created,
            archived_at: null,
        });
    return getArtifact(artifact.id)!;
}

export function updateArtifact(
    id: string,
    patch: Partial<Pick<Artifact, 'ref' | 'summary' | 'title' | 'archived_at'>>
): Artifact | undefined {
    const existing = getArtifact(id);
    if (!existing) return undefined;

    const now = nowIso();
    getDb()
        .prepare(
            `
        UPDATE artifacts
        SET ref = @ref, summary = @summary, title = @title, archived_at = @archived_at, updated_at = @updated_at
        WHERE id = @id
    `
        )
        .run({
            id,
            ref: patch.ref !== undefined ? patch.ref : existing.ref,
            summary: patch.summary !== undefined ? patch.summary : existing.summary,
            title: patch.title !== undefined ? patch.title : existing.title,
            archived_at: patch.archived_at !== undefined ? patch.archived_at : existing.archived_at,
            updated_at: now,
        });
    return getArtifact(id);
}

export function listArtifacts(spaceId: string, options?: { includeArchived?: boolean; limit?: number }): Artifact[] {
    const limit = options?.limit || 100;
    const includeArchived = options?.includeArchived ?? false;
    const where = includeArchived ? 'space_id = ?' : 'space_id = ? AND archived_at IS NULL';

    return getDb()
        .prepare(
            `
        SELECT * FROM artifacts
        WHERE ${where}
        ORDER BY updated_at DESC
        LIMIT ?
    `
        )
        .all(spaceId, limit) as Artifact[];
}

export function archiveOldArtifactsForKind(spaceId: string, kind: string, currentIdToKeep: string): void {
    const now = nowIso();
    getDb()
        .prepare(
            `
        UPDATE artifacts
        SET archived_at = @now, updated_at = @now
        WHERE space_id = @space_id AND kind = @kind AND id != @id AND archived_at IS NULL
    `
        )
        .run({ space_id: spaceId, kind, now, id: currentIdToKeep });
}

export function getLatestArtifactByKind(spaceId: string, kind: string): Artifact | undefined {
    return getDb()
        .prepare(
            `
        SELECT * FROM artifacts
        WHERE space_id = ? AND kind = ? AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
    `
        )
        .get(spaceId, kind) as Artifact | undefined;
}

export function createTimelineEvent(event: TimelineEvent): TimelineEvent {
    getDb()
        .prepare(
            `
        INSERT INTO timeline_events (
            id, space_id, day, happened_at, type, ref_type, ref_id, summary, details_json, created_at
        )
        VALUES (
            @id, @space_id, @day, @happened_at, @type, @ref_type, @ref_id, @summary, @details_json, @created_at
        )
    `
        )
        .run({
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

    return getDb().prepare('SELECT * FROM timeline_events WHERE id = ?').get(event.id) as TimelineEvent;
}

export function listTimelineEvents(
    spaceId: string,
    options?: { day?: string; fromDay?: string; toDay?: string; limit?: number }
): TimelineEvent[] {
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

    return getDb()
        .prepare(
            `
        SELECT * FROM timeline_events
        WHERE ${conditions.join(' AND ')}
        ORDER BY happened_at DESC, created_at DESC
        LIMIT ?
    `
        )
        .all(...values, clampLimit(options?.limit, 120, 1, 500)) as TimelineEvent[];
}
