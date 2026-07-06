# Agent Browser

Shared internal Chromium CDP sidecar for Open PiPi agents on the VPS.

Run it once on the VPS:

```sh
docker compose --project-directory /srv/projects/agent-browser -f /srv/projects/agent-browser/docker-compose.yml up -d
```

Agent containers that should use it need:

```yaml
environment:
  - CHROMIUM_CDP_URL=http://agent-browser-chromium:9222
networks:
  - default
  - agent-tools
```

and:

```yaml
networks:
  agent-tools:
    external: true
    name: agent-tools
```

The browser does not publish host ports. It is reachable only from containers attached to the internal `agent-tools` Docker network.
