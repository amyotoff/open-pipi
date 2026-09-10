# MCP workflow

The server exposes exactly two tools. Both operate only on the data directory supplied when the local server starts.

## `pipi_onboarding_state`

Reads onboarding state. Input accepts an optional `previewId` string and rejects unknown fields. Reading does not create or change state.

The result reports schema version, one of `not_configured`, `configured`, `awaiting_confirmation`, `applied`, or `expired`, the saved owner context when present, and the requested preview (or the latest preview when no ID is given). An applied preview includes `currentMatchesPreview`; check it before claiming that the saved proposal is still current. Runtime readiness is not checked by this tool.

## `pipi_onboarding_preview`

Validates and persists a non-applying preview. Input fields are:

- `language`: required non-empty string
- `timezone`: required non-empty string
- `facts`: optional array of strings
- `currentTask`: optional string

Unknown fields are rejected. The result includes `previewId`, `previewHash`, creation and expiry times, base revision, normalized owner context, diff, effects, and state `awaiting_confirmation`.

Persisting a preview is a local state change, so this tool is not declared read-only. It does not approve or apply the preview, start Open PiPi, contact providers, authenticate accounts, or accept credentials.

## Errors

Invalid input returns `VALIDATION_FAILED`. Missing, mismatched, or expired previews are reported by the stored state or private confirmation flow. Do not guess corrected arguments, retry writes automatically, or treat an unknown outcome as success; read state first.

Confirmation and apply exist only in the private human setup route. They require the exact
unexpired preview identifier and hash plus an idempotency key. The private page reuses that key
on retry. A previously committed matching attempt may be reconciled after expiry without
another write. Preview validity is 30 minutes; the local ledger is bounded, so historical replay
is available only while the application record is retained. Empty `facts: []` and `currentTask: ""`
clear those fields; omitted optional fields preserve existing context.
