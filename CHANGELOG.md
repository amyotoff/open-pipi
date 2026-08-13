# Changelog

All notable changes to Open PiPi will be documented in this file.

## [Unreleased]

### Added

- One install now has one **shared wiki** — one household, department or office, one body of
  knowledge. A page saved in any chat is found from every other chat, a brand-new space reads it
  with no setup, and a newly attached pack or agent inherits it through the ordinary context
  composer. No new tables, no workspace model, no permission system: the scope a write lands in is
  a single flag.
- `wiki_save` writes a page into the shared wiki and `wiki_capture_documents` files a batch of
  already-converted documents into it — the socket a PDF-to-text step plugs into, with one
  confirmation for the whole batch. Conversion stays outside the runtime, which has to fit on a
  Raspberry Pi.
- PiPi can propose a save itself. That is the same path: it decides what is worth keeping, the
  owner decides whether it is kept. Writes to the shared wiki always ask first, which is what makes
  a page everyone can read a decision somebody made rather than a side effect of a conversation.

### Changed

- Anything the assistant files on its own initiative stays in the chat it came from, as do pages
  written before the wiki became shared. Reads check the shared wiki first and fall back to the
  chat's own pages, so nothing is stranded and nothing needs migrating. Search marks a page that is
  visible in one chat only.
- The shared wiki is ingested and linted once for the install rather than once per space.
- Memory is untouched: it stays per person and per chat. "Remember this" still means this chat;
  "save this to the wiki" means the household.

- `brain_capture` and `list_raw_sources`: a link, document or pasted text is filed into an
  immutable `raw/` collection and queued for compilation. Capture is synchronous and always
  succeeds; the compilation that follows is a background job, because a single source can touch
  a dozen wiki pages and a chat turn has neither the tool budget nor the latency for that.
  Re-capturing the same content returns the existing file instead of writing a near-duplicate.
- Queued sources are now compiled. A background job triages each one against the index on the
  cheap model — deciding whether it is new, an update, a contradiction, or adds nothing at all —
  and passes the ones that carry material to the stronger model, which merges them into pages
  and patches the affected sections of everything else. That is the point of the pattern: a
  source is compiled once, when it arrives, instead of raw documents being re-read and
  re-derived on every question. `docs/brain-wiki-plan.md` records the design and the decisions.
- `wiki_search`, `wiki_answer` and `wiki_archive`: the wiki answers questions with citations,
  and a good answer can be filed back as a snapshot page so explorations compound instead of
  disappearing into chat history. A capped `[WIKI]` block of index rows — never page bodies —
  also rides along in ordinary turns beside the memory blocks, which is what makes a knowledge
  base worth keeping rather than a filing cabinet nobody opens.
- `wiki_lint`, on the memory-sprint cadence: repairs index entries and broken links, checks that
  every number, date and quote on a page still appears in the raw source it links, and reports
  contradictions, orphans, malformed status blocks and stale archives. Bookkeeping is fixed
  automatically; facts are only ever reported, because a machine that counts should not be
  rewriting claims.
- `src/brain/schema.md`, the wiki's schema layer, with `wiki_schema` to read it and
  `wiki_schema_set` (owner approval required) to replace it per space. The conventions used to
  live in tool descriptions, where the owner could not change them and they cost tokens on every
  turn whether or not the wiki was touched.
- Contradictions are annotated, never overwritten. A superseded claim keeps its place under a
  `Status: Outdated` or `Status: Disputed` block, so the wiki cannot quietly change its mind.
- Wiki pages do not cross spaces. A page compiled inside a chat is visible to that chat, a fact
  disclosed privately stays in scoped memory, and promotion to the host-level wiki is an explicit
  owner decision — the one property that would have been painful to retrofit.

### Changed

- `wiki/` is one level of topic directories. Entity pages nested under `wiki/entities/<kind>/`
  move up on the next start, after which every page resolves a raw link the same way.
