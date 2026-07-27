# Web Send, Hardening, and the Owner Dashboard — the plan after the audit

Status: proposed
Baseline: `agent/web-client-readonly` (Phases 1–5 delivered, `pnpm verify` green, 627 tests)
Predecessor: [transport-gateway-plan.md](transport-gateway-plan.md) — architecture decisions
D1–D12 still stand; this document re-plans what remains in their light.

Priorities unchanged: **KISS → reliability → open-source legibility.**

---

## 1. Audit results

What a fresh read of the branch found, and what each finding means for the plan.

| Finding | Verdict | Where it lands |
| --- | --- | --- |
| `pnpm audit` reports one **high** CVE: `sharp` < 0.35 via `@whiskeysockets/baileys` (optional WhatsApp dep) | **Pre-existing on `main`**, not introduced by this branch. `release:check` fails on both branches equally. | Separate chore PR: bump baileys / add pnpm override. Not blocking the transport PRs, but blocking any *release*. |
| Generic sends record `endpoint_type: 'direct'` in outbox rows even for groups | Data-quality only — nothing branches on it today. `sendSpaceMessage` already records it correctly. | One-line fix rides with Phase 6, which touches that function anyway. |
| Typing indicator bypasses the outbox | Correct by design: a typing hint delivered late is worse than none. | No action; documented here so it stops looking like an oversight. |
| Live Telegram has never been exercised — every smoke test fakes the wire | The one genuinely open risk. Telegraf middleware order depends on import order and only a real bot proves it. | **Merge gate for PR 1**, spelled out in the PR description. |
| Reading APIs the dashboard needs (brain, memory, health, outbox, topology) | All already exist with tests. The dashboard is a read layer plus a handful of DB-backed writes — no new engine. | Shapes Phase 8's size: small. |
| `sendChannelMessageNow`, `purgeExpiredSessions`, `disableWebAccount` have one non-test caller or none | Deliberate API surface, each with a stated reason (refusals, housekeeping, operator action). | `purgeExpiredSessions` gets wired to the scheduler in Phase 7. |

---

## 2. Phase 6 — Web send + live updates (re-designed)

Two design questions surfaced while building Phase 5 that the original plan glossed over.
Both get decisions now, before the code.

### D13 — A member sending into a space *is* the web binding's creation event.

The binding resolver refuses to bootstrap spaces for `web` (a stranger must not conjure
rooms). But a signed-in **member** posting into a space they already belong to is not a
stranger — membership is the authorization. So:

- `POST /api/spaces/:id/messages` verifies membership (as the read routes do), then
  `ensureTransportBinding({ transport: 'web', endpointId: space.id, endpointType, spaceId })`
  lazily on first send.
- The web endpoint id **is the space id**. Web has no external chat namespace, so inventing
  one would be a second name for the same thing.
- The message then goes through `handleIncoming` like every other transport — same
  normalizer discipline (`buildIncomingMessageId('web', space.id, <uuid>)`), same dedup,
  same pipeline. No parallel agent flow, exactly as the spec demands.

### D14 — Replies fan out to every active binding of the space.

Today the butler replies to the channel a message came from. With one binding per space
that was the same thing as replying to the space; with a Telegram *and* a web binding it no
longer is — a question asked from the web would be answered only on the web, and the
Telegram side of the same conversation would go silent.

- New: `deliverToSpace(spaceId, message)` enqueues **one outbox entry per active binding**,
  idempotency key `<messageId>@<bindingId>`, so a re-run cannot double-send to any single
  binding and a failure on one binding retries without touching the others.
- The butler's reply path switches from "originating channel" to `deliverToSpace` — for
  single-binding spaces this is behavior-identical, which is the compatibility argument.
- The web transport's `send` is an SSE push to connected clients (plus the message is
  already persisted); a web binding with nobody connected is a successful no-op delivery,
  **not** a retry — the history is the source of truth and the client reads it on connect.

### SSE — cut further than the original plan.

The original Phase 6 promised `status` / `final` / `error` events. Statuses require
plumbing an event emitter through the butler; the value for a v1 is marginal. Re-cut:

- `GET /api/events` (session-scoped, spaces filtered by membership) emits one event type:
  `space_activity { space_id }` — fired on inbound accept and on delivery to a web binding.
- The client's whole contract: **on activity, refetch that space's history**. Reconnect
  needs no server state; EventSource retries natively and the client refetches on open.
- `AgentOutputEvent` stays as the declared contract (D9); producers arrive when the model
  layer streams. Nothing in this cut has to be undone later.

### PWA — as originally planned, minimal.

Manifest (name, icons, standalone) + a service worker that caches the app shell only and
shows a clear offline state. No message sync.

**Delivered.** `pnpm verify` green, 645 tests; end-to-end smoke 7/7.

Two things the implementation found, both real gaps rather than test problems:

- **A web participant failed the owner check.** It reads an env allowlist of Telegram ids,
  which a web session has nothing to do with. Fixed by `IncomingMessage.senderAuthenticated`:
  a transport that *proved* who the sender is says so, and membership then carries the
  authorization. Telegram cannot set it — a Telegram user id is only Telegram's assertion,
  which is exactly why the allowlist exists there.
- **A web login minted a second person.** `upsertWebAccount` created no identity row, so
  the resolver fell back to the string convention and produced `web:777` beside the real
  `777` — losing that participant's memory and authority, the precise failure D3 exists to
  prevent. A web account now *is* a transport identity, linked on creation.

