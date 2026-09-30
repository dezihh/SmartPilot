# Music Assistant Anbindung

Legt den Registry-Eintrag für das **ma-provider-mcp**-Plugin, die
**Wiedergabe-Kaskade samt ASR-Falscherkennungs-Regel** (Agent-Inventory-Prompt)
und die Funktion **`ma_players`** (Player-Liste in einem Call) an.

> **Antwortweg:** Agent (LLM) — der Agent wählt die Werkzeuge selbst.

## Was es braucht (Gegenseite)

1. Music Assistant läuft.
2. MA-Einstellungen → **Plugins** → **MCP Server** aktivieren
   ([trudenboy/ma-provider-mcp](https://github.com/trudenboy/ma-provider-mcp)).
   Das Plugin hängt sich in den MA-Webserver (`/mcp/v1`) — kein Extra-Port.
3. **Token**: im Plugin-Config-Panel auf **Open Connect Wizard**. Der Wizard
   fragt zuerst **Network** oder **Localhost/Loopback** (→ **Network** wählen)
   und danach den **AI-Client** (Auswahl egal, z. B. **Claude**) — erst dann
   erzeugt er ein Client-Token (`MCP — <Client>`) und zeigt einen fertigen
   Snippet (URL + Bearer-Header). Aus dem Snippet **nur den Token** kopieren
   (den Wert nach `Bearer `) und in SmartPilot als `ma_token` einfügen. Der
   Token ist einzeln widerrufbar unter **Profil → Long-lived access tokens**;
   alternativ dort selbst minten (Profil mit **control**-Rechten, z. B.
   „Home control“).

## Parameter beim Install

| Parameter | Bedeutung | Default |
|---|---|---|
| `ma_host` | Hostname des MA-Servers | — (erforderlich) |
| `ma_port` | MCP-Port | `8095` |
| `ma_token` | Bearer-Token aus dem Wizard | — (erforderlich) |
| `ma_default_player` | player_id, auf die sich Befehle **ohne** genannte Geräte beziehen (optional) | leer → der gerade spielende Player |

Hinter Reverse-Proxy mit TLS: URL nach dem Install im Registry-Eintrag auf
`https://<ma-host>/mcp/v1` ändern.

## Nach der Installation

1. Tool-Registry → **Tools abfragen** — `search_tools`, `get_tool_schema`,
   `call_tool` erscheinen.
2. Monitor/Test: „spiele Musik von …" bzw. „nächster Titel".

**Player-Wahl (generisch):** Ohne genanntes Gerät verwendet der Agent den
**gerade spielenden** Player und fragt **nicht** nach. Nur wenn mehrere
gleichzeitig spielen, fragt er nach. Wer einen festen Standard will, setzt
`ma_default_player` (z. B. die player_id der Hauptanlage). Wiedergabe-Steuerung
läuft über die `queue_id` (via `queue_get_active_queue`), Lautstärke/Ein-Aus
über die `player_id`.