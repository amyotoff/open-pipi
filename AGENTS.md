## Mission
Open PiPi — a Telegram-first, owner-operated assistant runtime with memory, planning, and research skills.

## Stack
- Node.js 24+ / TypeScript
- pnpm as the package manager
- SQLite (better-sqlite3) for runtime state
- Runs on anything from a Raspberry Pi to a VPS (see Dockerfile / docker-compose files)

## Commands
- pnpm install
- pnpm dev
- pnpm lint
- pnpm test
- pnpm build

## Rules
- Plan before editing.
- Use minimal diffs.
- Do not edit .env files.
- Do not touch production configs.
- Do not run destructive commands without explicit approval.
- Do not modify files outside the project root.
- Add or update tests for behavior changes.
- Summarize changed files, commands run, test results, and risks.

## Forbidden without explicit approval
- rm -rf
- git reset --hard
- git clean -fdx
- docker system prune
- database migrations
- cloud deploys
- changing auth / payments / permissions
- editing secrets or credentials

## Definition of Done
- relevant tests pass
- lint/build pass or failures are explained
- diff is minimal
- no secrets leaked
- risks are listed
