# Changelog

All notable changes to Open PiPi will be documented in this file.

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
