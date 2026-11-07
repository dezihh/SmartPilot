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
| `mcp.call(tool, args, opts?)` | MCP-Werkzeug aufrufen (optional mit Ersatz-Tool) | exakter Toolname und gültiges Schema |
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

Ein optionales drittes Argument `{ fallback: 'ersatz_tool' }` richtet eine
**Kaskade** ein: Bleibt der Primär-Aufruf leer — fehlendes Tool, Fehler oder
leere/whitespace-Ausgabe —, wird automatisch das Ersatz-Tool mit denselben
Argumenten aufgerufen. Der Rückgabewert des `mcp.call` ist dann das Ergebnis
des Ersatz-Tools.

```jinja
{{ mcp.call('searxng_web_search', {'query': args.query}, { fallback: 'brave_web_search' }) }}
```

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

## Paket-Konfiguration (Admin-API)

- `GET /admin/api/packages` — installierte Pakete (Name und Kategorie aus dem
  persistierten Manifest) plus Registry-Liste.
- `GET /admin/api/packages/:id/config` — Parameter eines installierten Pakets
  (`values` mit maskierten Secrets, `params` aus dem Manifest,
  `manifestSource`: `stored` oder `registry`).
- `PATCH /admin/api/packages/:id/config` — `{ "params": { … },
  "dangerousAck": true }`. Ändert nur Parameter (`configOnly`); leere Werte
  behalten den bisherigen Stand. Ein Ack ist nötig, sobald sich der Inhalt
  eines gefährlichen Feldes ändert.

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
| `ADMIN_TOKEN` | – | Bearer-Token nur für den Admin-Bereich (Pflicht) |
| `API_TOKEN` | – | Bearer-Token nur für `/api/*` (Pflicht; muss sich von `ADMIN_TOKEN` unterscheiden) |
| `API_SIGNING_SECRET` | leer | gemeinsames HMAC-Secret mit der Alexa-Lambda; gesetzt = jede `/api/*`-Anfrage braucht `X-Timestamp`, `X-Nonce` und `X-Signature` (Replay-Schutz) |
| `API_SIGNATURE_TTL_SECONDS` | `300` | Gültigkeitsfenster einer signierten Anfrage (Uhren-Drift) |
| `PORT` | `3000` | HTTP-Port |
| `DB_PATH` | `./data/smartpilot.db` | SQLite-Datei |
| `BASE_PATH` | leer | Pfad-Prefix nur für die Admin-UI (leer = `/admin`) |
| `LLM_MODEL` | – | Startmodell (Pflicht) |
| `LLM_MAX_TOKENS` | `2000` | Ausgabe-Budget |
| `LLM_REASONING_EFFORT` | leer | Reasoning-Stufe, falls das Modell sie unterstützt |
| `LLM_KEEPALIVE_MS` | `120000` | Modell warm halten; `0` = aus |
| `AGENT_CLARIFICATION_BUDGET` | `2` | Rückfragebudget |
| `MAX_TOOL_ITERATIONS` | `6` | maximale Tool-Runden |
| `LLM_TOOL_DEADLINE_MS` | `9000` | Deadline des Agent-Loops |
| `TRUST_PROXY` | leer | Express `trust proxy` (Hops, z. B. `1`, oder `loopback`); leer = aus |
| `QUERY_MAX_CHARS` | `500` | max. Zeichen für `/api/query` (Kostenschutz) |
| `QUERY_RATE_MAX` | `30` | max. `/api/query`-Anfragen pro Minute und Client |
| `ADMIN_RATE_MAX` | `600` | max. Admin-Anfragen pro Minute und Client-IP für Admin-API **und** `/metrics` (eigene Buckets, auch fehlgeschlagene Tokens) |
| `MCP_NPM_ALLOW_SCRIPTS` | leer | `1` = Lifecycle-Skripte beim Provisionieren erlauben; Standard aus |
| `TZ` | `Europe/Berlin` | Zeitzone fuer `now.hour`/`now.date`/`now.time` im Template-Kontext |
| `MCP_FAILURE_TTL_MS` | `30000` | Sperre nach fehlgeschlagenem MCP-Init (kein erneuter Versuch im Fenster) |
| `ALEXA_SKILL_ID` | leer | erwartete Skill-ID; prüft den Header `X-Alexa-Skill-Id` der Lambda nur warnend (reine Log-Info, **keine** Sicherheitsgrenze) |
| `LOG_LEVEL` | `info` | Ausführlichkeit der Logzeilen: `debug`, `info`, `warn`, `error` (anderer Wert verhindert den Start) |
| `SESSION_MAX_HOURS` | `24` | absolute Obergrenze einer Admin-Session (Sliding-TTL verlängert sonst unbegrenzt) |
| `GATEWAY_PORT` | `3000` | nur Compose-Host-Mapping (der Code liest `PORT`) |

