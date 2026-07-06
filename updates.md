# Updates To Port

This file is a running log of architecture improvements and bug fixes that should be reviewed and applied to the main bot repository.

## How To Use

- Add one entry per change or bug.
- Keep entries practical: problem, fix, touched files, tests, rollout notes.
- Mark an item as `ported` only after it has been applied and verified in the main bot repo.
- If a change depends on runtime data migration or deploy order, write that explicitly.

## Template

```md
### YYYY-MM-DD - Short Title

Status: proposed | implemented-here | ported | skipped
Type: architecture | bugfix | reliability | security | product

Problem:
- What broke or what design gap exists.

Fix:
- What changed and why.

Files:
- `path/to/file.ts`

Verification:
- Command or manual check.

Porting Notes:
- Anything needed to apply this safely in the main repo.
```

## Entries

### 2026-04-30 - Make Onboarding Rituals Less Noisy

Status: implemented-here
Type: bugfix, product

Problem:
- The assistant exposed internal onboarding details such as day count and "facts needed", making normal replies feel mechanical.
- Morning ritual prompts could turn sparse context into a long "I am adapting" message.
- The daily welcome check treated a participant as unknown when they had already spoken in the group but had no saved memory entry.

Fix:
- Reword onboarding context as quiet background instructions and explicitly forbid day/count/fact-quota language.
- Add a `[NO_SEND]` ritual sentinel so task-generated notes can be suppressed when there is no concrete useful update.
- Count group messages and DM contact as enough introduction for onboarding welcome targeting.

Files:
- `src/core/context-composer.ts`
- `src/core/tasks.ts`
- `src/agents/butler.ts`
- `src/skills/onboarding.skill.ts`
- `src/test-helpers/mock-db.ts`

Verification:
- `pnpm exec tsc --noEmit`
- `pnpm exec vitest run src/agents/butler.test.ts src/core/context-composer.test.ts`
- `pnpm exec vitest run src/skills/skills.crud.test.ts -t "onboarding status treats participants"`

Porting Notes:
- Full suite may still be blocked by unrelated pack/grounding expectation drift in this DuoBarca branch.
- Keep `[NO_SEND]` suppression task-scoped only; never suppress direct user replies with this sentinel.

### 2026-04-30 - Preserve DM Continuity For Group Context

Status: implemented-here
Type: bugfix, architecture

Problem:
- Group answers only saw the current group space, so a user could say "I wrote in DM yesterday" and the assistant would not see their private chat history.
- Non-owner direct messages and `/start` commands were rejected before being recorded, so the assistant could not know that a person such as Kristina had contacted it.

Fix:
- Add privacy-limited private continuity to group prompts: include the current speaker's recent DM transcript, but expose only contact status for other people.
- Record denied direct contacts as `[ACCESS_DENIED_DIRECT_CONTACT]` without storing private text.
- Add DB helpers for direct-message lookup and known DM contact status.

Files:
- `src/core/context-composer.ts`
- `src/router.ts`
- `src/core/channel-commands.ts`
- `src/db.ts`
- `src/core/context-composer.test.ts`
- `src/router.test.ts`
- `src/core/channel-commands.test.ts`
- `src/db.test.ts`

Verification:
- `pnpm exec tsc --noEmit`
- `pnpm exec vitest run src/router.test.ts src/core/context-composer.test.ts src/core/channel-commands.test.ts src/db.test.ts`

Porting Notes:
- This does not recover contacts rejected before the fix was deployed; only new denied DMs will be recorded.
- Keep the privacy boundary: group context may include the current speaker's own DM content, but for other participants only a timestamp/count contact status.
- After porting, restart the bot process so the router and context composer changes are active.
