# Open PiPi — Help

Short operator and user guide. The bot reads this file via the `help_lookup` / `helper_lookup` tools when someone asks how it works, what it can do, or how to operate it.

## What this bot is

Open PiPi is a self-hosted assistant runtime. It lives in a `space` (a Telegram DM, group, or channel). Behavior is shaped by:

- a **pack** — voice, enabled skills, defaults (`jeeves`, `tutor`, `office`, `reporter`)
- a **grounding** — stable facts and operating rules for this space
- **memory** — the changing stuff the bot learns from conversation

## Common user questions

**"What can you do?"** — List installed skills (shopping, todos, reminders, memory, projects, tasks, journal, etc.) in plain language. Don't dump tool names — describe capabilities.

**"How are you / how's it going / how's the bot doing?"** — Call `helper_self_status` first, then answer in natural language: which pack is active, grounding level, whether a recent backup exists. Do not paste the raw tool result — summarize.

**"What's the budget / how much have you spent?"** — Call `helper_self_status`. It reports today's input/output tokens, call count, and approximate USD cost from the `token_usage` table. Important caveat: tracking is **runtime-wide, not per-space** — the number covers every space this bot serves, not just the current chat. Be honest about that when answering. There is no hard budget cap; the numbers are informational.

**"How do I set you up?"** — Point to `/setup`, `/setup apply`, `/setup smoke`. Setup is owner-only.

**"How do I change your personality?"** — `/pack` to see current, `/pack mutate <id>` to switch.

**"How do I make a backup?"** — `/backup` creates one, `/backup status` shows the latest. Always run `/backup` before upgrading.

## Operator commands (Telegram)

| Command | Purpose |
| --- | --- |
| `/setup` | Show setup status for this space |
| `/setup apply` | Apply pack defaults (tasks, policy, grounding) |
| `/setup smoke` | Smoke-check what the bot knows about this space |
| `/setup reset` | Reset onboarding state to `new` |
| `/channel` | Show channel status and mode |
| `/channel mode <off\|notify_only\|inbox\|full>` | Change how the bot sends messages |
| `/pack` | Show current pack and list available |
| `/pack mutate <id>` | Switch to another pack |
| `/backup` | Create a runtime backup now |
| `/backup status` | Show latest backup health |
| `/approve [action]` | Approve a pending approval request |
| `/deny [action]` | Deny a pending approval request |

All operator commands require `can_change_policies` trust. In a fresh DM the first user becomes owner automatically.

## Channel modes

- `off` — all background sends suppressed; only direct command replies go through
- `notify_only` — only command replies and system notifications
- `inbox` — incoming messages stored; bot does not auto-reply
- `full` — normal conversational routing (default)

## Grounding levels

- **L0** — nothing recorded yet; bot captures context from the conversation
- **L1** — people recorded
- **L2** — rules or org recorded
- **L3** — full context

## When to call which helper tool

- `help_lookup` / `helper_lookup` — user asks what the bot can do, how to use a feature, what a command means, how packs/grounding/memory work, or any "how do I…" / "что это / как работает" question. The tool returns the most relevant excerpts from this file and README.md.
- `helper_self_status` — **owner-only.** User asks about the bot's current state: "how are you", "как дела", "what's your config", "which pack are you on", "when was the last backup", health, budget, spending. Non-owners will get a refusal — answer them generically without calling the tool.

Do not call `help_lookup` for every question. Use it when the user actually wants to know about the bot itself, not when they're asking you to do work (shopping, reminders, tasks — those go through their own skills).

## Things the bot should not claim

- Per-space token cost or budget (tracking is runtime-wide only — see `token_usage` table).
- Hard budget caps or automatic shutoff on overspend (not implemented).
- Remote/cloud backups (backups are local to `DATA_DIR`).
- Cross-space memory sharing (each space is isolated).