Pflichtvariablen: `ADMIN_TOKEN`, `API_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
`ADMIN_TOKEN` und `API_TOKEN` müssen sich unterscheiden; die Beispielwerte
(`change-me…`) und in Produktion (`NODE_ENV=production`) Tokens unter 24
Zeichen verhindern den Start.

### Replay-Schutz der Adapter-API

Ist `API_SIGNING_SECRET` gesetzt, muss jede Anfrage an `/api/query` und
`/api/lambda-trace` signiert sein:

| Header | Inhalt |
|---|---|
| `X-Timestamp` | Unix-Zeit in Sekunden |
| `X-Nonce` | 16–128 Hex-Zeichen, pro Anfrage neu |
| `X-Signature` | HMAC-SHA256 (hex) über `<timestamp>\n<nonce>\n<sha256-hex(body)>` |

Der Body wird byte-genau geprüft (Roh-Body, nicht das geparste Objekt). Eine
Signatur gilt nur innerhalb von `API_SIGNATURE_TTL_SECONDS` (Default 300,
maximal 3600) und nur einmal pro Nonce; ein voller Nonce-Cache (10 000
Einträge im Fenster) lehnt fail-closed ab.

Grenzen: Methode und Pfad sind nicht Teil der Signatur (Reverse-Proxy-Prefixe
bleiben damit unkritisch); der Nonce-Cache ist prozesslokal, bei mehreren
Gateway-Replicas wirkt der Schutz nur je Instanz.

## Budgets und Tool-Auswahl

Funktionen besitzen ein eigenes Budget (Spalte `budget`); die beiden
built-in-Lesewerkzeuge `fn_find_entities` (Budget 2) und `fn_get_entity`
(Budget 3) sind fest im Code verdrahtet. Bei Erschöpfung erhält das Modell
einen Fehler und der Trace einen Budget-Eintrag (`tool.budget_hit`).

Die Agent-Tool-Auswahl (Setting `agent_tools`) begrenzt die rohen
MCP-Werkzeuge: leer/`alle` = alle Werkzeuge, `keine` = keine, sonst eine
explizite Liste. Eine explizite Auswahl reduziert Promptgröße und Fehlwahl.

Zusätzlich begrenzt `agent_tool_limit` die Zahl der MCP-Tool-Specs pro Anfrage
deterministisch (0/leer = unbegrenzt); die Basis-Lesewerkzeuge und
`fn_*`-Funktionen bleiben immer erhalten. Die Größe des Tool-Angebots steht im
Debug-Log (`Tool-Specs`: Anzahl, Zeichen, Näherungstokens `chars/4`), die echte
Prompt-Größe in der LLM-Antwort (`usage.prompt_tokens`).

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
- Öffentlich nur `/api/query` anbieten und mit `API_TOKEN` schützen.
- Den Alexa-Trigger der Lambda auf die eigene Skill-ID beschränken.
- Secrets nur über lokale Konfiguration oder Secret Store übergeben.
- Dynamische HTTP-URLs nicht ins private Netz erlauben.
- Shell-Templates nur administrativ pflegen.
- Interne IDs nie vom Modell erfinden lassen.
- Schreibende Aktionen erst nach erfolgreichem Tool-Aufruf bestätigen.

## Weiterführende Dokumente

- `ARCHITECTURE.md` – technischer Hintergrund und Architekturregeln
- [Praxisrezepte](RECIPES.md) – aktuelle Anwendungsbeispiele
