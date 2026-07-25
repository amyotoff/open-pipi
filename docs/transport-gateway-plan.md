# Transport Gateway, Space Routing, and Local Web Client — Architecture & Delivery Plan

Status: proposed
Baseline commit: `aec3d3d` (main, clean, synced with origin)
Baseline gate: `pnpm typecheck` clean, `pnpm test` green (74 files / 481 tests)

This document finalizes the architecture for the transport rework and breaks it into
independently shippable phases. It is written against the code as it exists today, not
against an idealized repo. Every "current state" claim below was read out of the source.

Priorities, in order: **KISS → reliability → open-source legibility.** Where the spec and
those priorities disagree, this document picks the priority and says so out loud.

---

## 1. What already exists

The repo is much closer to the target than the spec assumes. Three of the seven required
pieces are already there in some form; the value is in finishing the seam, not inventing it.

| Spec concept | Current implementation | Verdict |
| --- | --- | --- |
| `Space` | `spaces` table — `id`, `kind`, `title`, `channel`, `external_ref`, `status`, `assistant_pack_id`, `grounding_pack_id`, `policy_json`. `UNIQUE(channel, external_ref)` | Exists. Transport is baked into the row **and into the id**. |
| `SpaceMembership` | `memberships(space_id, person_id, role, base_authority, reputation_delta, trust_flags_json)` + `src/core/authority.ts` | Exists, richer than the spec. **Do not build a second one.** |
| `IncomingMessage` | `IncomingChannelMessage` in [runtime.ts:10](../src/channels/runtime.ts:10) | 70% there. Missing attachments, timestamp, threadId, endpoint type, metadata. Carries a live `respond()` closure. |
| `TransportAdapter` | `OutboundChannel` in [_types.ts:35](../src/channels/_types.ts:35) | **Outbound only.** Inbound is ad hoc per channel. |
| `Participant` / `ParticipantIdentity` | `residents` keyed by `tg_id`, which stores a raw Telegram id **or** `"{channel}:{id}"` via `buildChannelPersonId` | Namespacing by string convention. No participant↔identity split. |
| `StoredMessage` + dedup | `messages(id TEXT PK, space_id, chat_jid, sender_tg_id, content, timestamp, is_bot)`, inbound id = `${spaceId}:${transportMessageId}`, `ON CONFLICT(id) DO NOTHING` | **The idempotency key already exists.** The insert result is just never checked. |
| `Outbox` | — | Does not exist. ~15 direct `await send…()` call sites. |
| Web/PWA | `src/api.ts` — express 5, bearer auth, `127.0.0.1` default, port off by default | Server exists and has the right security defaults. No UI, no session auth. |
| Registry / lifecycle | `src/channels/_registry.ts` + `_loader.ts` — self-registering factories, env-gated, optional deps | Exists and works. Reuse it. |

### Transport leaks into core — the complete list

Only four places break the narrow waist. This is a small, tractable surface:

1. [router.ts:2](../src/router.ts:2) — imports `Context` from `telegraf`; does Telegram normalization inline.
2. [butler.ts:6](../src/agents/butler.ts:6) — imports `{ bot }` and calls `bot.telegram.getFile()` in the photo/vision path.
3. [index.ts:83](../src/index.ts:83) — parses a space id: `spaceId.startsWith('telegram:') ? spaceId.slice(...)`.
4. [db.ts](../src/db.ts) — `getRecentMessagesForSpace` uses `COALESCE(space_id, 'telegram:' || chat_jid)`; `directExternalRefForPerson` reconstructs a space id from a person id.

### Latent bugs found during analysis

These are pre-existing and get fixed as a side effect of the work; they are not new scope.

- **No Telegram message splitting.** [telegram-format.ts](../src/channels/telegram-format.ts) escapes and
  formats but never splits. Any reply over 4096 chars fails, and the plaintext fallback
  fails identically. The renderer (Phase 4) fixes this.
