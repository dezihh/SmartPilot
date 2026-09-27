# Referenz

Diese Seite ist zum Nachschlagen gedacht. Für den ersten Aufbau beginne mit
der [Installation](INSTALLATION.md).

## Admin-Tabs

| Tab | Aufgabe |
|---|---|
| Grundeinstellungen | Modelle, Laufzeitwerte und Agent-Prompts |
| Monitor / Test | Anfrage ohne Alexa ausführen und Trace ansehen |
| Vorgänge | Trigger und Antwortmodus konfigurieren |
| Funktionen | wiederverwendbare Templates erstellen und testen |
| Index-Quellen | gecachte Lesesichten konfigurieren |
| Tool-Registry | MCP-Server verbinden und Werkzeuge abfragen |
| Wartung und Pakete | Installationspakete, Backup und Restore |
| Logs | Anfragen, Route, Laufzeit und Verbrauch prüfen |

## Funktionsfelder

| Feld | Bedeutung |
|---|---|
| Name | `a-z`, `0-9`, `_`; Agentenname wird `fn_<name>` |
| Beschreibung | Übersicht und Toolbeschreibung |
| Agent-Inventory-Zeile | wann und wie der Agent die Funktion nutzt |
| Template | Jinja/Nunjucks-Ausdruck, dessen Text das Ergebnis ist |
| Parameter | optionales JSON-Schema für Agentenargumente |
| Budget | maximale Aufrufe pro Anfrage |
| Aktiv | inaktive Funktionen werden nicht angeboten oder gerendert |

Parameterlose Agentenfunktionen verwenden ein leeres Objektschema.
Argumentierte Funktionen sollten erforderliche Felder in `required` nennen.

## Template-Bausteine

| Baustein | Wirkung | Grenze |
|---|---|---|
| `index.find(query, key?)` | lokale Fuzzy-Suche, maximal acht Treffer | Snapshot kann bis TTL-Ablauf älter sein |
| `index.state(id, key?)` | Zustand als Text | nur Daten des Index |
| `index.get(id, key?)` | Eintrag samt Zusatzdaten | nur Daten des Index |
| `mcp.call(tool, args)` | MCP-Werkzeug aufrufen | exakter Toolname und gültiges Schema |
| `http(url, ttlMs?)` | HTTP GET, JSON automatisch parsen | 5 s, 100 KB Body-Limit |
| `shell(command)` | Befehl in Gateway-Laufzeit | 5 s, 4000 Zeichen |
| `fn(name)` | Funktion einbetten | Tiefe 3, Zyklusschutz |
| `args` | Funktionsargumente | Schema für Agentennutzung nötig |
| `now` | Stunde, Wochentag, Datum, Zeit | Gateway-Zeitzone |

`web_url_read` ist kein Template-Baustein, sondern ein MCP-Werkzeug des
SearXNG-stdio-Servers (`mcp-searxng`); es existiert nur, wenn dieser Server
in der Tool-Registry angebunden ist. Rezepte nutzen es für das Lesen
konkreter Treffer-URLs und Feeds (`maxLength` begrenzt den Text). Der
SSRF-Schutz des Gateways gilt für den `http()`-Baustein, nicht für dieses
MCP-Werkzeug.

Identische vorbereitete Aufrufe werden dedupliziert. Dynamische
Argumentobjekte von `mcp.call` kennen `args` und `now`, aber keine lokalen
`set`-Variablen des Templates.

Eine vollständige Übersicht über Entity-Index, HTTP-, MCP- und Paketcache
steht unter [Cache und Aktualität](CACHE.md).

## Index-Konfiguration

```json
{
  "tool": "<mcp-tool>",
  "args": {},
  "ttlMs": 60000,
  "aliases": { "gesprochen": "technisch" },
  "domainHints": [
    { "re": "temperatur|warm", "domains": ["sensor", "climate"] }
  ],
  "stopwords": ["wie", "ist"],
  "desc": "Beschreibung für die Oberfläche"
}
```

Datenformat:

```text
id|area|state|unit|name|key=value;key=value
```

Der leere Key bezeichnet den Standard-Index. Weitere Quellen verwenden einen
Namen wie `ma` und werden als zweites Argument übergeben. Benannte Quellen
liegen als Setting `entity_index_<key>` (Standard: `entity_index`).

`ttlMs` löst keinen Timer und kein Polling aus. Der Snapshot wird erst beim
nächsten Indexzugriff nach Ablauf der TTL neu geladen.

Die Basis-Werkzeuge `fn_find_entities` / `fn_get_entity` nehmen optional
`args.index` entgegen (z. B. `{"query": "lautsprecher", "index": "ma"}`).
Fällt der Key erst zur Renderzeit aus `args`, werden alle konfigurierten
Quellen vorgewärmt.

