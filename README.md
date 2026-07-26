# PiPi Agents

## Teach one. Share the pack.

**Small, open-source agents for real teams.**

Private memory. Shared know-how. Your hardware.

[Install Open PiPi](#quickstart) · [Install with a coding agent](CODING_AGENT_INSTALLATION.md) · [Choose a Pack](#packs-and-plug-and-play) · [See the Flow](#telegram-flow)

✓ **Team-native** · ✓ **Runs on Raspberry Pi 4** · ✓ **Token-frugal** · ✓ **Open source**

[![CI](https://github.com/amyotoff/open-pipi/actions/workflows/ci.yml/badge.svg)](https://github.com/amyotoff/open-pipi/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-2.5.0-informational.svg)](package.json)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org)

## TL;DR

- Open PiPi is a self-hosted assistant runtime you can actually read, fork, and change.
- It is `Telegram`-first, but `Discord`, `WhatsApp`, and `Gmail` reuse the same core runtime.
- The main runtime unit is a `space`: a DM, group, channel, or email thread participant.
- A `pack` changes the assistant's voice, enabled skills, default policies, seeded tasks, and optional pack-local tools.
- A `grounding` holds stable facts and operating rules. Memory handles the changing stuff.
- The happy path is simple: copy `.env.example`, fill a few vars, run `pnpm setup:check`, bootstrap, then `pnpm dev`.
- `DATA_DIR` is the assistant's suitcase: database, auth state, restore points, and pinned per-space behavior all live there.
- Safe updates are meant to preserve both memory and behavior. Existing spaces keep their current pack + grounding snapshot until you intentionally switch them.
- If you want something hackable rather than a hosted SaaS or a no-code agent builder, this repo is aimed at that.

## Quickstart

This repo is `pnpm`-first.

Using a coding agent? Give it the [non-destructive, machine-checkable installation runbook](CODING_AGENT_INSTALLATION.md).

### 1. Requirements

- Node.js 24+
- `pnpm` 10 (the repo pins `10.26.2`; Corepack is optional and is not bundled with every Node release)
- a Telegram bot token
- a Gemini API key
- at least one owner ID

Optional:

- Docker for `sandboxd`, `Ollama`, and Chromium
- credentials for `Discord`, `WhatsApp`, or `Gmail`

### 2. Install

```bash
git clone https://github.com/amyotoff/open-pipi.git
cd open-pipi
cp .env.example .env
pnpm install
```

If `pnpm` is missing and your Node distribution includes Corepack, run `corepack enable` before the install block. Otherwise install pnpm 10 using your normal toolchain manager.

Lean Telegram-only install:

```bash
pnpm install --no-optional
```

That skips optional support for `Discord`, `WhatsApp`, `Gmail`, and browser automation. Use the full install if you want those features.

If you later enable `Discord`, `WhatsApp`, or `Gmail` in `.env` without reinstalling the optional packages, PiPi will fail fast with a clear startup error instead of partially booting. Browser automation is loaded on demand, so missing browser packages fail when a browser-based skill is invoked.

### 3. Fill the minimum `.env`

If you only want the simplest working setup, these are the key vars:

```dotenv
TELEGRAM_BOT_TOKEN=...
GEMINI_API_KEY=...
OWNER_TG_IDS=123456789
TZ=UTC
```

To give your assistant its own name (used in greetings and group mentions):

```dotenv
BOT_DISPLAY_NAME=Alfred
BOT_NAME_ALIASES=alfred,альфред
```

If you also want non-Telegram owners, add channel-qualified identities:

```dotenv
OWNER_IDENTITIES=discord:123456789,whatsapp:+393331234567,gmail:me@example.com
```

If you only care about Telegram for now, you can leave the other channel vars empty.

Check the setup without starting the bot or exposing secret values:

```bash
pnpm setup:check
```

The command reports missing required values, unsafe owner access, invalid pack/grounding IDs, data-directory permissions, and missing dependencies for optional channels you enabled. `pnpm setup:check -- --json` returns the same read-only result for scripts.

### 4. Bootstrap your assistant

```bash
pnpm bootstrap
```

This is the fastest way to make PiPi feel like your assistant instead of a generic demo. The bootstrap script:

- asks for a short description of the assistant
- creates `src/groundings/<slug>/`
- tells you which `BOOTSTRAP_PACK` and `BOOTSTRAP_GROUNDING` values to add to `.env`
- gives you smoke-test prompts for the first run

`.env.example` starts with the built-in Jeeves pack and grounding. The bootstrap script prints replacement values when you generate your own grounding.

### 5. Run it

```bash
pnpm dev
```

Then open Telegram, DM the bot, and send `/start`.

What happens next:

- the first DM or configured group becomes a `space`
- the space gets its own memory, tasks, artifacts, and pack selection
- the space also gets a pinned pack + grounding snapshot under `DATA_DIR`, so app upgrades do not quietly rewrite its behavior
- PiPi keeps those contexts separate instead of treating every chat like one blob
- `/setup` is the explicit onboarding surface for a fresh space
- `/channel mode ...` controls whether that space is fully conversational, inbox-only, notify-only, or quiet

### Telegram flow

You normally do not need commands: write what you want in a regular message. The visible Telegram menu keeps only everyday outcomes:

- `/start`, `/today`, `/tasks`, `/help`, `/setup`
- `/today` is the daily hub: timeline plus one-tap Brief, Focus, and Review actions
- `/tasks` shows a compact schedule; select a task to run, pause, or resume it, or describe a new task normally
- `/help advanced` reveals technical and owner-only commands when you need them

Advanced setup and operator commands remain available for compatibility:

- `/setup` opens a simple settings screen with one-tap recommended setup
- `/setup apply` marks the space active and applies the current default setup flow
- `/setup smoke` runs the setup smoke handler
- `/setup reset` returns onboarding to `new` without changing pack or grounding
- `/channel status` shows the current transport and channel mode for this space
- `/channel mode <off|notify_only|inbox|full>` changes how the runtime treats this channel
- `/pack` shows the current pack and lists available packs (detects naked/missing pack)
- `/pack mutate <id>` switches the space to a different assistant pack
- `/backup` creates a manual runtime backup in one step
- `/backup status` shows the latest backup info and a pre-upgrade reminder
- `/approve [browse_web|deep_research]` and `/deny [browse_web|deep_research]` resolve pending risky actions explicitly

### 6. Optional: run the full local stack

If you want local fallback models, safer tool execution, and browser automation, use Docker Compose.

Before starting it, set a strong `SANDBOXD_TOKEN` in `.env`.

```bash
docker compose up -d
```

That stack brings up:

- `pipi-bot`
- `ollama`
- `sandboxd`
- `chromium`

## Mental Model

| Piece | What it means | Where it lives |
| --- | --- | --- |
| `space` | One runtime context for a conversation, reachable from one or more transports | SQLite + runtime |
| `binding` | Maps an external endpoint (a Telegram chat, a web room) to a space | SQLite |
| `participant` | One person, with an identity per transport they use | SQLite |
| `pack` | Persona, enabled skills, defaults, seeded tasks, and optional pack tools | source in `src/packs/*`, active snapshot in `DATA_DIR/space-behavior/*` |
| `grounding` | Stable facts, people, glossary, and operating rules | source in `src/groundings/*`, active snapshot in `DATA_DIR/space-behavior/*` |
| `memory` | Structured evolving context, not a vague vector blob | SQLite |
| `artifacts` | Durable docs like plans, task lists, walkthroughs, and diffs | SQLite |
| `HTML artifacts` | Shareable pages for long plans, research, reports, meeting notes, daily Briefs, and morning plans | `DATA_DIR/html-artifacts/*` and `DATA_DIR/briefs/*` |


If you only remember one thing, remember this: `packs` shape behavior, `groundings` shape world knowledge, and `spaces` keep everything scoped cleanly. Transports are only ways in.

There is one more practical split worth keeping in mind:

- `setup` tells you whether a space is still being onboarded
- `channel mode` tells the runtime how chatty that channel is allowed to be
- `consent` tells the runtime whether a risky tool call may proceed right now

## Packs And Plug-and-Play

A pack is the product layer. It decides how the assistant behaves in a space without forcing you to rewrite the core runtime.

Each pack can define:

- system prompt / persona
- enabled skills
- default policies
- authority presets
- seeded scheduled tasks
- optional literary-character behavioral calibration
- optional family members for bounded delegation
- optional pack-local tools

### What makes it plug-and-play

You do not need a remote plugin marketplace or a separate control plane. A pack is just a folder under `src/packs`.

Minimal layout:

```text
src/packs/my_pack/
  agent.md
  character.md              # optional behavior-only calibration
  skills.md
  tools.md                  # optional
  tools/
    my_tool.tool.js         # optional
```

What each file does:

- `agent.md`: JSON frontmatter plus the actual system prompt
- `family_members` in `agent.md`: optional delegated roles; each role declares its exact `allowed_tools` allowlist
- `character.md`: optional decision-making calibration; keep speech imitation and fictional roleplay out of it
- `skills.md`: JSON frontmatter describing enabled capabilities and optional hints
- `tools.md`: human-readable notes for pack-specific tools
- `tools/*.tool.js` or `*.tool.ts`: pack-local executable tools

How discovery works:

- in dev, the runtime loads packs from `src/packs/*`
- on build, `pnpm build` copies packs into `dist/packs`
- any folder with an `agent.md` and `skills.md` is treated as an installable pack
- on Telegram, owners can inspect and switch packs with `/pack` and `/pack mutate <id>` (or the older `/space pack <id>`)

Built-in packs:

| Pack | Best for | Notes |
| --- | --- | --- |
| `jeeves` | Personal assistant | Calm, polished PA behavior |
| `office` | Team coordination | Clear operational notes, follow-ups, and briefs |
| `reporter` | Research and reporting | Source-aware topic finding and drafting |
| `tutor` | Teaching and study | Patient explanations and learning follow-through |

This means "plug-and-play" here is literal: drop in a new pack directory, run the app, attach it to a space, and the core runtime keeps working.

Before running or sharing custom content, validate every pack and grounding:

```bash
pnpm content:check
```

The same command is part of `pnpm verify`; use `pnpm content:check -- --json` when another tool needs structured diagnostics.

Start a new extension from a valid, non-destructive scaffold:

```bash
pnpm content:new -- pack my_assistant
pnpm content:new -- grounding my_world
```

Add `--dry-run` to preview the files. Existing content directories are never overwritten.

## Transports

A transport is a way *into* a space, not a place the assistant lives. It carries messages and nothing else — behavior, memory, permissions, and knowledge all belong to the space, so the same conversation can be open on two surfaces at once.

For `Discord`, `WhatsApp`, `Gmail`, and browser-based skills, use the full `pnpm install`. A lean `pnpm install --no-optional` is meant for Telegram-only setups.

| Transport | Status | Notes |
| --- | --- | --- |
| Telegram | Primary / alpha | Fullest UX: commands, group participation, typing, photo flow |
| Web / PWA | Local, read + send | Runs on your own network; sign in, read history, send. See below |
| Discord | Working text adapter | DMs plus one primary channel, Telegram-lite command set |
| WhatsApp | Working text adapter | Owner-operated, DM-first, optional primary group |
| Gmail | Working email-mode adapter | SMTP outbound + IMAP polling inbound, threaded and email-native |
| Slack | Not implemented | No adapter in the repo |

Writing another one: [docs/transports.md](docs/transports.md).

### Bindings: one space, several ways in

A `transport binding` maps an external endpoint — a Telegram chat, a web room — to a space. A space can hold more than one, and a reply goes to every active binding, so a question asked from the browser is still answered in the Telegram group where the rest of the conversation lives.

Existing chats bind themselves on first contact, so adding the bot to a group just works. Nothing needs reconnecting after an upgrade.

### Delivery is durable

Every outgoing message is written to an outbox before any send is attempted, and an in-process worker drains it: retries with backoff, bounded attempts, FIFO per conversation, and resumption after a restart. A crash between deciding to answer and answering does not lose the reply.

### Local web client

Off by default. Turn it on with `PIPI_WEB_ENABLED=true`, then create an account **linked to a participant the assistant already knows**:

```bash
PIPI_WEB_PASSWORD='something long' pnpm web:account -- --username alex --participant <person_id>
```

Run `pnpm web:account -- --list` to see the participant ids. The link is the point: signing in over the web arrives as the *same person* as their Telegram account, with the same memory, membership, and authority.

Then open `http://<host>:3000`. You see the spaces you are a member of and nothing else.

`PIPI_WEB_HOST` stays on `127.0.0.1` unless you mean to reach the assistant from other devices. Binding wider requires an account to exist first — otherwise startup refuses rather than publishing an open assistant to your network.

### The owner dashboard

An owner signing in gets extra sections in the sidebar. Everyone else does not — and the API behind them answers `404`, not `403`, so its existence stays quiet.

| View | Shows | Lets you change |
| --- | --- | --- |
| Overview | Health, queue depth, and how spaces, bindings and participants are wired together | — |
| Spaces | Every space with its pack, grounding, mode, and the transports it is reachable from | Mode, pack, grounding; archive and restore |
| Delivery | What is still queued or has been given up on, with the error | Retry a failed delivery |
| Wiki | The Brain Layer's curated pages and notes, as plain text | — |
| Memory | What the assistant remembers, newest first | — |

Archiving a space hides it and sets its mode to `off`; nothing is deleted, and Restore brings it back. Retrying a failed delivery hands back its attempt budget — useful once the reason it failed is fixed. Both are written to the event log with who did it.

Settings that live in `.env` — tokens, owners, hosts — are edited in `.env`. A dashboard that edits credentials is an attack surface, not a convenience. For the same reason the wiki and memory are readable but not editable here: the assistant maintains those through its own skills, where a change carries provenance.

### Channel modes

Every space gets one simple runtime mode, applied across its transports:

| Mode | Behavior |
| --- | --- |
| `full` | Normal conversational routing plus notifications |
| `inbox` | Incoming messages are stored, but the assistant does not auto-reply |
| `notify_only` | Conversational routing is off; command replies and system notifications still work |
| `off` | Conversational routing and background notifications are suppressed for that space |

### Telegram external groups

For client or partner Telegram groups, add the bot as an admin, then run this inside the group as an owner:

```text
/channel attach watch
```

This marks the current group as an external space and starts in `watch` mode: incoming messages are stored for cross-chat context, but the assistant does not auto-reply in that group.

Useful external group modes:

```text
/channel watch
/channel external mention_only
/channel external auto
```

- `watch`: store the group transcript, answer questions from other spaces, do not speak in the external group.
- `mention_only`: answer direct `@bot_username` mentions and replies to the bot.
- `auto`: also answer obvious work/request triggers without a direct mention.

Add aliases so the owner can ask about a chat naturally from another space:

```text
/channel alias add AI-Duck Advertising
/channel alias add реклама
```

Inspect attached groups from any owner space:

```text
/channel list
/channel status
```

To disconnect the group from assistant routing:

```text
/channel detach
```

## Core Capabilities

### Structured Memory

Open PiPi uses structured memory instead of a vector database:

- `memory sprint`: the current hot context window for a space
- `recollections`: compacted summaries of older context
- `searchable history`: raw transcripts remain in SQLite for recall and audit

Memory is scoped by `space` first. DMs, groups, channels, and email threads get separate hot memory, work notes, diary entries, and recollections. Person memory can still be global when it is genuinely portable, but chat-only personal notes are bound to the source space.

Legacy memory tables (`resident_notes`, `daily_insights`, and `house_diary`) carry `chat_jid` plus `scope`. Existing rows without those fields are treated as `global`; scoped rows are only recalled in their matching chat. Weekly memory compaction walks all active spaces, so DMs keep their long context too.

The point is simple: keep memory inspectable and practical.

### Artifacts

Artifacts are durable, structured documents attached to a space. They are useful when the assistant should keep working on something across many turns instead of improvising from scratch every time.

Supported kinds:

- `plan`
- `walkthrough`
- `task_list`
- `code`
- `diff`
- `logs`
- `review`
- `handoff`

Useful behavior:

- active `plan` and `task_list` artifacts are injected back into prompt context
- older artifacts of the same rotating kind are archived automatically
- artifact writes are scoped to the current space, so cross-space edits do not leak
- `artifacts_copy_to_space` copies an artifact to another space for cross-project coordination; `artifacts_list_other_space` lists artifacts in a different space (read-only)
- long plans, research notes, reports, decision memos, meeting notes, simple kanban boards, and premium day-planning visual dashboards (`agent_plan`) can be rendered as HTML pages with `html_artifact_create`
- the `office` pack can draft a shareable kanban board with `office_kanban_board`, then publish it as a `kanban_board` HTML artifact
- `task_board_generate` creates a stable-URL task board page that auto-refreshes every 60 seconds; the board is also regenerated automatically when tasks are created, paused, resumed, or cancelled
- if `PIPI_PUBLIC_BASE_URL` is set, HTML artifacts are returned as public links; otherwise Telegram falls back to attaching the `.html` file to the chat


### Timeline And Journal

The runtime also keeps a timeline of structured events per space. From that, PiPi derives daily `journal_day` artifacts automatically.

Useful commands:

- `/today`
- `/yesterday`
- `/week`

This is handy for continuity without dumping raw transcript sludge back into the prompt.

### Safe Tool Execution

Riskier pack tools can run through `sandboxd`, an isolated Docker-backed runner. That keeps tool execution and file operations away from the host process while still letting the assistant do real work.

Two risky action classes currently require explicit consent:

- `browse_web`
- `deep_research`

Consent is intentionally KISS:

- one pending approval per `space + user + action class`
- a natural `да` or `yes` only resolves when exactly one approval is pending
- when more than one is pending, use `/approve <action>` or `/deny <action>`

### Skills

The runtime includes a shared skill layer. Packs decide which of these are enabled in practice.

Organization and follow-through:

- `todos`
- `reminders`
- `tasks`
- `rituals`
- `projects`

Context and recall:

- `memory`
- `history`
- `journal`
- `grounding`
- `members`
- `spaces`

Research and browsing:

- `browsing`
- `webrun`

Workspace and outputs:

- `workspace`
- `artifacts`
- `html_artifacts`
- `workflows`

Operator and improvement loop:

- `pipi_setup`
- `atelier`

## Architecture

```text
Telegram ─┐
Web/PWA  ─┼─▶ Transport Adapter ─▶ Message Gateway ─▶ Space ─▶ Agent
Discord  ─┤                             │                       │
WhatsApp ─┤                             ├── Pack                │
Gmail    ─┘                             ├── Grounding           │
                                        ├── Memory              │
                                        └── Skills / Tools      │
                                                                ▼
Telegram ◀─┐                                                 Outbox
Web/PWA  ◀─┴── Transport Adapter ◀── Delivery Worker ◀──────────┘

Optional sidecars:
  -> sandboxd
  -> Ollama
  -> Chromium CDP
```

Each inbound message takes one path, whatever carried it: normalize → drop replays → resolve the binding to a space → resolve the sender to a participant → check permissions → persist → run the agent. No transport has its own agent flow, and no transport SDK reaches past its own adapter — a test reads the source tree and fails if one does.

Key files:

- `src/index.ts`: bootstrap, transport registration, scheduler startup
- `src/api.ts`: HTTP server — web client, tool-log API, OAuth callback
- `src/transports/types.ts`: the narrow waist every transport translates into
- `src/transports/telegram/`: normalizer, renderer, capabilities, adapter
- `src/transports/web/`: the web transport's outbound half
- `src/gateway/message-gateway.ts`: the one inbound pipeline
- `src/gateway/binding-resolver.ts`: endpoint → space
- `src/gateway/participant-resolver.ts`: external account → participant
- `src/gateway/outbox.ts` + `delivery-worker.ts`: durable outbound delivery
- `src/web/`: local accounts, sessions, HTTP routes, activity stream
- `src/core/agent-kernel.ts`: materializes the active pack and execution context
- `src/core/space-behavior.ts`: pins pack and grounding snapshots per space
- `src/core/context-composer.ts`: assembles prompt context with budgets and guards
- `src/core/llm.ts`: Gemini/Ollama orchestration and tool loop
- `src/core/pack-loader.ts`: loads installable packs from disk
- `src/core/runtime-backup.ts`: full runtime restore points and manifests
- `src/db.ts`: SQLite schema and persistence
- `src/sandboxd.ts`: isolated tool execution service
- `src/observability.ts`: OpenTelemetry bootstrap and metrics helpers

## Model Runtime And Observability

Model setup:

- `Gemini` is the primary cloud model path
- The chat runtime now supports an `executor + advisor` pattern:
  the executor handles the full turn, and can consult a stronger advisor model on demand for difficult planning forks
- `Ollama` is the local fallback

Useful env vars:

- `GEMINI_API_KEY`
- `GEMINI_EXECUTOR_MODEL`
- `GEMINI_ADVISOR_MODEL`
- `PIPI_ADVISOR_ENABLED`
- `PIPI_ADVISOR_MAX_CALLS_PER_TURN`
- `OLLAMA_URL`
- `OLLAMA_MODEL`
- `PIPI_LOCAL_ROUTING_ENABLED` (defaults to `true`; safe fallback routes uncertain messages to Gemini)

OpenTelemetry is opt-in. It starts only if one of the OTLP env vars is configured:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`

Useful related vars:

- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_METRIC_EXPORT_INTERVAL`
- `OTEL_DIAGNOSTIC_LOG_LEVEL`
- `OTEL_ENABLED=false`

The runtime instruments HTTP/Express work plus domain spans around routing, LLM calls, and tool execution.

### Read-only Tool Logs API

If you want to inspect tool calls over HTTP, enable the small read-only API:

```dotenv
PIPI_API_HOST=127.0.0.1
PIPI_API_PORT=3101
PIPI_API_TOKEN=change-me
```

Security note:

- this API exposes tool args, result payloads, and errors
- bind it to localhost unless you intentionally proxy it
- bearer auth is required for every `/api/*` route

Available routes:

- `GET /health` — unauthenticated liveness probe
- `GET /api/tool-logs` — paginated log query with filters and summary
- `GET /api/tool-logs/:id` — fetch one full log row including `args_json` and `result_text`

Auth:

```bash
Authorization: Bearer <PIPI_API_TOKEN>
```

Supported query params for `GET /api/tool-logs`:

- `space_id`
- `task_id`
- `tool_name`
- `status`
- `q` — substring search across tool name, args, result, and error
- `started_after`
- `started_before`
- `limit` — defaults to `50`, capped at `200`
- `offset`

Example:

```bash
curl -H "Authorization: Bearer $PIPI_API_TOKEN" \
  "http://127.0.0.1:3101/api/tool-logs?tool_name=browse_web&status=error&limit=20"
```

Response shape:

- `filters` — normalized filters actually applied
- `page` — `total`, `limit`, `offset`, `has_more`
- `summary` — aggregate counts by status and top tools
- `items` — matching rows from `tool_logs`

### Google Docs And Sheets OAuth

The `office` pack can read private Google Docs and read/write Google Sheets when a Telegram owner connects Google Drive for that space.

Setup:

1. In Google Cloud Console, create an OAuth 2.0 client of type `Web application`.
2. Enable the Google Drive API, Google Docs API, and Google Sheets API.
3. Add your public callback URL as an authorized redirect URI, for example `https://yourserver.example.com/oauth/google/callback`.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` in `.env`.
5. In Telegram, run `/gdrive auth` from the target space and approve access.

The OAuth callback is intentionally public so Google can redirect to it, but it uses a short-lived one-time state nonce stored in SQLite. Tool access stays scoped per space.

## Config Cheat Sheet

### Core Runtime

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Primary Telegram bot token |
| `GEMINI_API_KEY` | Primary cloud model key |
| `GEMINI_EXECUTOR_MODEL` | Main Gemini model used for user turns and tool loops |
| `GEMINI_ADVISOR_MODEL` | Stronger Gemini model used only for internal strategy consultations (default: `gemini-3-pro-preview`) |
| `PIPI_ADVISOR_ENABLED` | Enables the internal advisor consultation tool for the executor |
| `PIPI_ADVISOR_MAX_CALLS_PER_TURN` | Hard cap on advisor consultations during one user turn |
| `PIPI_LOCAL_ROUTING_ENABLED` | Uses a fast local classifier for ambiguous routing and relevance-based group participation |
| `OWNER_TG_IDS` | Comma-separated Telegram owner IDs |
| `OWNER_IDENTITIES` | Comma-separated channel-qualified owner IDs |
| `BOT_DISPLAY_NAME` | Name the assistant introduces itself with (default: `PiPi`) |
| `BOT_NAME_ALIASES` | Extra comma-separated group-mention names on top of the defaults |
| `HOUSEHOLD_CHAT_ID` | Optional primary Telegram group anchor |
| `BOOTSTRAP_OWNER_MODE` | Temporary first-run fail-open mode |
| `BOOTSTRAP_PACK` | Default assistant pack ID from bootstrap |
| `BOOTSTRAP_GROUNDING` | Default grounding ID from bootstrap |
| `DATA_DIR` | SQLite and runtime data directory |
| `TZ` | Scheduler and date formatting timezone |
| `PIPI_PLATFORM` | Runtime profile: `auto`, `raspberry_pi`, `generic` |

### Optional Read-only API

| Variable | Purpose |
| --- | --- |
| `PIPI_API_HOST` | Bind host for the read-only API (recommended: `127.0.0.1`) |
| `PIPI_API_PORT` | Enables the read-only API when set to a port greater than `0` |
| `PIPI_API_TOKEN` | Bearer token required for `/api/*` requests |
| `PIPI_PUBLIC_BASE_URL` | Optional public base URL for shareable `/html/*` and `/briefs/*` pages; without it, Telegram receives HTML files as attachments |

### Google Docs And Sheets OAuth

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Web application client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Web application client secret |
| `GOOGLE_OAUTH_REDIRECT_URI` | Public callback URL, usually `https://<host>/oauth/google/callback` |

### Channel Adapters

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_ENABLED` | Enable WhatsApp adapter |
| `WHATSAPP_PRIMARY_GROUP_JID` | Optional WhatsApp primary group |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_CHANNEL_ID` | Primary Discord channel |
| `CONCIERGE_SMTP_HOST` | SMTP host for Gmail mode |
| `CONCIERGE_SMTP_PORT` | SMTP port |
| `CONCIERGE_SMTP_USER` | SMTP username / mailbox |
| `CONCIERGE_SMTP_PASS` | SMTP password / app password |
| `CONCIERGE_FROM_NAME` | Display name for outbound email |
| `GMAIL_IMAP_HOST` | IMAP host |
| `GMAIL_IMAP_PORT` | IMAP port |
| `GMAIL_IMAP_USER` | IMAP username |
| `GMAIL_IMAP_PASS` | IMAP password / app password |
| `GMAIL_IMAP_POLL_MS` | IMAP poll cadence |

### Sandbox, Browser, And Other Advanced Knobs

Most setups can ignore these until they need them:

- `SANDBOXD_URL`
- `SANDBOXD_TOKEN`
- `SANDBOX_PACK_PROJECT_ROOT`
- `SANDBOX_WORKSPACE_ROOT`
- `SANDBOX_WORKSPACE_CONTAINER_ROOT`
- `SANDBOXD_ALLOWED_IMAGES`
- `SANDBOXD_MAX_IN_FLIGHT`
- `SANDBOXD_MAX_TIMEOUT_MS`
- `SANDBOXD_MAX_MEMORY_MB`
- `SANDBOXD_MAX_TMPFS_MB`
- `SANDBOXD_MAX_CPU_LIMIT`
- `CHROMIUM_CDP_URL`

## Backups, Restore Points, And Recovery

Open PiPi treats `DATA_DIR` as the canonical runtime state. If you want continuity, that directory is the thing to protect.

What lives there:

- SQLite data
- channel auth state such as WhatsApp sessions
- per-space pack + grounding snapshots
- restore points in `DATA_DIR/backups/*`

How restore points work:

- scheduled and manual restore points save the full runtime payload, not just the database
- each restore point includes a manifest with version, counts, file hashes, and warnings
- a `latest healthy restore point` is created on successful startup so there is always one boring, sensible place to roll back to
- restoring into the live `DATA_DIR` automatically creates a `pre_restore` backup first

Useful operator flows:

- `pipi_backup_status`: inspect the latest restore point and latest healthy restore point
- `pipi_backup_now`: create a manual restore point from inside the assistant

Useful shell commands:

```bash
pnpm backup:restore latest-healthy --force
pnpm backup:restore latest --force
pnpm backup:restore backup-2026-04-02T03-12-00-000Z --target-dir ./data-restored
```

Practical notes:

- if your `DB_PATH` points outside `DATA_DIR`, PiPi still backs it up, but restore places it under `__external_db/` inside the payload
- copying `DATA_DIR/backups/<backup-id>` off the machine gives you a portable recovery pack for server moves or dead-box days
- a backup on the same dead box is mostly a memoir, so off-device copies are still the grown-up move

## Development

Package-manager hygiene:

- use `pnpm` in this repo, not `npm`
- if you previously installed with `npm`, wipe `node_modules` before reinstalling with `pnpm`
- keep `pnpm-lock.yaml` as the single lockfile
- use `pnpm install --no-optional` only for lean Telegram-only runtime installs
- for development and CI-like local verification, prefer the full `pnpm install`

Useful scripts:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start local development runtime |
| `pnpm build` | Compile TypeScript and copy packs / groundings |
| `pnpm typecheck` | TypeScript validation |
| `pnpm lint` | ESLint |
| `pnpm lint:fix` | ESLint autofix |
| `pnpm format` | Prettier write |
| `pnpm format:check` | Prettier check |
| `pnpm test` | Full Vitest suite |
| `pnpm test:coverage` | Coverage run |
| `pnpm test:smoke` | Smoke flow |
| `pnpm test:evaluator` | Minimal operational evaluator |
| `pnpm test:watch` | Watch mode |
| `pnpm verify` | Complete local quality gate |
| `pnpm release:check` | Quality gate plus high-severity production dependency audit |
| `pnpm bootstrap` | Description to grounding bootstrap flow |
| `pnpm content:check` | Validate installable packs and groundings |
| `pnpm content:new` | Scaffold a pack or grounding without overwriting content |
| `pnpm setup:check` | Read-only first-run and configuration diagnostics |
| `pnpm backup:restore` | Restore a runtime backup by id, path, `latest`, or `latest-healthy` |

## Current Direction

The repo is intentionally moving toward:

- one shared assistant kernel
- one shared space model
- multiple channel adapters with different UX depth
- packs as the swap-in product layer
- artifacts and journal as first-class continuity tools

The bias is toward clarity and hackability, not toward preserving every abstraction forever.

## Contributing

Contributions are welcome:

- read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and expectations
- read [RELEASING.md](RELEASING.md) before creating a release
- check issues labeled `good first issue` for approachable starting points
- report vulnerabilities privately via [SECURITY.md](SECURITY.md), not in public issues
- be kind; the [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere in this repo

Before opening a PR, run `pnpm verify` — CI enforces the same quality gates.

## License

MIT