- **Duplicate inbound updates re-run the agent.** `storeMessage` swallows the conflict and
  returns `void`, so the caller cannot tell a replay from a fresh message. A Telegram
  redelivery today produces a second LLM run and a second reply.

---

## 2. Architecture decisions

Each decision states the call, the reason, and what was rejected. These are the parts that
are expensive to change later.

### D1 — Space ids stay opaque. Nothing may parse them.

`spaces.id` remains `"{channel}:{external_ref}"` for existing rows. New spaces get a
generated id. The format becomes **historical, not semantic**.

*Why:* `space_id` is a de facto foreign key in ~15 tables (messages, todos, shopping_list,
reminders, tasks, memberships, memory_entries, artifacts, timeline_events,
grounding_overrides, tool_logs, project_links, skill_requests, memory_sprints) and appears
at 39 call sites via `buildSpaceId`. Renumbering is a large, data-destructive migration
with zero user-visible benefit.

*Rejected:* re-keying spaces to `space_{ulid}` as the spec's `Space.id` implies. The spec's
intent — "the core must not know which transport a space came from" — is satisfied by
banning **parsing**, which is cheap and testable, rather than by rewriting ids.

Concretely: the four parse sites in §1 are removed, and a contract test forbids new ones.
`spaces.slug` is added (nullable, unique) for human-facing Web routes.

### D2 — `transport_bindings` becomes the routing source of truth; `spaces.channel` / `external_ref` are demoted, not dropped.

*Why:* one space must be able to hold a Telegram binding *and* a Web binding — that is the
whole point of the task, and the current one-transport-per-space column cannot express it.

*How:* the columns stay for one release as a read-only fallback in the resolver, so a
half-migrated database still routes. They are removed in a later release, not this one.

### D3 — `residents` **is** the Participant table. Add identities beside it; do not re-key.

`participant_identities(transport, external_user_id) → participant_id` where
`participant_id = residents.tg_id`.

*Why:* `residents.tg_id` is the `person_id` used by memberships, message authorship, memory
scoping, and the authority model. Re-keying it touches everything and risks silently
orphaning authority records — the highest-consequence data in the system.

`buildChannelPersonId` becomes the **fallback** when no identity row exists; the resolver is
the primary path. Result: one participant can hold Telegram + Web + Discord identities, and
existing rows keep working untouched. Renaming `residents` → `participants` is deferred to a
cosmetic follow-up.

*Migration safety:* identities are derived mechanically from the existing string convention
(no prefix → `telegram`; otherwise split on the first `:`). **No heuristic merging of
people.** Ambiguous rows get their own participant and a line in the migration report.

### D4 — No second permission system.

`memberships` + `src/core/authority.ts` already implement roles, base authority, reputation,
and trust flags. The spec's four-role model maps onto it directly. The gateway calls the
existing guard; it does not introduce a parallel RBAC.

### D5 — `IncomingMessage` is a superset of `IncomingChannelMessage`. The `respond()` closure leaves the agent path.

The new type adds `attachments`, `timestamp`, `threadId`, `endpoint.type`, `metadata`, and a
`correlationId`. Existing fields keep their names so the diff stays mechanical.

`respond?: (text) => Promise<void>` is a live closure over a transport SDK object. It cannot
survive a process restart, so it is structurally incompatible with a durable outbox. It is
therefore **removed from the agent path** and retained only for synchronous command replies
(`/start`, `/brief`, access-denied), which are not agent output and do not need durability.

*Consequence:* Discord and WhatsApp currently reply in-thread via `message.reply()`. Threading
is preserved by carrying `replyTo.transportMessageId` on the `OutgoingMessage` and having the
adapter re-fetch the referenced message at send time.

### D6 — The outbox is introduced at the existing send chokepoint, not at 15 call sites.

`sendChannelMessage` / `sendSpaceMessage` / `sendChannelFile` in
[runtime.ts](../src/channels/runtime.ts) keep their signatures and start **enqueuing**. A
single in-process worker drains the queue.

*Why:* this is the entire reliability win for a ~200-line diff, and every existing caller
(butler, tasks, reminders, healthcheck, sysadmin, evaluator, llm, onboarding, rituals,
html-artifacts, failure-monitor) is unchanged.