Known limitation, stated rather than hidden: the send route answers `202` and runs the
agent after. The pipeline persists synchronously before its first await, so the window is
microseconds — but unlike Telegram, nothing redelivers a web message lost inside it.
Closing it properly means splitting persist from run, which is Phase 7 material if wanted.

---

## 3. Phase 7 — Hardening + documentation (trimmed to what remains)

Already done along the way, verified by tests: JSON body limits, graceful shutdown order,
fail-closed web bind, session hashing, path-traversal guards on served files, brief/artifact
URL entropy. What actually remains:

- Thread the inbound `correlationId` into outbox rows and delivery logs, so one turn is
  traceable end to end (`message.received` → `delivery.sent`).
- Wire `purgeExpiredSessions` into the existing scheduler (daily).
- Attachment hygiene on the Telegram download path: size cap before buffering, safe local
  filenames if we ever persist to disk (today it stays in memory).
- Docs: `docs/transports.md` (adapter author guide + skeleton from the spec §26), README
  architecture section rewrite (gateway/outbox/web), `CHANGELOG.md`, migration notes for
  operators (what the topology report means, what `pnpm web:account` does).
- The `sharp`/baileys chore PR (see audit) so `release:check` can pass again.

**Delivered.** `pnpm verify` green, 647 tests. `pnpm release:check` passes once the chore PR lands.

One thing worth recording: threading `correlationId` explicitly through three signatures was
chosen over `AsyncLocalStorage`. Three visible parameters read better than one invisible one,
and the ambient version would have to be understood by everyone who ever touches the send path.

---

## 4. Phase 8 — Owner dashboard (new scope)

> Working assumption: **"LLM wiki" = the Brain Layer** (`src/core/brain.ts`) — curated wiki
> pages plus notebook notes. If something else was meant, say so and this section adjusts.

One page for the operator: what is my assistant doing, and the few knobs that are safe to
turn. It reuses the Phase 5 session auth and the vanilla no-build client — the dashboard is
an *owner-gated view*, not a second product.

### Access model

- `/api/admin/*` requires a session **and** `participant.role === 'owner'`. A non-owner
  gets 404, not 403 — same disclosure rule as spaces.
- Every write is JSON-only (same CSRF stance) and logged via the existing `logEvent`.

### Views, mapped to APIs that already exist

| View | Reads | Writes (8b) |
| --- | --- | --- |
| **Overview** | `getHealthState`, `getSystemMetrics`, transport registry + legacy channel status, `countOutboxByStatus`, `getTransportTopologyReport` | — |
| **Spaces** | `listSpaces` (owner sees all), per-space pack / grounding / `channel_mode` / bindings | `channel_mode` (space policy), pack switch (`updateSpaceAssistantPack`), grounding switch, archive |
| **Delivery** | failed / queued outbox entries with `last_error` | re-queue a `failed` entry (reset to `queued`, attempts 0) |
| **Brain (wiki)** | wiki page list + `readWikiPage`, `searchNotes`, `listNotesByTopic` — rendered as **escaped text**, never as markup | — (editing stays in chat via the brain skill) |
| **Memory** | `getMemoryEntries` by scope, `listMemorySprints` | — |

### The honest line on settings

Bot-level settings (tokens, owners, hosts) live in `.env` and stay there: a dashboard that
edits credentials is an attack surface, not a convenience. The dashboard shows env-backed
settings **read-only with a doc pointer**, and edits only what already lives in the
database (space policy, pack assignment, bindings, outbox). If a runtime settings store is
ever wanted, that is its own design, not a side effect of a dashboard.

### Delivery order

- **8a — read-only dashboard**: all five views, zero writes. Smallest reviewable slice,
  already useful (today the only window into the runtime is `sqlite3` and logs).
- **8b — writes**: the table above. Each write gets an access test (non-owner → 404) and a
  log assertion.
- **8c — deliberately excluded**: killswitch toggle, env editing, wiki editing, memory
  editing, user management. Each is listed so its absence reads as a decision.

**Done when:** an owner can see health, spaces, delivery, wiki, and memory from a browser;
a member sees no trace of `/api/admin`; every write is logged; `pnpm verify` green.

---

## 5. PR map and sequencing

| PR | Contents | Base | Gate |
| --- | --- | --- | --- |
| **PR 1** — transport gateway foundation | Phases 1–4 (11 commits) | `main` | **Live Telegram smoke** on a test token: commands, photo, long reply split, restart with a non-empty outbox, duplicate update. |
| **PR 2** — read-only web client | Phase 5 (2 commits) + this plan | PR 1 branch | Web smoke (already scripted and passing). |
| **PR 3** — web send + SSE + PWA | Phase 6 | PR 2 | Same-space fan-out test green. |
| **PR 4** — hardening + docs | Phase 7 | PR 3 | `release:check` passes (needs the chore PR). |
| **chore PR** — baileys/sharp bump | dependency only | `main` | `pnpm audit --prod` clean; WhatsApp adapter still connects. |
| **PR 5 / PR 6** — dashboard 8a / 8b | Phase 8 | PR 4 | Owner-gating tests green. |

Merge order: chore PR any time; PR 1 → 2 → 3 → 4 → 5 → 6 in sequence, each rebased as its
base lands. Phases stay independently revertable.
