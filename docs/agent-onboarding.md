# Experimental agent onboarding for Open PiPi

## Public MVP: link to a working conversation

The current entry point guides a coding agent through a fresh or existing local installation,
private setup, and verification of an actual Telegram reply. MCP personalization is optional;
neither unsupported MCP clients nor a reload should block the main setup journey.

The page uses Helvetica, a light gray background, a large centered heading, and a prompt handoff.
It supports Russian/English, fresh/existing installation choices, clipboard confirmation, and
manual selection if clipboard permission is unavailable.

Implementation ownership for this extension:

1. Sol: a one-shot, read-only status CLI over existing setup, doctor, and dialogue evidence.
2. Sol: installation, setup continuation, recovery, and optional MCP instructions.
3. Parent: landing page, an allowlisted static build, Cloudflare deployment, and complete checks.
4. Terra: independent review of the integrated changes and any corrections.

### Journey and completion

The agent reads `SKILL.md` and the same-origin `/agent-onboarding/release.json`. A fresh install
uses the official Git repository and the exact 40-character commit in the manifest. Existing
checkouts retain their branch, operator configuration, and uncommitted work.

After a verified source install, the agent keeps the private `pnpm setup` process open. The owner
connects AI and Telegram, pairs their account, and chooses **Try now**. The agent reads:

```sh
node dist/scripts/onboarding-status.js --data-dir /absolute/path/to/the/same/data
```

This command performs local reads only. It never starts a runtime, probes a provider, changes
configuration, prints credentials, or creates a missing data directory. Its top-level `ready`
means `progress: "dialogue_verified"`: a ready runtime with delivered dialogue evidence for its
current run and configured owner. `doctor.ready` separately means startup prerequisites pass.
An old reply from an earlier run, installed dependencies, or saved owner context is not completion.

The runtime remains local. Temporary mode requires setup to stay open; background mode remains
the owner's explicit choice in the private page. AI usage is billed by the configured provider.

### Publish the public instructions to Cloudflare

`cloudflare/onboarding/wrangler.jsonc` defines an isolated static Worker named
`open-pipi-onboarding-mvp` on `workers.dev`. It has no custom domain routes, private API, remote MCP,
runtime process, database, credentials, or user-data binding. The static artifact is generated from
an explicit file allowlist; no repository or runtime directory is copied into the upload.

From a reviewed, committed, clean checkout that has been pushed to the official repository:

```sh
pnpm verify
pnpm onboarding:build
wrangler whoami
wrangler deploy --config cloudflare/onboarding/wrangler.jsonc --assets /absolute/outputDir/from/build
```

The build prints a new output directory and the pinned source commit. It refuses a dirty checkout
or a commit not advertised by the official remote (checked online with a 30-second timeout),
and never reuses a directory containing other files. Set `CLOUDFLARE_ACCOUNT_ID` to the intended
account returned by `wrangler whoami` if Wrangler reports multiple accounts. Confirm the public `release.json` matches the
pushed commit, all five Markdown files return `text/markdown`, relative references resolve, and
private routes return 404. The deployment uses no SPA fallback. `_headers` applies CSP, noindex,
correct content types, and revalidation. Inspect the rendered desktop/mobile page, language and
path switches, clipboard behavior, and browser errors after publication.

To roll back the public release, deploy a previously verified static artifact. This does not change
installed user runtimes. Do not expose the private setup service through a tunnel or public Worker.

## Original context-preview experiment

This experiment tests one local journey: give a coding agent an instruction link, connect a
local MCP server, preview personal context, review it in PiPi's private setup page, and read back
the saved result. The public instructions and private setup are separate surfaces; the MCP
server runs locally over stdio.

The first result is an owner context file that PiPi already knows how to consume: conversation
language, time zone, up to five facts, and a current task. Saving context is separate from starting
PiPi and observing an actual delivered Telegram reply.

## Implementation plan and ownership

1. Sol: durable preview, exact-context validation, revision checks, and retry handling over the
   existing setup-file storage.
2. Sol: a review page and confirmation endpoint inside the existing session, Origin, and CSRF
   boundary of the private setup server.
3. Sol: two MCP tools, a short skill package, public HTML/Markdown documentation, and protocol tests.
4. Parent agent: CLI/build integration, complete quality gate, a process-level MCP smoke test, and PR.
5. Terra: review the assembled PR, with fixes and repeat checks for actionable findings.

## Try the local experiment

From a verified checkout, build the experiment and serve its public instructions:

```sh
pnpm build
pnpm onboarding:serve
```

