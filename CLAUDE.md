# Open PiPi coding-agent guide

Follow [AGENTS.md](AGENTS.md) for repository rules and
[CODING_AGENT_INSTALLATION.md](CODING_AGENT_INSTALLATION.md) for installation work.

An install-only request stops after dependencies and verification. Run `pnpm setup` only when the
operator explicitly asks for interactive configuration. Let the operator enter OpenRouter and
Telegram credentials in the loopback-only setup page; never request, print, or copy those secrets
into chat. Do not select persistent background operation on the operator's behalf.
