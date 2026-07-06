# Security

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public issue
2. Email security concerns to the maintainer via [amyote.com](https://amyote.com)
3. Include a description of the vulnerability and steps to reproduce

You should receive a response within 48 hours.

## Security Model

| Entity | Trust Level | Notes |
|--------|-------------|-------|
| Telegram owner (OWNER_TG_IDS) | Trusted | Full access to all skills |
| Non-owner Telegram users | Untrusted | Rejected by router |
| LLM tool calls | Sandboxed | Allowlisted commands only |
| Docker container | Isolated | Main app container is hardened; `sandboxd` is a separate privileged boundary |

## Security Boundaries

### 1. Access Control

Only Telegram users listed in `OWNER_TG_IDS` can interact with the bot. Non-owners are rejected, and startup fails if `OWNER_TG_IDS` is empty unless `BOOTSTRAP_OWNER_MODE=true` is explicitly enabled for first-time setup.

### 2. Shell Command Isolation
`src/utils/shell.ts` restricts commands to an allowlist of safe network diagnostic tools. Shell operators (`;`, `&&`, `|`, `` ` ``, `$()`) are blocked.

### 3. Container Security (Production)
Production `docker-compose.yml` runs the main `pipi-bot` container with:
- No `network_mode: host`
- No Docker socket mount
- `security_opt: [no-new-privileges:true]`
- Non-root user inside container

The `sandboxd` sidecar is separate from `pipi-bot` and is the only service that mounts `/var/run/docker.sock`. This is intentional so sandboxed tool execution can create short-lived child containers, but it also means `sandboxd` must be treated as a privileged boundary with host-equivalent container control. Keep it on an internal network only, require a strong `SANDBOXD_TOKEN`, and avoid exposing it publicly.

### 4. Credential Isolation
All API keys and tokens are loaded from environment variables, never hardcoded. The `.env` file is gitignored.

### 5. Email Credentials
The lightweight IMAP integration uses `LOGIN` over a TLS socket. Credentials are protected in transit by TLS, but Gmail app passwords remain mandatory; no OAuth2 flow is implemented here.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | ✅         |
| < 2.0   | ❌         |
