# Changelog

All notable changes to Open PiPi will be documented in this file.

## [Unreleased]

## [2.6.0] — 2026-07-27

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
- `docs/transports.md`: how to write an adapter without touching Core.

### Fixed

- Replies longer than Telegram's 4096-character limit were lost entirely; they are now split, with
  each piece measured after formatting.
- A redelivered Telegram update ran the agent twice and answered twice.
- Attachments were downloaded before the sender's permissions were checked.
- A stranger writing in an unknown group could cause a space to be created.
- Shutdown stopped the Telegram bot twice, logging an error on every clean exit.

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

- The Telegram adapter has been exercised only against a faked wire — unit tests, smoke tests, and
  a scripted gateway. It has not yet been run against a live bot token.
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
