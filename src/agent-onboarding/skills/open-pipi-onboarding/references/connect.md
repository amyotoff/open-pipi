# Optional local MCP personalization

The MCP server prepares owner-context previews. Installation, private setup, and Telegram verification work without it. A public onboarding URL is not a remote MCP endpoint.

Use the same absolute data directory for MCP, setup, and status. For a fresh installation this is `<absolute-checkout>/data`. For an existing installation, use its established public/configured path or ask the user when unclear; never inspect `.env` to discover it. Build the verified checkout before registering its direct Node entrypoint. Inspect existing client configuration first and change it only when the user authorized connection or setup.

## Codex CLI

```sh
codex mcp list
codex mcp add open-pipi-onboarding -- node /absolute/repo/dist/scripts/agent-onboarding.js mcp --data-dir /absolute/data
codex mcp get open-pipi-onboarding
```

## Claude Code

```sh
claude mcp list
claude mcp add --transport stdio --scope local open-pipi-onboarding -- node /absolute/repo/dist/scripts/agent-onboarding.js mcp --data-dir /absolute/data
claude mcp get open-pipi-onboarding
```

All Claude options precede the server name. Local scope is private to the current project. Do not write a project `.mcp.json` unless the user chose project scope. A newly registered stdio server may require a client reload; continue installation and private setup while explaining that personalization preview can resume afterward.

The MCP server has no remote URL, OAuth flow, credential tools, runtime controls, or approval tool. Never invent these. If the client cannot run local stdio, skip MCP and continue with the private setup page.

After `pipi_onboarding_preview`, start the setup with the same data directory and onboarding review enabled:

```sh
DATA_DIR=/absolute/data pnpm setup -- --agent-onboarding
```

The setup command opens a private loopback session without printing its bearer link. The owner selects **Review proposal** and confirms it. A review path containing a preview ID is a locator inside that authenticated session, not an authorization capability. Do not click confirmation for the owner.