- `wiki/index.md` is generated from the index and `wiki/log.md` is append-only, so the wiki is
  browsable in Obsidian or on GitHub while the assistant queries SQLite. The log keeps the
  grep-able `## [date] action | subject` heading, which is how the assistant learns cheaply what
  it did recently.
- The Brain Layer's SQLite index is now explicitly a disposable cache: deleting it and rebuilding
  from markdown produces a byte-identical result, enforced by a test. That invariant is what lets
  the wiki be an ordinary git repo with ordinary history, and what makes restore points restore.
- A missing or outdated Brain index rebuilds itself from markdown on the next open, rather than
  reading as an empty wiki until something happens to ask for a rebuild. A rebuild that fails
  leaves the stored schema version untouched, so the next open tries again instead of serving an
  empty index that reports itself as current.
- Owner-only wiki pages are unreadable by path, not merely absent from search results. Knowing a
  page's path was previously enough to read it.
- `promote_note_to_wiki` compiles a note into the page it belongs on. It used to append the note
  verbatim under a "Promoted Notebook Notes" heading, which produced a scrapbook rather than a
  compiled page. When no model is available the old behaviour still runs, but the page is marked
  `needs_review` so lint can find it — a visible fallback rather than a silent one.
- A page is only ever replaced wholesale when the model was shown all of it. Long pages are
  patched section by section instead, and a source larger than one compile pass is refused
  outright — compiling half a source and recording it as done is how a wiki acquires confident
  gaps.
- A compile plan that overflows the per-job cap re-queues for a continuation pass instead of being
  trimmed to it, and gives up after three passes rather than looping. Each list is checked against
  its own cap, so a plan that fits in total cannot still lose its ninth page.
- Triage refuses an oversized source rather than judging it from the first 24K, so a long source
  can no longer be closed as "no material" on the strength of its opening.
- Lint verifies the provenance the compiler actually writes. Sources are recorded in frontmatter,
  which the link index previously ignored, so every compiled page was reported both as unverifiable
  and as an unreferenced source.
- Repairing a dead cross-reference removes the link, not the line it sits on. It used to take the
  surrounding sentence and any healthy links with it.
- Archived answers never overwrite an existing page — not an earlier snapshot of the same question,
  and not a canonical article whose title happens to slugify the same way.
- Replacing a space's wiki schema requires being that space's owner. Approval is the caller
  consenting to their own action; it is not authorisation.

- Voice calls, as the first optional addon (`src/addons/voice-calls`): delegate an outbound phone
  call to a voice agent and get a structured result back. Three gates stand in front of it — the
  pack must enable the `phone` capability, a provider must be configured, and the owner must approve
  the individual call — and all three are shut by default. The telephony SDK is not a dependency of
  this repo; anyone turning calling on installs it themselves, so an install that never calls
  carries nothing.
- Approval prompts now name the arguments that change the decision. `browse_web` shows the URL and
  `delegate_phone_call` shows the number — previously an owner was asked to approve a *category* of
  action, which is not something anyone can meaningfully agree to.
- `PIPI_DAILY_CALL_LIMIT` and `PIPI_CALL_ALLOWED_COUNTRIES`: calls bill on a meter the runtime
  cannot see, so their ceiling is a count rather than a cost. Counted before dialling, so a crash
  loop cannot dial without bound.
- `docker-compose.dev.yml` works again. It ran `npm run dev` against the production image, which is
  built with `pnpm prune --prod` and therefore has neither `nodemon` nor `ts-node` — and, since the
  image stopped shipping npm, not even a way to try. The Dockerfile gained a `dev` target that keeps
  devDependencies, and CI now builds it so this cannot rot unnoticed again.
- `docs/addons.md`: what makes something an addon, and how to write a **subagent** — a delegate that
  runs where the orchestrator cannot supervise it, briefed with a task contract and answering with a
  result contract. The voice addon is the worked example.
