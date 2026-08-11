# Home Assistant integration

Open PiPi can delegate smart-home requests to the bounded `home_operator` family member. The
integration uses Home Assistant's REST API through a fixed, locally configured endpoint. It is an
optional Open PiPi addon, not a replacement for Home Assistant itself.

## What it can do

- read exact allowlisted entity states;
- turn exact allowlisted `light` and `switch` entities on or off;
- set brightness from 0 to 100 for allowlisted lights;
- require one-time confirmation from the global Open PiPi owner for every physical action.

It cannot discover hidden entities, call arbitrary services, use area/device/group targets, or
administer Home Assistant. Locks, alarms, covers, garage doors, valves, sirens, cameras, buttons,
scenes, scripts, and automations are deliberately unsupported.

## Documentation

- [Set up the integration](setup.md)
- [Home Assistant documentation](https://www.home-assistant.io/docs/)
- [Home Assistant installation guide](https://www.home-assistant.io/installation/)
- [Home Assistant Raspberry Pi installation](https://www.home-assistant.io/installation/raspberrypi/)
- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant Core on GitHub](https://github.com/home-assistant/core)

## Safety boundary

The allowlist bounds only the direct REST target. A `light` or `switch` entity can represent a
[group](https://www.home-assistant.io/integrations/group/), and changing any entity can trigger a
configured [automation](https://www.home-assistant.io/docs/automation/trigger/). Do not expose
group or template entities, or entities connected to unsafe automations. Review the downstream
behavior in Home Assistant before adding an entity to the control allowlist.

Home Assistant accepting a service request does not prove the physical device moved. Open PiPi reads
the entity again and reports `accepted` and `verified` separately. Timed-out mutations are never
retried automatically because their result is unknown.
