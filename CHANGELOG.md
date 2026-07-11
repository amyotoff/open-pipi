# Changelog

All notable changes to Open PiPi will be documented in this file.

## [Unreleased]

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
