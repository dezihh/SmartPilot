# Praxisrezepte

Diese Sammlung zeigt zwei Dinge: wie du die **mitgelieferten
Installationspakete** nutzt und wie du darauf eigene **Funktionen** aufbaust.
Die vollständigen Gegenseiten-Anleitungen stehen in den Paket-READMEs, nicht
hier.

## Pakete installieren

Fertige Erweiterungen liegen als **Installationspakete** bereit (Tab
**Wartung und Pakete** → „Installationspakete"). Ein Paket legt
Registry-Einträge, Index-Quellen und/oder Funktionen an — teils mit
Parameterformular (Host/Port/Token) und Vorschau. Die Registry wird aus
`packages/` im Repository geladen; Grundgedanke, Parametrierung und
Vertrauensmodell stehen in [`packages/README.md`](../packages/README.md).

| Paket | Liefert | Gegenseite nötig |
|---|---|---|
| `home-assistant` | HA-MCP-Registry, Standard-Index, Schalten-Kaskade | Home Assistant + `ha-mcp` |
| `music-assistant` | MA-Registry, Wiedergabe-Kaskade + ASR-Falscherkennung, `ma_players` | Music Assistant + MCP-Plugin |
| `searxng` | SearXNG-Brücke (stdio) + Such-Allowlist | SearXNG-Instanz |
| `brave-search` | Brave-Brücke (stdio) + `recherche` | Brave-API-Key |
| `open-meteo-wetter` | `wetter` | keine (öffentliche API) |
| `autobahn` | `autobahn` (Region anpassen!) | keine (öffentliche API) |
| `system-info` | `gateway_uptime`, `cpu_type` (gefährlich, `shell()`) | keine |

Vorgehen:

1. **Wartung und Pakete** → Paket wählen → Vorschau prüfen → installieren.
   Ein Paket mit `shell()` verlangt eine ausdrückliche Bestätigung.
2. Die Gegenseiten-Schritte aus `packages/de/<id>/README.md` ausführen.
3. Betroffene Artefakte prüfen: **Tool-Registry** → **Tools abfragen**,
   **Index-Quellen** → Probe, **Funktionen** → **Ausführen**.
4. Erst danach einen **Vorgang** oder Trigger darauf setzen.

„Neu installieren" ist ein Upsert: lokal geänderte Zeilen werden erkannt und
pro Element zur Entscheidung angezeigt.

## Eigene Funktionen erweitern

Die Pakete sind der Ausgangspunkt, nicht die Grenze. Eine Funktion ist ein
Jinja/Nunjucks-Template (Bausteine: [Referenz](REFERENCE.md#template-bausteine));
ein Vorgang ordnet Trigger einem Modus zu
([Grundbegriffe](CONCEPTS.md#vorgang)). Drei Grundmuster genügen für die
meisten Erweiterungen.

### Deterministisch: fester Messwert

Ergebnis: „Ist die Sonne schon untergegangen?" — feste Antwort, kein LLM.

Funktion `sonnenstand`, Vorgang Modus `deterministic`, Trigger
`sonne,sonnenstand`:

```jinja
Die Sonne ist gerade {{ 'über' if index.state('sun.sun') == 'above_horizon' else 'unter' }} dem Horizont.
```

Variante „ist jemand zuhause?" über `zone.home`:

```jinja
{%- set n = index.state('zone.home') | int -%}
{{ 'Niemand ist zuhause.' if n == 0 else ('Eine Person ist zuhause.' if n == 1 else n ~ ' Personen sind zuhause.') }}
```

### Hybrid: Daten plus Formulierung

Ergebnis: Die Zahl kommt aus der Funktion, das LLM formuliert die Einordnung.

Funktion `aussen_temperatur` — ein Attribut (`temperature`), das nicht im
Index-Pipe-Format steht:

```jinja
Aussentemperatur: {{ mcp.call('ha_eval_template', {'template': "states.weather.home.attributes.temperature"}) }} Grad.
```

Vorgang Modus `hybrid`, Trigger `wie warm draußen,außentemperatur`,
Funktion `aussen_temperatur`; System-Prompt leer lassen.

### LLM: Der Agent wählt das Werkzeug

Ergebnis: „Wie hell ist es im Wohnzimmer?" — kein Trigger deckt diese
Phrasenvielfalt ab.

Nur Werkzeuge und Allowlist nötig; die Basis-Lesetools `fn_find_entities` /
`fn_get_entity` sind im Gateway eingebaut. Regel im Agent-Inventory-Prompt des
HA-MCP-Servers (Tab **Tool-Registry**): zuerst `fn_find_entities` mit
Stichworten, dann sofort aus dem Treffer antworten (höchstens ein Aufruf);
ohne Treffer ehrlich sagen, nichts erfinden.

## Bewährte Agent-Regeln

- **Niemals raten**: IDs und URIs nur aus Tool-Ergebnissen übernehmen; bei
  Mehrdeutigkeit im Echo nachfragen.
- **Sofort antworten**: Treffer enthalten den Zustand — keine Prüf-Runden.
- **BEVOR-Regeln** (Falscherkennungen, Schalt-Kaskaden) an ihrer Quelle
  (MCP-Server-Prompt) pflegen, damit sie vor dem ersten Tool-Call wirken.
- **Zahlformate**: `| round(n) | replace('.', ',')` für gesprochene Zahlen.
- **Unbelegte Sensoren**: `unknown`/`unavailable` in Makros abfangen und
  „unbekannt" sprechen.

Weiter: [Grundbegriffe](CONCEPTS.md), [Konfiguration](CONFIGURATION.md),
[Referenz](REFERENCE.md).