- Optional Home Assistant addon and Jeeves `home_operator` subagent for exact-allowlisted reads and
  `light`/`switch` actions on a local Home Assistant instance. Existing pinned Jeeves spaces can
  explicitly refresh their installed pack with `/pack mutate jeeves`.

### Security

- Physical Home Assistant actions require a host owner to approve one exact canonical call. The
  approval is single-use, resumes without asking a model to reconstruct its arguments, and is
  revalidated against the current pack, policy, owner role, and entity allowlist before execution.
- Smart-home tool inputs reject unknown fields and arbitrary services, URLs, targets, and service
  data; tokens remain adapter-only and sanitized entity state is treated as untrusted device data.
- The production `undici` override now requires `7.29.0` or newer, resolving
  `GHSA-4cwx-7wf7-3272` inherited through `discord.js`.

## [2.6.0] — 2026-07-29

Transports become replaceable. A `space` already owned behavior, memory, and permissions; this
release finishes the thought by making every way *into* a space — Telegram, a browser, Discord,
WhatsApp, Gmail — a translation layer with no opinion about what happens next.

Nothing needs reconnecting. Existing chats keep working, the database migrates itself on first
boot, and every space keeps its pinned pack and grounding.

### Added

- Transport gateway: Telegram, Web, and future channels are replaceable transports behind one
  narrow waist, enforced by a test that reads the source tree.
- `transport_bindings` and `participant_identities`: a space can be reached from several places at
  once, and one person can hold an account on each of them.
- Durable outbox with an in-process delivery worker — retries with backoff, bounded attempts, FIFO
  per conversation, and resumption after a restart.
- Local web client (`PIPI_WEB_ENABLED`): sign in, read the spaces you belong to, send. Accounts are
  linked to an existing participant with `pnpm web:account`, so a web login arrives as the same
  person as their Telegram account. Off by default, loopback-only unless an account exists.
- Owner dashboard in the web client: health and wiring, every space and what decides how it
  behaves, stuck deliveries with their errors, the Brain Layer wiki, and memory. Owner-only, and
  answers `404` to everyone else so its existence stays quiet.
- Dashboard writes: a space's mode, pack and grounding can be changed, a space archived or
  restored, and a failed delivery given its attempt budget back. Each is validated against the
  same list the UI offers, and logged with who did it.
- Budget block on the dashboard overview: today's spend against the limit that trips the
  killswitch, plus a breakdown by model and by space. `token_usage` gained a `space_id`, and the
  LLM path attributes spend to the space whose turn it is. Local models are counted at zero rather
  than priced by guess, and work belonging to no conversation is reported as unattributed rather
  than folded into some space's bill.
- `PIPI_DAILY_COST_LIMIT_USD` makes the daily spend ceiling configurable. It was a constant in
  `healthcheck.ts`, so the only way to raise it was editing the source — and $3/day is a sensible
  default for a household on a Pi and a useless one for anything else. A missing or nonsensical
  value keeps the $3 default rather than removing the ceiling.
- README documents the cost ceiling at all. The assistant hard-stops when the day's spend crosses
  the limit, which is deliberate but surprising if you do not know it is there.
- `docs/transports.md`: how to write an adapter without touching Core.

### Fixed

- Replies longer than Telegram's 4096-character limit were lost entirely; they are now split, with
  each piece measured after formatting.
- A redelivered Telegram update ran the agent twice and answered twice.
- Attachments were downloaded before the sender's permissions were checked.
- A stranger writing in an unknown group could cause a space to be created.
- Shutdown stopped the Telegram bot twice, logging an error on every clean exit.
- The dashboard shredded tables in a narrow window — `overflow-wrap: anywhere` on every cell also
  shrinks each column's min-content width, so instead of widening into its scroller the table broke
  words one letter per line, leaving a "Retry" button 104px tall.
- `src/web/routes.test.ts` raced the server: it slept a fixed interval hoping an SSE client had
  subscribed, which under coverage instrumentation sometimes published to nobody. It now waits on
  the subscription itself, which removes an intermittent `pnpm verify` failure.

### Changed

