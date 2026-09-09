# Agent onboarding experiment — validation

## Public MVP extension

Test site: <https://open-pipi-onboarding-mvp.amyote.workers.dev/>. The deployed `release.json`
records the exact published source revision for fresh installation. Desktop/mobile visual QA and
interaction evidence are in [design-qa.md](../design-qa.md). Public HTML, all five Markdown files,
JSON, CSS, and JS returned 200; `/api/status`, `/api/agent-onboarding/confirm`, `/mcp`, `/.env`, and
`/setup` returned 404. Robots allow fetching instructions; `noindex` suppresses search indexing.

A fresh official clone detached at `38b52db` passed frozen full dependency installation. The first
macOS build hit ENOSPC while copying extended attributes on a host with about 100 MB free. The
same build passed with `COPYFILE_DISABLE=1`; no source change was needed. Its actual built status
CLI returned `needs_configuration` and did not create a data directory. Main-checkout `pnpm verify`
and GitHub Node 24 build/security passed without this environment override.

`pnpm verify` passed for the extension: 129 test files / 1108 tests, 20 feature smoke tests,
format, typecheck, lint, content validation, coverage thresholds, and build. Coverage: 82.67%
statements, 70.65% branches, 90.29% functions, 85.25% lines. Cloudflare Wrangler dry-run passed
with the explicit public assets directory and no runtime/data bindings.

The v0.2 extension adds a full CLI-first journey, an exact release commit for fresh installs,
optional MCP personalization, a bounded read-only progress command, and an isolated Cloudflare
static artifact. Focused checks cover missing/configured/running/dialogue states, safe failures,
public artifact contents, MIME/security headers, source pin validation, and relative document links.
The actual status pipeline is tested with synthetic credentials, a live process lock, and generated
dialogue evidence: a matching run verifies, a changed run rejects stale evidence, and a stopped run
is not ready. Reads make no network calls and leave every data file unchanged.

The landing uses the user's Helvetica/light gray/large centered header reference and functional
Russian/English, fresh/existing, and copy controls. The public deployment and rendered browser QA
are recorded with the final PR validation. Live Telegram/provider actions remain a real tester step;
synthetic evidence tests do not claim an actual account conversation occurred in this build task.

Terra's extension review found two P2 issues, both fixed and approved on re-review: saved
credentials now report `configuration_present` / `validate_in_setup`, without implying live
validation; and the release builder verifies the exact clean HEAD is advertised by the official
remote before producing any upload artifact. Unpublished commits fail closed.

## Original v0.1 baseline

Validated locally on 2026-09-09 with Node 25.2.1 and pnpm 10.26.2. The repository requires Node
24 or newer; GitHub CI uses Node 24. Fixtures contain synthetic context, disposable directories
under `.tmp`, and no real provider, Telegram, or user client configuration changes.

## Quality gate

`pnpm verify` passed: format, typecheck, lint, content validation, 125 test files / 1094 tests,
20 feature smoke tests, coverage thresholds, and the production build. Coverage was 82.54%
statements, 70.39% branches, 90.21% functions, and 85.14% lines. A final `pnpm build` also passed
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
- Durable attempt recovery using the exact preallocated context revision, including after expiry;
  a separate same-valued write cannot complete another attempt.
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
Terra's initial review found one P2: recovery could attribute a separate same-valued context write
to an interrupted confirmation. The fix persists the intended revision before the conditional write
and requires that exact revision to reconcile. Regression tests distinguish a real committed attempt
from an unrelated save. A separate two-process concurrency check also confirmed that simultaneous
applications from one base produce one success and one `VERSION_CONFLICT`.

Terra's re-review also caught compatibility with earlier incomplete ledger records. Those remain
readable, but cannot be used to assert an unprovable write outcome; new proposals continue to work.
The final Terra review approved both fixes and reported no remaining actionable findings.
