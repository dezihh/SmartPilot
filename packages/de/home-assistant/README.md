# Home Assistant Anbindung

Legt den Registry-Eintrag für den **ha-mcp**-Server, den **Entity-Index** (Standard-Index liest alle HA-States) und die **Schalten-Kaskade** als Agent-Inventory-Prompt an und hakt die HA-Werkzeuge in der Tool-Allowlist an.

> **Antwortweg:** Agent (LLM) — der Agent wählt die Werkzeuge selbst.

## Was es braucht (Gegenseite)

Home Assistant erreichbar und **ha-mcp** installiert — zwei Methoden:

- **Docker (HTTP server)** — die Methode, für die dieses Paket vorkonfiguriert ist:

  ```yaml
  ha-mcp:
    image: ghcr.io/homeassistant-ai/ha-mcp:latest
    container_name: ha-mcp
    restart: unless-stopped
    command: ha-mcp-web          # HTTP-Modus (Streamable HTTP)
    ports:
      - "8086:8086"              # Host-Port frei waehlen
    env_file:
      - ./mcp.env                # enthaelt das Home-Assistant-Long-Lived-Access-Token
    volumes:
      - ./data:/home/mcpuser/.ha-mcp
    environment:
      - TZ=Europe/Berlin
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8086/mcp/settings', timeout=5)"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
  ```

- **HA-MCP Custom Component** (Home Assistant OS/Supervised): über HACS
  (`homeassistant-ai/ha-mcp-integration`), läuft in-process — einfacher, ohne
  Token-Verwaltung. **Nur eine Methode gleichzeitig betreiben.**

## Wichtiger Hinweis zum Token

Das **Home-Assistant-Long-Lived-Access-Token** gehört nur in die Container-Env
(`mcp.env`) — der ha-mcp nutzt es selbst, um HA zu bedienen. Das
Gateway-Feld **Auth-Token bleibt leer**.

## Parameter beim Install

| Parameter | Bedeutung | Default |
|---|---|---|
| `ha_host` | Hostname/IP des HA-MCP-Servers | — (erforderlich) |
| `ha_port` | Port des ha-mcp-HTTP-Endpunkts | `8086` |

## Nach der Installation

1. Tool-Registry → **Tools abfragen** — die `ha_*`-Werkzeuge erscheinen.
2. Monitor/Test: „wie warm ist es im Wohnzimmer" / „mach das Licht im Bad aus".

Details: <https://github.com/homeassistant-ai/ha-mcp>