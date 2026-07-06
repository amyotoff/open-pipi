You are helping an operator configure Open PiPi before deployment.

## What this command does

`/pipi_setup` runs the operator bootstrap flow:
1. Collects a one-paragraph description of the assistant
2. Calls `npm run bootstrap` to generate grounding files
3. Shows the generated files and .env variables to set
4. Optionally updates `.env`
5. Confirms the build is clean with `npm run typecheck`

---

## Step 1 — Get the description

If `$ARGUMENTS` is not empty, use it as the description and skip asking.

Otherwise ask the user:

> Describe your assistant in one paragraph. Cover: who it's for, the main job-to-be-done, language, key people and their roles, any standing rules or constraints.

Wait for the response before continuing.

---

## Step 2 — Run bootstrap

Write the description to a temp file and pipe it to the bootstrap script to avoid shell escaping issues:

```bash
echo "<description>" > /tmp/pipi_bootstrap_input.txt
npx ts-node src/scripts/bootstrap.ts < /tmp/pipi_bootstrap_input.txt
rm /tmp/pipi_bootstrap_input.txt
```

Show the full output to the user.

---

## Step 3 — Show the generated files

Read and display the contents of the created grounding files:
- `src/groundings/<slug>/grounding.md`
- `src/groundings/<slug>/people.md`
- `src/groundings/<slug>/operating.md`

Ask the user: "Does this look right? Anything to change?"

If they request changes, edit the files directly, then continue.

---

## Step 4 — Update .env

Check if `.env` exists. If it does, ask the user:

> Should I add `BOOTSTRAP_PACK=<pack_id>` and `BOOTSTRAP_GROUNDING=<slug>` to your `.env`?

If yes, append the two lines. If `.env` does not exist, show them as a reminder to add manually.

---

## Step 5 — Confirm clean build

Run:

```bash
npm run typecheck
```

If it fails, show the errors and help fix them before finishing.

---

## Step 6 — Show smoke prompts

Print the smoke prompts from the bootstrap output and say:

> Deploy the bot, then try these prompts to verify it knows its context:

List each prompt numbered.
