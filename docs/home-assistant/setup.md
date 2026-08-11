# Set up Home Assistant for Open PiPi

This guide assumes Home Assistant and Open PiPi run on the same Raspberry Pi or private home
network. First install and operate Home Assistant using its official
[installation guide](https://www.home-assistant.io/installation/); for a Raspberry Pi, use the
[Raspberry Pi instructions](https://www.home-assistant.io/installation/raspberrypi/). Source and
issue tracking for Home Assistant Core are at
[github.com/home-assistant/core](https://github.com/home-assistant/core).

## 1. Create a dedicated Home Assistant identity

1. Create a dedicated, non-admin Home Assistant user for Open PiPi. Do not share a personal user.
2. Sign in as that user and create a long-lived access token from its profile Security page.
   Home Assistant documents the process in its
   [Authentication API](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token).
3. In Home Assistant, find the exact entity IDs to expose under **Settings > Devices & services >
   Entities**.

Keep the token private. Never send it in Telegram, add it to a prompt, or commit it to Git.

## 2. Configure Open PiPi

Copy the example values into the private runtime environment used by Open PiPi (never commit a
real `.env` file):

```dotenv
HOME_ASSISTANT_URL=http://127.0.0.1:8123
HOME_ASSISTANT_TOKEN=replace-with-a-long-lived-token
HOME_ASSISTANT_READ_ENTITIES=sensor.hall_temperature,sensor.living_room_humidity
HOME_ASSISTANT_CONTROL_ENTITIES=light.kitchen,switch.coffee
HOME_ASSISTANT_TIMEOUT_MS=5000
```

Both entity lists are exact and default-deny. Control entities are also readable. Leave
`HOME_ASSISTANT_CONTROL_ENTITIES` empty for a read-only integration. The adapter uses documented
Bearer authentication and state/service endpoints from the
[Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/).

For a native Open PiPi process on the same Pi, `http://127.0.0.1:8123` is normally correct. If Open
PiPi runs in a container, that address points to the container itself, not the Pi host. Use a private
Home Assistant service name or LAN address reachable from that container. Do not expose port 8123
directly to the internet.

## 3. Activate and verify

Run the secret-safe configuration check, then restart Open PiPi:

```bash
pnpm setup:check -- --json
```

New Jeeves spaces already include `home_operator`. Existing spaces keep a pinned pack snapshot; from
the owner chat, refresh it once:

```text
/pack mutate jeeves
```

Start with a read, such as “what is the hall temperature?”. A control request is delegated to
`home_operator` and is blocked until the global Open PiPi owner explicitly approves that exact
action with `да` / `yes` or `/approve`. The approval is single-use and Open PiPi resumes the stored
canonical call through the normal policy and audit path; it does not ask a model to recreate the
target.

## 4. Operational notes

- If a space sets an explicit `allowed_capabilities` list, include `home_automation`; it is separate
  from general browser access.
- Entity IDs and sanitised state values are stored in Open PiPi's local audit logs. Restrict access
  to `DATA_DIR` and its backups as household-sensitive data.
- The Home Assistant token stays in the adapter configuration and is never placed in tool arguments
  or results.
- For broader Home Assistant development, see the official
  [developer documentation](https://developers.home-assistant.io/) and
  [configuration documentation](https://www.home-assistant.io/docs/configuration/).
