# Connect a supported client

This package exposes an experimental local stdio MCP server. It does not publish a remote MCP endpoint and does not perform authentication.

Before adding anything, inspect the client's existing MCP servers and verify both the name and command. Replace `/absolute/repo` and `/absolute/data` with resolved absolute paths. Use the same data directory for MCP preview and the private human setup flow.

Use an existing checkout containing the experiment. The source repository is
[amyotoff/open-pipi](https://github.com/amyotoff/open-pipi). Follow its local
`CODING_AGENT_INSTALLATION.md` for dependencies and verification; do not overwrite an existing
checkout or assume an unreleased experiment is already on `main`. Run `pnpm build` in that checkout
before registering the direct Node command below. The public instruction page does not install
the skill or MCP server by itself.

## Codex CLI

```sh
codex mcp list
codex mcp add open-pipi-onboarding -- node /absolute/repo/dist/scripts/agent-onboarding.js mcp --data-dir /absolute/data
codex mcp get open-pipi-onboarding
```

Run the add command only with permission to change the user's Codex configuration. A newly added server may require restarting the current Codex client before its tools appear.

## Claude Code

```sh
claude mcp list
claude mcp add --transport stdio --scope local open-pipi-onboarding -- node /absolute/repo/dist/scripts/agent-onboarding.js mcp --data-dir /absolute/data
claude mcp get open-pipi-onboarding
```

All Claude options precede the server name. Local scope is private to the current project. Project scope writes `.mcp.json` and is not part of this setup.

## Manual fallback

If the client cannot start local stdio servers, open the local documentation served by `pnpm onboarding:serve`, prepare the four owner-context fields with the user, and stop at a draft. Do not claim connection or persistence.

## Private review and continuation

After the agent shows the preview, the owner can open the existing private setup flow from the
same checkout:

```sh
DATA_DIR=/absolute/data pnpm setup -- --agent-onboarding
```

Use the same absolute data directory as the MCP command. Setup opens the session link privately
in the browser; do not copy that link into chat. Select **Review proposal**, check the exact fields,
and confirm on that page. An already open authenticated setup page can select a specific proposal
at `/agent-onboarding/review?previewId=<returned-preview-id>`; this path is only a locator.

Starting setup requires the user's instruction to configure PiPi; use existing authorization
when already given. It is the real setup flow and may check configured providers. The agent must
not click the human confirmation on the user's behalf. Credentials, runtime trial, and background
startup remain the owner's choices in the private page.

After confirmation, call `pipi_onboarding_state` with the same `previewId` and verify both `applied`
and `currentMatchesPreview: true`. An old applied preview with a changed current context is
historical evidence, not the current setup.

Client references: [OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).
