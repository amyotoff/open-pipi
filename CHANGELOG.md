# Changelog

All notable changes to Open PiPi will be documented in this file.

## [Unreleased]

### Added

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
- `docs/addons.md`: what makes something an addon, and how to write a **subagent** — a delegate that
  runs where the orchestrator cannot supervise it, briefed with a task contract and answering with a
  result contract. The voice addon is the worked example.

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
