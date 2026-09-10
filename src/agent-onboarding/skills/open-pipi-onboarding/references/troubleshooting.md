# Setup status and troubleshooting

Use the direct built script for a bounded status snapshot while setup is running:

```sh
node dist/scripts/onboarding-status.js --data-dir /absolute/data
```

Use the same absolute data directory as the setup process. The one-shot command exits `0` after a valid snapshot even when configuration remains incomplete, `2` for bad arguments, and `1` with a sanitized JSON error. It returns:

- `progress`: `needs_configuration`, `configuration_present`, `running_awaiting_real_reply`, or `dialogue_verified`;
- `ready`, `setup.configured`, `setup.phase`, safe runtime state/mode, and `dialogueVerified`;
- safe doctor failure/warning IDs and a `nextAction` enum.

It returns no credentials, paths, account IDs, usernames, models, messages, or session URLs. `setup.configured: true` and `progress: configuration_present` mean only that required values are present locally; this read-only command does not validate providers or Telegram over the network. `doctor.ready` covers local prerequisites only. Doctor failures and warnings are safe check IDs, not diagnostic messages. `dialogueVerified` is recalculated against the live runtime run, so stale evidence does not count.

Follow `nextAction` literally: `complete_setup`, `validate_in_setup`, `wait_for_runtime`, `send_real_owner_message_and_wait_for_reply`, or `none`. In particular, `validate_in_setup` sends the human back to private setup for live checks; it is not permission or evidence to start the runtime.

After a human action, poll every two seconds in windows of at most 60 seconds while keeping setup alive. Send a concise progress update before another window. Stop sooner when `dialogueVerified` becomes `true`, status reports an action the human must take, setup exits, or the user asks to stop. A timeout means the real reply was not observed; it is not success.

| Status or failure                          | Response                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Node or pnpm incompatible                  | Report detected and required versions; ask before changing a global toolchain.                               |
| Frozen lockfile mismatch                   | Stop; do not rewrite the lockfile during installation.                                                       |
| Native dependency build fails              | Report the missing prerequisite; ask before installing system packages.                                      |
| Browser did not open                       | Ask the human to use `pnpm setup -- --show-link` privately.                                                  |
| AI or Telegram missing/invalid             | Point to the matching private setup card; never request the credential in chat.                              |
| Owner pairing waiting                      | Ask the human to open the one-time Telegram link, press Start, and confirm the displayed account themselves. |
| `configuration_present`                    | Continue in private setup to validate the saved values; do not start PiPi or claim remote validity yet.      |
| Runtime started, `dialogueVerified: false` | Ask the owner to send PiPi a Telegram message; keep waiting for the observed reply.                          |
| MCP registration failed or tools absent    | Skip personalization and continue installation/setup; explain that a reload may enable it later.             |
| Background unsupported                     | Leave the verified foreground trial running or let the human choose another supported host.                  |
| No terminal access to intended target      | Stop and hand off to Codex, Claude Code, or Antigravity running on that target; do not install in a sandbox. |
| Native Windows shell                       | Move the task to WSL2; do not patch the build ad hoc or claim native Windows support.                        |
| Raspberry Pi resource/toolchain failure    | Report architecture, Node version, and failed prerequisite; do not claim this scenario is fully tested.      |
| VPS setup page cannot be reached           | Have the human use matching loopback ports for setup and their private SSH tunnel; never open a public port. |
| Update sees dirty tree or active runtime   | Stop with the checkout, old SHA, status, and safe next action; do not reset, overwrite, or interrupt it.     |
| Published revision requires migration      | Stop before migration and request explicit owner direction; source update authorization does not include it. |

Use `pnpm setup:check -- --json` for the broader read-only configuration doctor. Its `ready: true` covers local startup prerequisites; it does not validate remote credentials or prove a Telegram dialogue. Report only safe check IDs from failures and warnings.

An older existing checkout may not contain `dist/scripts/onboarding-status.js`. Do not update or switch its branch automatically. After its documented build, use `DATA_DIR=/absolute/data pnpm setup -- --json` for bounded setup state and `DATA_DIR=/absolute/data pnpm setup:check -- --json` for the doctor. These older commands do not prove a real dialogue unless their documented status explicitly includes current `dialogueVerified: true`; otherwise ask the human to confirm the observed reply and report that automated dialogue verification is unavailable in that checkout.

The working result is a real observed Telegram reply. Report separately whether the runtime remains in the temporary foreground trial or the human chose background mode.