Open [the local instructions](http://127.0.0.1:8787/agent-onboarding). This server serves only public
documentation and binds to `127.0.0.1`. It neither opens private setup nor starts PiPi. Use
`pnpm onboarding:serve -- --port 8788` if the default port is occupied.

Choose a disposable data directory for a first trial, for example `.tmp/agent-onboarding-pilot`
inside this checkout. Both the MCP process and private setup must refer to the **same absolute
directory**. The MCP command requires an explicit `--data-dir`, independent of environment defaults:

```sh
node /absolute/path/to/open-pipi/dist/scripts/agent-onboarding.js mcp \
  --data-dir /absolute/path/to/open-pipi/.tmp/agent-onboarding-pilot
```

Configure the agent's stdio MCP connection with that direct Node command, using
[the client connection reference](../src/agent-onboarding/skills/open-pipi-onboarding/references/connect.md).
Do not put `pnpm` in the MCP command: package-manager banners can corrupt protocol stdout.
No user client configuration is modified by this PR or by serving the instruction page.

Ask the agent to read `pipi_onboarding_state`, then call `pipi_onboarding_preview` with your desired
language, time zone, and optional context. A preview writes only a private proposal. It does not
save the active context, connect providers, create tasks, send messages, or start PiPi.

When you are ready to review and save, explicitly start the existing private setup flow against
the same directory:

```sh
DATA_DIR=/absolute/path/to/open-pipi/.tmp/agent-onboarding-pilot pnpm setup -- --agent-onboarding
```

The browser opens using PiPi's existing one-use session link. Select **Review proposal**, inspect
the exact fields and effects, and confirm the proposal there. The agent then reads the preview's
state again to verify the saved revision. There is no MCP approval or apply tool.

`pnpm setup` is the real setup flow: existing operator environment settings still apply, and any
connection checks it normally performs remain real. For a provider-free first trial, use a clean
checkout without operator credentials. Automated smoke tests inject a synthetic setup service and
use disposable local data instead; they never invoke live setup providers.

For a real installation, connect AI and Telegram privately in the normal setup page, then choose
**Try now** yourself. Use the existing safe status command to distinguish configuration and runtime
state from an observed conversation:

```sh
pnpm setup -- --json
```

Do not paste credentials or the session-bearing setup URL into the coding-agent conversation.

## Integration map

The implementation starts from Open PiPi commit `4edc254` on `main`.

| Existing component | Reuse in this experiment |
| --- | --- |
| `src/setup/owner-context.ts` | Canonical validation/storage and runtime-consumed owner context; revision-checked saves |
| `src/setup/server.ts` | Existing loopback host, one-use session, Origin, CSRF, and no-store protection |
| `src/setup/page.ts`, `src/scripts/setup.ts` | Explicit experiment flag and a link to private proposal review |
| `src/setup/dialogue-evidence.ts` | Existing separate proof of a real runtime conversation |
| `src/core/setup-owner-context.ts` | Existing import of saved owner context into runtime memory |

The added onboarding application service lives in `src/agent-onboarding/service.ts`. It stores
bounded private proposal records alongside other setup files in the selected data directory.
No SQLite schema migration or new database is introduced. The official MCP SDK handles stdio
framing, discovery, and tool calls; the application does not implement its own JSON-RPC transport.

Public documents are served on an exact route allowlist. Their canonical source is the
`src/agent-onboarding/skills/open-pipi-onboarding` package, which is copied into `dist` by the build.
Public URL construction uses an explicitly supplied origin or the bound loopback address, never
the incoming `Host` header. The documentation server has no private setup API.

## Scope and rollback

This is a local, single-owner experiment. A client connected through stdio has the local OS
user's access to its explicitly selected data directory. There is no remote bearer authentication,
OAuth server, multi-tenant authorization, or public apply endpoint.

Closing the documentation server and MCP client disables those surfaces. Start ordinary
`pnpm setup` without `--agent-onboarding` to disable experimental review routes. Saved context
remains valid PiPi context and can be changed through normal private setup. The original context-preview experiment did not deploy or install background services.
The public Cloudflare MVP above adds instruction hosting only.

Preview validity is 30 minutes. The private ledger retains at most 100 previews, 100 successful
application records, and 100 incomplete attempts, with a 1 MB file limit. Unexpired pending
previews are not silently evicted. Replay guarantees apply while the application record is
retained; a new preview is required if an older record has been pruned. A committed write with
a durable matching attempt and its exact preallocated owner-context revision can be reconciled
after preview expiry without writing again. A separate save containing the same values is a
different revision and cannot complete that attempt. State reads can observe an already committed
intended revision even if the process stopped before recording the final result in the ledger.
Earlier experimental ledger records without an intended revision remain readable. Their unknown
write outcome cannot be reconciled; confirmation requires a new preview, while other proposals
remain usable.

File locks fail closed. After an interrupted process, a leftover `agent-onboarding.lock` or
`setup-owner-context.json.lock` can require manual recovery. Stop the relevant setup/runtime
processes and verify the lock owner is no longer active before removing that lock. The experiment
never automatically removes a lock on the basis of a stale PID. Do not remove the owner context
or proposal ledger as a way of clearing a lock.

A future domain rollout can publish the public documentation separately. Exposing the private
setup server or stdio tools as a network service would require a separate design and review.

Validation evidence and remaining limitations are recorded in
[the experiment test report](agent-onboarding-test-report.md).
