You are helping an operator personalize Open PiPi after installation.

Follow `AGENTS.md` and `CODING_AGENT_INSTALLATION.md`. This command is an explicit opt-in to the Gemini-backed bootstrap and its new grounding files; it is not permission to deploy, start a persistent runtime, or handle secrets.

## What this command does

`/pipi_setup` runs the operator bootstrap flow:

1. Collects a one-paragraph description of the assistant
2. Calls `pnpm bootstrap` to generate grounding files
3. Shows the generated files and .env variables to set
4. Hands `.env` changes to the operator
5. Validates the generated content and TypeScript

---

## Step 1 — Get the description

If `$ARGUMENTS` is not empty, use it as the description and skip asking.

Otherwise ask the user:

> Describe your assistant in one paragraph. Cover: who it's for, the main job-to-be-done, language, key people and their roles, any standing rules or constraints.

Wait for the response before continuing.

---

## Step 2 — Run bootstrap

Bootstrap can overwrite an existing `src/groundings/<slug>` when the generated slug collides. Never run it automatically. Check `git status --short`, stop if `src/groundings/` has uncommitted or untracked work, warn the operator about the collision risk, and obtain separate confirmation before continuing.

Run the bootstrap with pnpm:

```bash
pnpm bootstrap
```

Send the description to the running process over stdin. Do not interpolate user text into a shell command or write it to a tracked file. Show the full bootstrap output to the user.

---

## Step 3 — Show the generated files

Read and display the contents of the created grounding files:

- `src/groundings/<slug>/grounding.md`
- `src/groundings/<slug>/people.md`
- `src/groundings/<slug>/operating.md`

Ask the user: "Does this look right? Anything to change?"

If they request changes, edit the files directly, then continue.

---

## Step 4 — Hand off .env values

Never open, print, or edit `.env`. Show the operator the two non-secret values emitted by bootstrap:

- `BOOTSTRAP_PACK=<pack_id>`
- `BOOTSTRAP_GROUNDING=<slug>`

Ask the operator to add them privately, then run `pnpm setup:check -- --json` without inspecting the file.

---

## Step 5 — Confirm clean build

Run:

```bash
pnpm content:check
pnpm typecheck
```

If it fails, show the errors and help fix them before finishing.

---

## Step 6 — Show smoke prompts

Print the smoke prompts from the bootstrap output and say:

> After you explicitly start the bot, try these prompts to verify it knows its context:

List each prompt numbered. Do not start or deploy the bot unless the operator separately asks for that action.
