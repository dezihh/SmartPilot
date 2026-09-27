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
3. **Token**: im Plugin-Config-Panel auf **Open Connect Wizard** — der Wizard
   erzeugt ein Client-Token (`MCP — <Client>`), sichtbar und einzeln
   widerrufbar unter **Profil → Long-lived access tokens**. Alternativ dort
   selbst minten. Beim Minten ein Profil wählen, das **control** erlaubt
   (z. B. „Home control“).

## Parameter beim Install

| Parameter | Bedeutung | Default |
|---|---|---|
| `ma_host` | Hostname des MA-Servers | — (erforderlich) |
| `ma_port` | MCP-Port | `8095` |
| `ma_token` | Bearer-Token aus dem Wizard | — (erforderlich) |

Hinter Reverse-Proxy mit TLS: URL nach dem Install im Registry-Eintrag auf
`https://<ma-host>/mcp/v1` ändern.

## Nach der Installation

1. Tool-Registry → **Tools abfragen** — `search_tools`, `get_tool_schema`,
   `call_tool` erscheinen.
2. Monitor/Test: „spiele Musik von …" — der Agent fragt ggf. zuerst nach dem
   Player (das ist die gewünschte Kaskade).