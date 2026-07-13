# Open PiPi Installation for Coding Agents

Use this runbook when a coding agent is asked to install Open PiPi from source. The human-oriented path remains in [README.md](README.md). Repository rules in [AGENTS.md](AGENTS.md) take precedence over this file.

## Default contract

Unless the operator explicitly asks for another mode, "install Open PiPi" means:

- use the current checkout, or clone the official repository if no checkout was supplied;
- install the full native development dependency set with the locked pnpm version;
- validate that the source builds and its tests pass;
- stop before secrets, personalization, Docker, deployment, or a persistent runtime.

An installation request authorizes repository-local dependency and build output, such as `node_modules/` and `dist/`. It does not authorize global toolchain changes, system packages, secret handling, Docker, deployment, production changes, or starting a long-lived service.

Report the highest state actually reached:

| State                  | Required evidence                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Dependencies installed | Frozen install, typecheck, lint, tests, and build succeeded                                      |
| Runtime configured     | `pnpm setup:check -- --json` returned `"ready": true` using operator-managed configuration       |
| Runtime started        | The operator explicitly requested startup and the selected runtime reported a successful startup |

Do not report "installed and running" when only dependencies were installed.

## 1. Resolve the checkout

If the operator supplied an existing checkout, work there. Do not clone over it, pull, switch branches, or discard changes.

If no checkout exists and the operator asked for a new one:

```bash
git clone https://github.com/amyotoff/open-pipi.git
cd open-pipi
```

## 2. Run the preflight

From the repository root:

```bash
git status --short
node --version
pnpm --version
```

Requirements are defined by repository files, not by agent memory:

- Node.js `>=24`; `.nvmrc` selects Node 24.
- pnpm `10.26.2`; `package.json#packageManager` is authoritative.
- Use pnpm only. Do not create `package-lock.json` or use npm/yarn for project commands.

Use an already available compatible `pnpm`. Do not blindly run `corepack enable`: Corepack is not bundled with every supported Node release, and enabling it can change files outside the repository. If Node or pnpm is missing or incompatible, report the exact prerequisite and obtain approval before changing a global toolchain or installing system packages.

Preserve a dirty worktree. Never reset, clean, delete, or overwrite unrelated files to make installation pass.

## 3. Install dependencies

The default, deterministic profile is the same one CI uses:

```bash
pnpm install --frozen-lockfile
```

Use the lean Telegram-only profile only when the operator explicitly requests it or the target is resource-constrained:

```bash
pnpm install --frozen-lockfile --no-optional
```

The lean profile omits Discord, WhatsApp, Gmail, and browser-automation packages. If the frozen install reports a lockfile mismatch, do not regenerate `pnpm-lock.yaml` unless dependency changes were explicitly requested.

## 4. Verify the source installation

For an install-only request:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

If the agent changed source or configuration files, run the complete repository gate instead:

```bash
pnpm verify
```

Do not silently fix unrelated failures. Record the failing command and the smallest useful error excerpt.

## 5. Hand configuration to the operator

Coding agents must not open, print, create, or edit `.env`, and must never ask the operator to paste tokens into chat. Ask the operator to create and fill it privately from `.env.example`.

The operator-side setup is:

```bash
cp .env.example .env
chmod 600 .env
```

Minimum values:

```dotenv
TELEGRAM_BOT_TOKEN=...
GEMINI_API_KEY=...
OWNER_TG_IDS=123456789
TZ=UTC
```

After the operator confirms that configuration is ready, the agent may run the read-only, secret-safe doctor without inspecting `.env`:

```bash
pnpm setup:check -- --json
```

Continue only when the JSON result has `"ready": true`. On failure, report only each failed check's `id` and `message`; never echo environment values.

## 6. Treat optional actions as opt-in

- `pnpm bootstrap` is personalization, not installation. It calls Gemini and can overwrite an existing grounding when the generated slug collides. Never run it automatically: first warn the operator, require separate confirmation, and stop if `src/groundings/` has uncommitted or untracked work. Afterward, inspect the diff and run `pnpm content:check`.
- `pnpm dev` and `pnpm start` connect to external services and write runtime state under `DATA_DIR`; start one only when explicitly requested and after checking that another bot instance is not already running.
- Docker is a separate full-stack mode. Use it only when explicitly requested, require the operator to set a strong `SANDBOXD_TOKEN` privately, and validate with `docker compose config --quiet` so expanded secrets are not printed.
- Deployment, production configuration, restores, migrations, and background service installation require separate explicit authorization.

## Troubleshooting policy

| Failure                             | Agent response                                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Node is older than 24               | Report the detected version and point to `.nvmrc`; do not replace the global runtime silently                           |
| pnpm is missing or wrong            | Report that `pnpm@10.26.2` is required; ask before changing the global toolchain                                        |
| Frozen lockfile mismatch            | Stop and report it; do not update the lockfile during an install-only task                                              |
| Native dependency build fails       | Report the missing compiler/tool from the error; ask before installing system packages such as Python, `make`, or `g++` |
| Doctor returns `ready: false`       | Report failed check IDs/messages and hand secret-related fixes to the operator                                          |
| Optional channel package is missing | Confirm the requested profile, then use the full frozen install if that channel is required                             |

## Completion report

Return a concise handoff containing:

- install profile and checkout path;
- detected Node and pnpm versions;
- commands run and their results;
- highest state reached: dependencies installed, runtime configured, or runtime started;
- files changed by the agent;
- actions intentionally not run and any remaining blocker or risk.