*Cost — state this in the changelog:* `SendResult.success` changes meaning from
**"delivered"** to **"accepted for delivery"**, and `messageId` becomes `outbox:<id>`.
Four call sites read `success` today:

| Call site | Impact | Action |
| --- | --- | --- |
| [onboarding.skill.ts:333](../src/skills/onboarding.skill.ts:333) | gates a "day-two note sent" flag | Fine — "accepted" is the better semantic, the outbox retries. |
| [tasks.ts:767](../src/core/tasks.ts:767) | gates `alerted_for_at` | Fine, same reason. Also gets a stable idempotency key (see D7). |
| [tasks.ts:583](../src/core/tasks.ts:583) | returns `failed:` in the task run result | Fine — enqueue failure is still a real failure. |
| [evaluator.ts:421](../src/core/evaluator.ts:421) | "Background ping" **health probe** | **Breaks.** Becomes a tautology. Must poll the outbox row to a terminal status instead. |

### D7 — Dedup reuses the key that already exists — but the key is defined by the transport, not by the resolved space.

Inbound message id: `${transport}:${endpointId}:${transportMessageId}`. This is
**byte-identical to the legacy format** — today's rows use `${spaceId}:${messageId}` where
the legacy `spaceId` *is* `${channel}:${chatId}` — so existing data needs no rewrite and
the primary key keeps doing the work.