## Index-Assistent (Admin-API)

Neue Index-Quellen ohne Handarbeit entwerfen:

- `POST /admin/api/index/assist` `{ "goal": "…", "indexKey": "ma"? }` — das LLM
  liest den Tool-Katalog der MCP-Registry und entwirft ein Draft (Tool,
  Argumente, optionale Transformation, Aliase, Probefragen). Ein
  deterministischer Validator führt es probehalber aus (nur erkennbar lesende
  Tools), prüft den Datenvertrag (mindestens fünf Einträge) und lässt das LLM
  maximal dreimal nachbessern.
- `POST /admin/api/index/apply` `{ "draft": …, "indexKey": "ma"? }` — speichert
  das erneut geprüfte Draft nach Admin-Bestätigung und verwirft den Cache. Ohne
  `indexKey` landen die Werte im Standard-Index (`entity_index`), mit Key in
  `entity_index_<key>`.

## Vorgangsfelder

| Feld | Bedeutung |
|---|---|
| Name | interne Bezeichnung |
| Modus | `deterministic`, `hybrid` oder `llm` |
| Trigger-Phrasen | typische Nutzerfragen, eine pro Zeile |
| Fuzzy-Schwellwert | höhere Zahl bedeutet strengere Übereinstimmung |
| eigenes System-Prompt | ersetzt für diesen LLM-Weg das globale System-Prompt |
| Daten aus Funktion | Pflicht bei deterministisch und hybrid |
| erlaubte Tools | Tool-Schemas für LLM- und Hybrid-Weg |
| Aktiv | am Routing teilnehmen |

## Laufzeitkonfiguration

| Variable | Standard | Zweck |
|---|---:|---|
| `PORT` | `3000` | HTTP-Port |
| `DB_PATH` | `./data/meinhelfer.db` | SQLite-Datei |
| `LLM_MODEL` | – | Startmodell (Pflicht) |
| `LLM_MAX_TOKENS` | `2000` | Ausgabe-Budget |
| `LLM_REASONING_EFFORT` | leer | Reasoning-Stufe, falls das Modell sie unterstützt |
| `LLM_KEEPALIVE_MS` | `120000` | Modell warm halten; `0` = aus |
| `AGENT_CLARIFICATION_BUDGET` | `2` | Rückfragebudget |
| `MAX_TOOL_ITERATIONS` | `6` | maximale Tool-Runden |
| `LLM_TOOL_DEADLINE_MS` | `9000` | Deadline des Agent-Loops |
| `GATEWAY_PORT` | `3000` | nur Compose-Host-Mapping (der Code liest `PORT`) |

Pflichtvariablen: `AUTH_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.

## Budgets und Tool-Auswahl

Funktionen besitzen ein eigenes Budget (Spalte `budget`); die beiden
built-in-Lesewerkzeuge `fn_find_entities` (Budget 2) und `fn_get_entity`
(Budget 3) sind fest im Code verdrahtet. Bei Erschöpfung erhält das Modell
einen Fehler und der Trace einen Budget-Eintrag (`tool.budget_hit`).

Die Agent-Tool-Auswahl (Setting `agent_tools`) begrenzt die rohen
MCP-Werkzeuge: leer/`alle` = alle Werkzeuge, `keine` = keine, sonst eine
explizite Liste. Eine explizite Auswahl reduziert Promptgröße und Fehlwahl.

## Antwortvertrag

Der Core liefert eine neutrale Antwort mit:

- `speech`: gesprochener Text
- `ssml`: Kennzeichen für bereits vorhandenes SSML
- `display`: optionaler Display-Inhalt
- `followUp` beziehungsweise `keepOpen`: Session für Rückfrage offen halten

Alexa-spezifisches Wrapping und APL liegen in der AWS Lambda, nicht in
Funktionen des Gateways.

## Sicherheitsgrenzen

- Admin-Oberfläche und `/admin/*` nur im vertrauenswürdigen Netz anbieten.
- Öffentlich nur `/api/query` anbieten und mit `AUTH_TOKEN` schützen.
- Den Alexa-Trigger der Lambda auf die eigene Skill-ID beschränken.
- Secrets nur über lokale Konfiguration oder Secret Store übergeben.
- Dynamische HTTP-URLs nicht ins private Netz erlauben.
- Shell-Templates nur administrativ pflegen.
- Interne IDs nie vom Modell erfinden lassen.
- Schreibende Aktionen erst nach erfolgreichem Tool-Aufruf bestätigen.

## Weiterführende Dokumente

- `ARCHITECTURE.md` – technischer Hintergrund und Architekturregeln
- [Praxisrezepte](RECIPES.md) – aktuelle Anwendungsbeispiele
