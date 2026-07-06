# Contributing to Open PiPi

## Before You Start

1. **Check for existing work.** Search open PRs and issues before starting.
2. **Read the Philosophy.** Source code changes should be things most users need. Niche features → skills.
3. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one improvement.

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, documentation.

**Not accepted as core changes:** New integrations, niche features, hardware-specific code. These should be skills.

## Skills Architecture

Skills live in `src/skills/` and follow the `SkillManifest` interface:

```typescript
// src/skills/_types.ts
interface SkillManifest {
    name: string;
    description: string;
    version: string;
    tools: FunctionDeclaration[];
    handlers: Record<string, (args: any, context?: { chatId: string, userId: string }) => Promise<string>>;
    crons?: CronJob[];
    migrations?: string[];
    init?: () => Promise<void>;
}
```

To add a skill:
1. Create `src/skills/your-skill.skill.ts` exporting a `SkillManifest`
2. Import and add it to `ALL_SKILLS` in `src/skills/_registry.ts`
3. Skills self-register their tools, handlers, cron jobs, and DB migrations

## Testing

- Use `pnpm` for this repo. Do not mix `npm` and `pnpm` in the same checkout.
- Run `pnpm test` before submitting
- Run `pnpm typecheck` to verify types
- Use standard test personas: Alice (`tg_id: '111'`), Bob (`tg_id: '222'`), Bender (`tg_id: '333'`)
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
