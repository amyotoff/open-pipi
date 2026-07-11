# Contributing to Open PiPi

## Before You Start

1. **Check for existing work.** Search open PRs and issues before starting.
2. **Read the Philosophy.** Source code changes should be things most users need. Niche features → skills.
3. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one improvement.

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, documentation.

**Not accepted as core changes:** New integrations, niche features, hardware-specific code. These should be skills.

## Skills Architecture

Skills live in `src/skills/` and implement the authoritative `SkillManifest` interface from
[`src/skills/_types.ts`](src/skills/_types.ts), including capability metadata and runtime context.

To add a skill:
1. Create `src/skills/your-skill.skill.ts` exporting a `SkillManifest`
2. Import and add it to `ALL_SKILLS` in `src/skills/_registry.ts`
3. Skills self-register their tools, handlers, cron jobs, and DB migrations

The filename is also the capability ID used by pack validation; hyphens normalize to underscores (for example, `html-artifacts.skill.ts` → `html_artifacts`). Keep it aligned with the manifest `name`.

## Packs And Groundings

Packs live in `src/packs/<id>/` and require:

- `agent.md` with JSON frontmatter and the system prompt body
- `skills.md` with JSON frontmatter and contributor-facing skill guidance
- optional `tools.md` and `tools/*.tool.js` or `tools/*.tool.ts`

Groundings live in `src/groundings/<id>/` and require `grounding.md`, `people.md`, and `operating.md`; `glossary.md` is optional. The frontmatter `id` must match its directory name.

Run `pnpm content:check` after changing either type. It validates required files, JSON frontmatter, IDs, seeded task schedules, pack tool exports, and grounding metadata. The check is also part of `pnpm verify`.

To start from a minimal valid structure, use `pnpm content:new -- pack <id>` or `pnpm content:new -- grounding <id>`. Add `--dry-run` to preview the file list. The scaffolder refuses to overwrite an existing directory.

## Testing

- Use `pnpm` for this repo. Do not mix `npm` and `pnpm` in the same checkout.
- Run `pnpm verify` before submitting.
- Use obviously synthetic IDs and names in fixtures; never add real personal data.
- Test your skill end-to-end and verify it works

## Pull Requests

### Before opening

1. **Link related issues.** Include `Closes #123` if applicable.
2. **Test thoroughly.** Run the tests and try it yourself.

### PR description

Keep it concise:

- **What** — what the PR adds or changes
- **Why** — the motivation
- **How it works** — brief explanation
- **How it was tested** — what you did to verify