- `SendResult.success` now means *accepted for delivery* rather than *delivered*; delivery outcomes
  are in the outbox and the delivery logs.
- Replies address the space rather than the endpoint a question arrived on, so a conversation open
  on two surfaces stays in sync on both.

### Security

- The production container no longer ships npm or corepack. The runtime only ever runs
  `node dist/index.js`, and npm vendors its own dependency tree, which was the source of the
  image's advisories (`CVE-2026-59873` in npm's bundled `tar` being the current one).
- `sharp` moved to `^0.35.3`, past the inherited libvips advisories `CVE-2026-33327`,
  `CVE-2026-33328`, `CVE-2026-35590`, and `CVE-2026-35591`.
- Brief and artifact share URLs carry 128 bits of entropy rather than 32.

### Known limitations

- The web send route answers `202` and then runs the agent, so a crash in that window loses a
  message that nothing redelivers. Every *outbound* message is durable; this one inbound step is
  not yet.

## [2.5.0] — 2026-07-12

### Product

- Simplified the Telegram menu around `/today`, `/tasks`, `/help`, and `/setup`.
- Added one-tap daily Brief, Focus, and Review actions plus safe task Run, Pause, and Resume controls.
- Added a one-tap recommended setup flow and clearer natural-language onboarding.

### Extensibility

- Unified skill and pack-tool registration while reducing the model-facing tool surface.
- Added strict pack and grounding validation through `pnpm content:check`.
- Added non-destructive pack and grounding scaffolding through `pnpm content:new`.

### Reliability And Open Source

- Centralized risky-tool approvals and strengthened release, secret, dependency, container, and coverage gates.
- Added read-only first-run diagnostics through `pnpm setup:check`.
- Removed private deployment assumptions, documented contributor and release workflows, and aligned repository metadata.
- Cleaned production build artifacts, excluded tests from `dist`, and blocked accidental npm publication.
- Made both production container images use the locked pnpm dependency graph.
- Updated vulnerable production dependencies and made high-severity advisories fail the release gate.
- Added a credential-free first-run setup smoke check to clean CI installs.

## [2.1.0] — 2026-03-30

### Runtime

- **Node.js 24 LTS** — migrated from Node 20 (EOL April 30, 2026) to Node 24 Active LTS
- **ES2024 target** — TypeScript compilation target bumped to es2024
- **Docker images** — all Dockerfiles and compose defaults now use `node:24-slim`
- **CI matrix** — build matrix updated to `[22, 24]`; security job runs on Node 24
- **Sandbox default** — `DEFAULT_SANDBOX_IMAGE` updated to `node:24-slim`

### Security

- **path-to-regexp** — patched ReDoS via sequential optional groups (high)
- **nodemailer** — patched SMTP command injection via `envelope.size` (low)
- **picomatch** — patched method injection and ReDoS in POSIX char classes (high)
- **undici** — patched 6 CVEs including HTTP smuggling, memory exhaustion, CRLF injection (high) via `overrides`

### Dependencies

- `@google/genai` → `^1.47.0`
- `better-sqlite3` → `^12.8.0`
- `nodemailer` → `^8.0.4`
- `@types/node` → `^25.5.0`
- `vitest` → `^4.1.2`
- `typescript-eslint` → `^8.58.0`

## [2.0.0] — 2026-03-24

Initial open source release.

- **Skill system** — modular architecture with 16 built-in skills
- **Multi-channel** — Telegram (primary), Discord, Gmail, WhatsApp outbound
- **Atelier** — skill request system with inline Telegram buttons and voting
- **LLM** — Gemini 2.5 Flash primary, Ollama local fallback, offline light control
- **Packs** — installable assistants such as Jeeves, Office, Reporter, and Tutor
- **Memory** — resident profiles, habits, conversation history with auto-consolidation
- **Security** — shell command allowlist, Docker hardening, access control by Telegram ID
- **Architecture inspired by** [NanoClaw](https://github.com/qwibitai/nanoclaw)
