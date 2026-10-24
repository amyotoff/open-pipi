---
name: open-pipi-onboarding
description: Install, configure, and verify a local Open PiPi from its official agent-onboarding link. Use when a user asks an agent to install or set up Open PiPi and stay with them until a real Telegram reply works. Do not use for cloud-hosting the private runtime or unrelated assistant setup.
metadata:
    version: '0.2.0'
---

# Open PiPi onboarding

Bring Open PiPi on the user's actual chosen computer or server to the highest state they requested and can verify. Reply in their language. Use a coding agent with terminal access on that target, such as Codex, Claude Code, or Antigravity. An ordinary ChatGPT chat or cloud sandbox without access to the target cannot complete a local installation. The public page and this skill are instructions; the private runtime, credentials, and owner data remain on the target.

## Route the work

Read [installation](references/install.md) before any clone, update, dependency install, or setup. First prove read-only access to the user's intended target. If access is unavailable, stop with an accurate handoff; never install inside the agent's unrelated sandbox and call it the user's installation.

Choose the requested `fresh`, `update`, `macos`, `linux`, `windows`, `rpi`, or `vps` scenario. If the user said only “install,” complete the verified source installation and report it. A combined request to install and configure, install and set up, install and start, or install and continue until PiPi works also authorizes starting the private setup during this task; do not ask again merely to run `pnpm setup`.

Read [connection](references/connect.md) only when local MCP personalization would help. MCP is optional: missing client support, a failed registration, or a required client reload must not block installation and setup.

## Complete the private setup

Open the guided setup and let the human enter AI and Telegram credentials, review provider costs, approve account pairing, and press **Try now**. Never ask them to paste secrets into chat, inspect secret values, click pairing/confirmation for them, accept model costs for them, or choose background startup for them.

After each human action, read the bounded setup status. Keep the setup process open and wait for the user to send PiPi a Telegram message. Completion requires the safe status to report `dialogueVerified: true`, which records an observed reply. A successful build, configured credentials, paired owner, running process, or saved personalization alone is not a working conversation.

Background mode remains the human's choice after the dialogue is verified. A foreground runtime owned by the setup task may stop when the task or its terminal closes; do not promise continued operation from a temporary trial. The human may choose background mode in the page after verification or keep PiPi running in their own terminal. PiPi cannot answer while its host computer is asleep or off.

## Personalization preview

When MCP is available, use `pipi_onboarding_state` and `pipi_onboarding_preview` as described in [the MCP workflow](references/workflow.md). The owner must review and confirm the exact preview in the private setup page. Verify `applied` and `currentMatchesPreview: true`; an older applied preview may no longer describe current owner context.

Use [troubleshooting](references/troubleshooting.md) for stalled or failed steps. Report the checkout, commands and checks performed, the highest verified state, and any remaining human action. Never claim the public Cloudflare page hosts or operates the user's PiPi.