The distinction matters once bindings exist: a binding can re-point an endpoint at a
different space. If the dedup key were derived from the *resolved* space, re-pointing a
binding would change the key and let a replayed update through as "new". Deriving it from
`transport + endpoint + external message id` (exactly the spec's idempotency key) keeps
replays dead regardless of routing changes.

`storeMessage` returns `{ inserted: boolean }`; the gateway stops when `inserted === false`.
The row is still written with the **resolved** `space_id` — which is why the authoritative
insert sits after binding resolution in the pipeline (§3), with a cheap PK existence check
up front to short-circuit obvious replays before any resolution work.

Outbound: `outbox.idempotency_key` is unique. Callers that have a natural key pass it —
e.g. a task deadline alert uses `task:${task.id}:${deadlineAt}:${alertKind}`, which makes
that alert **exactly-once by construction** instead of by config flag. Callers without one
get a generated id.

### D8 — The Web transport rides the existing express app. SSE, not WebSocket. No build step.

- **Host:** mounted onto the app in [api.ts](../src/api.ts). One express app, one listener,
  one shutdown path. When `PIPI_WEB_ENABLED=true`, the server binds
  `PIPI_WEB_HOST:PIPI_WEB_PORT` and the legacy `PIPI_API_HOST/PORT` become aliases for the
  same listener — two ports for one process is complexity with no payoff. The tool-logs API
  stays bearer-protected, so sharing the listener does not widen its exposure.
- **Mounting order is load-bearing:** [api.ts:119](../src/api.ts:119) currently applies
  `verifyAuth` to the whole `/api` prefix. Left as is, it would demand a bearer token for
  `POST /api/auth/login` — a browser can never log in. The bearer middleware is re-scoped to
  `/api/tool-logs` only; web session routes mount before it and enforce their own
  session-cookie guard. A test pins this so a refactor cannot silently re-lock the door.
- **CSRF:** `SameSite=Lax` cookie + JSON-only request bodies (reject non-`application/json`
  content types on state-changing routes). Enough for a LAN tool; no CSRF-token machinery.
- **SSE over WebSocket:** the only real-time need is server→client. SSE needs no new
  dependency, reconnects natively, and survives naive proxies. A WebSocket library would be
  a second protocol for no gain.
- **Vanilla HTML/CSS/JS, served from `src/web/public`.** No React, no Vite, no bundler.
  Adding a frontend toolchain to a Raspberry-Pi-targeted repo doubles the build surface and
  contradicts KISS harder than any other choice in this document.
- **Auth:** local accounts only. scrypt (`node:crypto`, no new dependency) → `web_accounts`;
  opaque random session token, stored hashed → `web_sessions`; `httpOnly` + `SameSite=Lax`
  cookie. No OAuth, no SSO, no JWT.
- **Fail-closed binding:** if `PIPI_WEB_HOST` is not loopback and no account exists, the
  runtime refuses to start — mirroring the existing `assertSafeStartupConfig` pattern.

### D9 — No token streaming in v1. This is a deliberate scope cut.

`processWithLLM` returns a final string; there is no event stream in the model layer, and
reworking `src/core/llm.ts` is an explicit non-goal of the spec.

v1 emits `status` (`thinking` / `running tool` / `preparing answer`) and `final` / `error`
over SSE. The `AgentOutputEvent` union is defined in full **including `text_delta`**, so the
contract does not change when streaming lands — only the producer does.

This satisfies the spec ("streaming must be a capability, not a requirement") and the
acceptance criteria, which require reading history and sending messages, with streaming
conditional. Calling this out rather than quietly shipping a fake typing animation.

### D10 — `TransportAdapter` is implemented natively for Telegram and Web. Discord / WhatsApp / Gmail are wrapped.

A `wrapOutboundChannel(OutboundChannel): TransportAdapter` shim lets the three optional
channels keep their current code and still flow through the registry and the outbox.

*Why:* rewriting four adapters at once maximizes risk on the channels with the least test
coverage and the fewest users. The narrow waist is proven by Telegram + Web (two genuinely
different transports — one push, one pull; one no-streaming, one streaming-capable), which
is exactly the spec's "must support a third without touching Core" bar.

### D11 — The boundary is enforced by a test, not by discipline.

Following the source-reading assertion pattern already used by
[repository-contract.test.ts](../src/scripts/repository-contract.test.ts),
[boundary.test.ts](../src/transports/boundary.test.ts) asserts two rules. It lives beside
the boundary it protects rather than with the release invariants, because an adapter author
is the person who needs to find it.

1. **SDK rule:** `telegraf`, `discord.js`, `@whiskeysockets/baileys`, `@hapi/boom`, and
   `nodemailer` are importable only from an explicit per-package file allowlist.
2. **Runtime rule:** modules holding a live transport connection (the Telegram bot
   singleton and its senders) are importable only from composition roots and the
   transport's own siblings — never from core, agents, or skills. This is the rule that
   catches the indirect leak, where a module imports `channels/telegram` for `bot` instead
   of importing `telegraf` itself.

Both allowlists ship in Phase 1 **already containing the current violations**, each marked
`// TODO(phase-3)`, plus an assertion pinning their exact size. Debt that is visible and
prevented from growing beats debt that is invisible. Phase 3 shrinks the lists; the test
guarantees they never grow, and the size pin forces the allowlist entry to be deleted in
the same PR that removes the violation.

### D12 — `pipi.local` / mDNS is deferred.

The spec permits this. Cross-platform mDNS is a dependency and a support burden out of
proportion to typing a LAN IP once. v1 documents the IP and the reverse-proxy option; mDNS
becomes an optional follow-up.

---

## 3. Target module layout

```text
src/transports/
  types.ts               IncomingMessage, OutgoingMessage, TransportAdapter,
                         TransportCapabilities, TransportDestination, DeliveryResult
  registry.ts            register / get / list / startAll / stopAll
  legacy-channel.ts      wrapOutboundChannel() — D10 shim
  telegram/
    adapter.ts           lifecycle + send; the only Telegram I/O
    normalizer.ts        telegraf update -> IncomingMessage
    renderer.ts          OutgoingMessage + capabilities -> RenderedDelivery[]  (splitting)
    capabilities.ts
  web/
    adapter.ts
    auth.ts              scrypt hashing, session issue/verify, login rate limit
    routes.ts            express router mounted onto the existing app
    events.ts            SSE hub
    public/              index.html, app.js, styles.css, manifest.webmanifest, sw.js

src/gateway/
  message-gateway.ts     handleIncoming() — the pipeline
  binding-resolver.ts    endpoint -> space  (transport_bindings, legacy fallback)
  participant-resolver.ts  sender -> participant + identity + membership
  participation.ts       group-reply heuristics moved out of router.ts (space policy, not transport)
  outbox.ts              enqueue / claim / complete / fail
  delivery-worker.ts     poll loop, retry policy, restart recovery
```

`src/channels/*` stays for the legacy outbound channels. `src/router.ts` becomes a
re-export shim over `src/gateway/*` for one release so existing imports and tests keep
working.

### Pipeline

```text
adapter receives external event
  -> normalize to IncomingMessage
  -> duplicate pre-check (PK lookup on the inbound key)  -> if seen: STOP
  -> resolve TransportBinding -> Space
  -> resolve ParticipantIdentity -> Participant + Membership
  -> permission / authority guard
  -> persist inbound (storeMessage) -> if not inserted: STOP   (authoritative dedup)
  -> load Space -> Pack -> Grounding -> memory/history   (unchanged: context-composer)
  -> run agent                                            (unchanged: butler + llm)
  -> OutgoingMessage
  -> outbox.enqueue
  -> delivery worker -> renderer -> adapter.send
```

Two dedup layers, one guarantee. The pre-check is a single indexed read, so a replay costs
almost nothing and does no resolution work. The **insert is the only authoritative guard**:
it needs the resolved `space_id`, so it sits after resolution — and because it always runs
before the agent, two racing deliveries of the same update still produce exactly one run.

### Binding creation policy

The spec forbids silently creating spaces for unknown endpoints, but requires keeping
Telegram's current auto-connect behavior. Both, explicitly:

- **Telegram:** an unknown endpoint keeps today's bootstrap path — space + binding are
  created on first contact, exactly as `ensureSpace` does now. No user re-onboarding.
- **Web:** rooms are created explicitly (owner action), never as a side effect of a message.
- **Other transports:** no binding → no agent run; the sender gets the existing
  access-denied/onboarding reply and the event is logged with the endpoint id, so an
  operator can create the binding deliberately.

---

## 4. Schema changes

New tables go in `createSchema()`; backfills go in `runMigrations()` — the existing
convention. All timestamps are ISO strings, matching every other table.

```sql
CREATE TABLE IF NOT EXISTS transport_bindings (
    id                   TEXT PRIMARY KEY,
    transport            TEXT NOT NULL,
    endpoint_id          TEXT NOT NULL,
    endpoint_type        TEXT NOT NULL,
    thread_id            TEXT,
    normalized_thread_id TEXT NOT NULL DEFAULT '',
    space_id             TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'active',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transport_bindings_endpoint
    ON transport_bindings(transport, endpoint_id, normalized_thread_id);
CREATE INDEX IF NOT EXISTS idx_transport_bindings_space
    ON transport_bindings(space_id, status);

CREATE TABLE IF NOT EXISTS participant_identities (
    id               TEXT PRIMARY KEY,
    participant_id   TEXT NOT NULL,          -- residents.tg_id
    transport        TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    username         TEXT,
    display_name     TEXT,
    verified_at      TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participant_identities_external
    ON participant_identities(transport, external_user_id);
CREATE INDEX IF NOT EXISTS idx_participant_identities_participant
    ON participant_identities(participant_id);

CREATE TABLE IF NOT EXISTS outbox (
    id              TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    space_id        TEXT,
    message_id      TEXT,
    transport       TEXT NOT NULL,
    endpoint_id     TEXT NOT NULL,
    endpoint_type   TEXT NOT NULL DEFAULT '',
    thread_id       TEXT,
    payload_json    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_retry_at   TEXT,
    last_error      TEXT,
    claimed_at      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    sent_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency ON outbox(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next_retry ON outbox(status, next_retry_at);

CREATE TABLE IF NOT EXISTS web_accounts (
    username       TEXT PRIMARY KEY,
    password_hash  TEXT NOT NULL,
    password_salt  TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash   TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
```

Additive columns via `runMigrations()`:

```sql
ALTER TABLE spaces   ADD COLUMN slug TEXT;                   -- + unique index where not null
ALTER TABLE messages ADD COLUMN transport TEXT;
ALTER TABLE messages ADD COLUMN transport_message_id TEXT;   -- reply threading
```

**Notes on the design.**

- `normalized_thread_id TEXT NOT NULL DEFAULT ''` exists precisely because SQLite treats
  `NULL`s as distinct in a unique index — the spec's warning, handled.
- Endpoint uniqueness is enforced across **all** statuses, not just `active`. A disabled
  binding still owns its endpoint; re-enabling is an `UPDATE`. Simpler than a partial index
  and removes a whole class of "two bindings raced" bug.
- The runtime is single-process, so claiming is a synchronous
  `UPDATE … SET status='processing' WHERE id=? AND status='queued'` with a `changes === 1`
  check. No advisory locks, no external broker.
- Restart recovery is one statement at boot:
  `UPDATE outbox SET status='queued' WHERE status='processing'`. Safe because no other
  worker can hold a claim.
- **Ordering: FIFO per endpoint, with deliberate head-of-line blocking.** The worker
  processes entries in `created_at` order grouped by `(transport, endpoint_id)`; while the
  head of an endpoint's queue is waiting for a retry, that endpoint is skipped for the
  tick. Reordered replies are worse for a conversation than late ones, and the blocking is
  bounded because retries are bounded (worst case ~36 min, then the head goes `failed` and
  the queue moves). Other endpoints are never affected.
- **File payloads reference local paths**, not blobs. Brief/HTML artifacts live under
  `DATA_DIR` and survive retries; anything transient must be copied into `DATA_DIR`
  before enqueueing. A missing file at send time is a permanent failure, not a retry.

**Retry policy:** attempt 1 immediate, then +5s, +30s, +5min, +30min; after 5 attempts →
`failed`, logged once, never retried. Bounded by construction.

---

## 5. Delivery plan

Seven phases. **Each merges independently with `pnpm verify` green.** No phase leaves the
runtime in a half-migrated state.

### Phase 1 — Contracts and the boundary test — **done** (`pnpm verify` green, 497 tests)
*No behavior change. Nothing imports the new types yet.*

- `src/transports/types.ts` — the narrow waist, plus `buildIncomingMessageId` (D7) and
  `normalizeThreadId` (§4), and the full `AgentOutputEvent` union including the
  not-yet-produced `text_delta` (D9)
- `src/transports/registry.ts` — lifecycle owner; optional transports fail soft, required
  ones abort and unwind the transports that already started
- `src/transports/boundary.test.ts` — both rules from D11, seeded with today's violations
  and a size pin

**Done when:** types compile, registry unit-tested, allowlist test green and failing on any
*new* violation — verified by temporarily adding both a `telegraf` import and a
`channels/telegram` import to a core module and confirming each rule fires.

### Phase 2 — Schema and migration — **done** (`pnpm verify` green, 511 tests)
*No behavior change at runtime. Nothing routes through the new tables yet.*

- The tables and columns in §4
- Backfill: one binding per existing space; one identity per existing resident (D3)
- Migration report surfaced at boot, naming spaces and participants that need a human
- `storeMessage` returns `{ inserted: boolean }` and records `transport` /
  `transport_message_id`

Two things the implementation found that the plan had wrong:

- **`messages.space_id` was already backfilled** by an existing migration, so that item
  was struck. The `COALESCE` fallback in the readers is therefore already redundant for any
  migrated database and can go in Phase 3.
- **The startup backfill alone leaves a hole.** A participant created *after* boot — anyone
  who first writes to the bot today — would have no identity until the next restart, so the
  Phase 3 resolver would miss them. `upsertResident` now ensures the identity inline, which
  makes "every participant has at least one identity" continuously true instead of true
  only after a restart. `splitLegacyPersonId` is the single place that knows the old
  string convention, so retiring it later is a one-function change.

**Done when:** migration runs clean on an empty DB and on a **synthetic pre-transport
database** built from the shipped v2.5.0 schema — a real operator file cannot live in the
repo, and a fixture runs on every CI job rather than once by hand; re-running is a no-op;
integrity check passes; packs, groundings, memberships, and pre-`space_id` history all
survive; no old data removed.

### Phase 3 — Telegram normalizer + gateway — **in progress**
*Behavior-preserving refactor. The largest and riskiest phase, so it lands in pieces that
each keep `pnpm verify` green.*

**Done:**

- `transports/telegram/normalizer.ts` — typed structurally rather than against telegraf, so
  it needs no SDK import and tests from plain fixtures. Decides two things Core would
  otherwise have to: chat type collapsed into the shared closed set (unknown → `group`,
  never `direct`), and whether a message was addressed to the assistant.
- `gateway/binding-resolver.ts` and `gateway/participant-resolver.ts`, with the legacy
  fallbacks intact and bootstrap policy per transport.
- `ensureSpace` now binds inline — writing the resolver tests surfaced that a space created
  at runtime had no binding until the next restart, the same hole the identity work had.

**Remaining:**

- `gateway/message-gateway.ts` + `gateway/participation.ts`; `router.ts` becomes a shim
- `transports/telegram/adapter.ts` owning the bot, calling the normalizer and the gateway
- Photo path: `bot.telegram.getFile()` moves into the adapter; butler receives a resolved
  attachment and stops importing telegraf
- Inbound dedup wired to the `inserted` flag
- The remaining space-id parse sites removed
- Boundary allowlist shrinks to `transports/telegram/**` and the size pin drops to 5

**Done when:** Telegram behaves identically (commands, groups, DMs, photos, external groups);
a test asserts a duplicate update runs the agent exactly once and replies once.

### Phase 4 — Outbox and delivery worker

- `outbox.ts` + `delivery-worker.ts`; the three `send*` functions enqueue (D6)
- Telegram renderer with **4096-char splitting** — fixes the latent bug in §1
- The four `SendResult.success` call sites handled per the D6 table
- Worker started and stopped in the existing bootstrap/shutdown path

**Done when:** tests cover retry-then-succeed, retry-exhaustion → `failed`, restart recovery
of a `queued` entry, `processing` reclaim, idempotency-key collision, long-message
splitting, and per-endpoint ordering (a retrying head blocks its endpoint but not others).

### Phase 5 — Web transport, read-only

- `web_accounts` / `web_sessions`, scrypt, session cookie, login rate limit
- Bearer middleware re-scoped to `/api/tool-logs`; web routes mounted first, with a test
  pinning the order (D8)
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`
- `GET /api/spaces`, `GET /api/spaces/:id/messages` — membership-scoped
- Static shell in `src/web/public`
- `PIPI_WEB_ENABLED`, `PIPI_WEB_HOST`, `PIPI_WEB_PORT`, fail-closed non-loopback bind (D8)
- Account CLI: `pnpm web:account -- --participant <person_id>` **links the account to an
  existing participant** — this is what makes Alex-on-web the same person as
  Alex-on-telegram, with the same memory, memberships, and authority. Without the flag a
  fresh participant is created. The multi-transport identity promise of D3 lives or dies
  on this flag existing.

**Done when:** log in from a LAN browser, see only the spaces your participant is a member
of, read history; an account linked to a Telegram participant sees that participant's
spaces. Sending is not possible yet — smallest reviewable slice that is genuinely useful.

### Phase 6 — Web transport, send + SSE + PWA

- `POST /api/spaces/:id/messages` → the **same** `MessageGateway` (no parallel agent flow)
- `GET /api/events` — SSE: `status`, `final`, `error` (D9)
- `participantId` / `spaceId` derived **server-side from the session**, never from the request body
- PWA manifest + app-shell-only service worker

**Done when:** a Web message lands in the same space as the Telegram binding, uses the same
pack and grounding, runs the agent once, and the reply appears in both Web and Telegram.
History survives a reload and a restart.

### Phase 7 — Hardening and documentation

- Body-size and attachment limits, safe attachment filenames, path-traversal guards
- Structured events: `transport.*`, `message.*`, `delivery.*`, with a correlation id
  threaded end to end
- Graceful shutdown: stop adapters → drain worker → close DB
- `docs/transports.md` (adapter author guide + skeleton), README architecture section,
  `.env.example`, `CHANGELOG.md`, migration notes

**Done when:** `pnpm release:check` passes and a third-party can write an adapter from
`docs/transports.md` alone.

---

## 6. Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Phase 3 regresses Telegram — the only production surface | **High** | Behavior-preserving refactor only, no feature work in the same PR; normalizer is pure and unit-tested against captured fixtures; `router.ts` stays as a shim so existing tests keep exercising the path. |
| Migration corrupts a live DB | **High** | Additive only; nothing dropped this release; legacy columns remain as fallback; rehearsed on a copy of a real DB; existing restore-point machinery (`runtime-backup.ts`) covers rollback. |
| `SendResult.success` semantic change silently breaks a caller | Medium | All four call sites enumerated in D6 and handled explicitly; evaluator's probe rewritten rather than left as a tautology. |
| Removing `respond()` breaks Discord/WhatsApp threading | Medium | `replyTo.transportMessageId` carried on the outgoing message; adapters re-fetch at send time; the closure survives for synchronous command replies. |
| Coverage thresholds (77% / 55% branches) fail CI on new code | Medium | Only thin I/O shells excluded, matching the existing precedent for `channels/*`: `transports/*/adapter.ts` and `web/public/**`. Normalizers, renderers, resolvers, and the outbox are pure and fully tested. |
| Web transport widens the attack surface | Medium | Off by default; loopback by default; fail-closed on non-loopback without an account; session ids stored hashed; server-side identity only; login rate-limited. |
| Scope creep into streaming / mDNS / more adapters | Medium | D9 and D12 cut them explicitly; §7 lists them as deferred with a named re-entry point. |
| Ambiguous legacy person ids produce duplicate participants | Low | No heuristic merging; each ambiguity gets its own participant plus a migration-report line for a human to resolve later. |

---

## 7. Explicitly deferred

Not in this work, with the re-entry point named:

- Token-level streaming (`text_delta`) — needs an event-emitting `core/llm.ts`; the union
  type is already defined, only the producer changes.
- mDNS / `pipi.local` — optional follow-up; LAN IP documented instead.
- Native `TransportAdapter` implementations for Discord / WhatsApp / Gmail — the D10 shim
  keeps them working; convert one at a time, when someone actually needs the capabilities.
- Renaming `residents` → `participants` — cosmetic, do it when nothing else is in flight.
- Dropping `spaces.channel` / `spaces.external_ref` — one release after Phase 3 ships.
- Bitchat, Nostr, LoRa, Matrix, Mattermost, Signal, email adapters; enterprise RBAC; SSO;
  OAuth; federation; offline mesh; plugin marketplace; any external message broker.

---

## 8. Acceptance criteria trace

| Spec criterion | Delivered by |
| --- | --- |
| Telegram runs through `TransportAdapter` | Phase 3 |
| Core does not import the Telegram SDK | Phase 3 + D11 test |
| Endpoint ↔ space via `TransportBinding` | Phase 2 + 3 |
| User ↔ participant via `ParticipantIdentity` | Phase 2 + 3 |
| One space, Telegram **and** Web bindings | Phase 6 |
| Both transports share one agent flow | Phase 6 |
| Outbound goes through a persistent outbox | Phase 4 |
| Replayed inbound does not re-run the agent | Phase 3 |
| Web client opens on the LAN, lists spaces, reads history, sends | Phases 5 + 6 |
| History and outbox survive restart | Phases 4 + 6 |
| Packs, groundings, users, chats keep working | Phases 2 + 3 |
| Tests pass, docs updated | every phase; Phase 7 for docs |
| No Redis / Kafka / Kubernetes / external DB | by construction |
