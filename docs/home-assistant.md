# Home Assistant subagent

Open PiPi can delegate smart-home requests to a bounded `home_operator` family member. The subagent
uses a small Home Assistant REST adapter; it cannot call arbitrary services, discover hidden
entities, send area/device/group targets, or perform Home Assistant administration.

## Scope

The first version supports:

- reading exact allowlisted entity states;
- `turn_on` and `turn_off` for allowlisted `light` and `switch` entities;
- `set_brightness` from 0 to 100 for allowlisted lights;
- one entity per action, with one-time owner confirmation;
- reading the final state after Home Assistant accepts an action.

It deliberately does not support locks, alarms, covers or garage doors, valves, sirens, cameras,
buttons, scenes, scripts, automations, wildcards, areas, groups, or arbitrary service data.

The adapter can bound the direct REST target, but it cannot prove how Home Assistant implemented
that entity. A `light` or `switch` entity may itself represent a
[group](https://www.home-assistant.io/integrations/group/), and any state change may fire a configured
[automation trigger](https://www.home-assistant.io/docs/automation/trigger/). Do not
control-allowlist group entities, template entities, or entities wired to unsafe automations. Audit
the downstream behavior in Home Assistant before exposing an entity to Open PiPi.

## Home Assistant setup

1. In Home Assistant, create a dedicated non-admin user for Open PiPi. Do not link it to a person.
2. Sign in as that user and create a long-lived access token from the profile Security page. Home
   Assistant documents these tokens in its
   [Authentication API](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token).
3. Find the exact entity IDs you want to expose under Settings > Devices & services > Entities.
4. Add the values privately to Open PiPi's `.env`; never paste the token into chat:

```dotenv
HOME_ASSISTANT_URL=http://127.0.0.1:8123
HOME_ASSISTANT_TOKEN=...
HOME_ASSISTANT_READ_ENTITIES=sensor.hall_temperature,sensor.living_room_humidity
HOME_ASSISTANT_CONTROL_ENTITIES=light.kitchen,switch.coffee
```

`HOME_ASSISTANT_CONTROL_ENTITIES` are automatically readable. Both lists are exact and
default-deny; an empty control list makes the integration read-only. The API uses Home Assistant's
documented Bearer authentication and state/service endpoints from the
[REST API](https://developers.home-assistant.io/docs/api/rest/).

For a native Open PiPi process on the same Raspberry Pi, loopback is normally correct. If Open PiPi
runs in a container, `127.0.0.1` points to that container, not the Raspberry Pi host. Use a private
Home Assistant service name or LAN address reachable from the Open PiPi container. Do not expose
port 8123 directly to the internet.

Home Assistant uses its own `home_automation` execution capability, so disabling general browser
access does not disable the local adapter. If a space has an explicit `allowed_capabilities` list,
include `home_automation` there or the executor will block every Home Assistant call.

Entity IDs and sanitized state values are retained in Open PiPi's local tool audit logs. Treat the
runtime `DATA_DIR` as household-sensitive data and restrict its filesystem and backup access. The
Home Assistant token is read only by the adapter and is never placed in tool arguments or results.

## Activate and verify

New Jeeves spaces include the subagent automatically. Existing spaces retain a pinned pack
snapshot; after upgrading, refresh it explicitly from the owner chat:

```text
/pack mutate jeeves
```

Run the secret-safe setup check:

```bash
pnpm setup:check -- --json
```

Then ask PiPi to check Home Assistant status or read one configured sensor. A control request is
delegated to `home_operator`; the physical action remains blocked until the owner answers `да` /
`yes` or uses `/approve` for the exact generated action. Open PiPi then resumes the stored canonical
call directly through the normal policy and audit path; it does not ask a model to reconstruct the
target. Approval is consumed by that single action. Only a global Open PiPi owner can access this
host-wide integration; granting someone admin rights in one space is not sufficient.

Home Assistant returning success means the service was accepted, not that hardware necessarily
moved. The adapter therefore reads the entity again and reports `accepted` and `verified`
separately. If a mutation times out, it is not retried automatically because its outcome is unknown.

## Why REST in v1

Home Assistant also provides a [WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
and an [MCP Server integration](https://www.home-assistant.io/integrations/mcp_server/). WebSocket is
the natural next step for event subscriptions and proactive state caches. MCP is useful for broader
LLM interoperability. Neither is needed for bounded command execution, and both would enlarge the
first release's protocol and permission surface.
