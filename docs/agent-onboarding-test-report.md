# Agent onboarding experiment — validation

Validated locally on 2026-09-09 with Node 25.2.1 and pnpm 10.26.2. The repository requires Node
24 or newer; GitHub CI uses Node 24. Fixtures contain synthetic context, disposable directories
under `.tmp`, and no real provider, Telegram, or user client configuration changes.

## Quality gate

`pnpm verify` passed: format, typecheck, lint, content validation, 125 test files / 1091 tests,
20 feature smoke tests, coverage thresholds, and the production build. Coverage was 82.53%
statements, 70.34% branches, 90.20% functions, and 85.14% lines. A final `pnpm build` also passed
after the client instructions were completed.

Focused checks are reproducible with `pnpm test:onboarding`. The new flow smoke runs an actual
child stdio MCP process through the official SDK `Client`, creates a preview, rejects a fabricated
MCP apply call, and confirms through the real session/Origin/CSRF-protected HTTP endpoint. It
repeats confirmation with the same key, closes the MCP process, opens a fresh process, and reads
the same saved revision. Only the unrelated setup-provider status is a synthetic adapter.

The built artifact was checked separately: all three skill/reference files matched their source
bytes; the compiled documentation handler rendered HTML; a new process running
`dist/scripts/agent-onboarding.js` completed MCP discovery and preview without writing an active
owner context. The SDK version is pinned to `@modelcontextprotocol/sdk` 1.30.0.

## Behavior covered

- Strict draft/confirmation inputs; no credential or arbitrary configuration fields.
- Preview persists only the proposal, preserves omitted optional context, and exposes exact changes.
- Hash mismatch, expired first application, changed base revision, and reused keys are rejected.
- Exact application, including explicit clearing of facts and the current task.
- Durable attempt recovery after a committed context write, including after preview expiry.
- Historical applied proposals report when current context has subsequently changed.
- Private pages require the existing session; GET never saves; confirmation requires Origin and CSRF.
- HTML/inline-script escaping, same-key browser retry, and no confirmation button for expired/applied previews.
- Public route allowlist, GET/HEAD, content types, ETag/304, no Host-derived links, and no private API.
- Unsafe/corrupt owner context is preserved rather than silently replaced.

## Client compatibility

| Client / surface | Result |
| --- | --- |
| Official MCP SDK 1.30.0, in-memory transport | Discovery, schemas, state, preview, and errors tested |
| Official MCP SDK 1.30.0, real stdio process | Preview, private human-side apply, reconnect, and saved-state read tested |
| Compiled Node stdio server | Discovery and non-activating preview tested from `dist` |
| Bundled Codex CLI 0.153.4 | `mcp` command surface and the exact stdio command parsed with temporary CLI overrides; user configuration unchanged |
| Codex model-driven conversation | Not run; SDK process smoke is not evidence of a Codex model completing the journey |
| Claude Code | Instructions documented from official sources; CLI not installed and client journey not tested |
| Remote MCP / domain hosting | Outside this experiment; no endpoint or deployment created |

Protocol framing/negotiation is delegated to the pinned SDK. There is no custom handshake and no
claim of compatibility with every MCP protocol revision or client.

The skill passed the installed `skill-creator` validator. Its connection reference links the
official Codex and Claude documentation; tool and workflow claims are derived from this repository.

## Limits of the evidence

HTTP tests open loopback servers only for the test lifetime and close them afterward. A separate
interactive documentation-server launch was rejected by automatic approval review as a persistent
startup without explicit opt-in. A static HTML artifact was produced, but browser policy blocks
local file URLs, so visual browser inspection was not completed. The successful HTTP/HTML tests
do not substitute for visual QA.

No paid model/provider calls, live Telegram conversation, unattended runtime, deployment, OAuth,
or production configuration were tested or changed. The successful first result is local owner
context persistence. Real runtime readiness remains a separate operator trial.

The ledger and lock recovery limits are documented in [the operations guide](agent-onboarding.md).
Terra review findings and their disposition are recorded in the PR after review.
