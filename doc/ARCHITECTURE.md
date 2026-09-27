# Architektur

Stand: aus dem Code abgeleitet (Gateway `0.1.0`, Node 22 / TypeScript ESM).
Dieses Dokument beschreibt den **aktuellen** Aufbau. Bei Widersprüchen gilt der
Code; Nutzer-Doku steht in den übrigen Dateien unter `doc/`.

## Zentrale Architekturregel: Lieferanten-Muster (Adapter)

Der Core kennt **kein Alexa** und generell **keinen Sprachclient**. Alles
Client-spezifische (Request-Typen, JSON-Strukturen, Cards, APL, SSML-Wrapping)
liegt ausschließlich im Adapter **außerhalb** des Gateways:

```text
Sprachclient (Lieferant) ──▶ Adapter ──▶ VoiceQuery ─────────▶ Gateway-Core
Sprachclient (Lieferant) ◀── Adapter ◀── AssistantResponse ◀──┘
            (SSML / Card / APL)
```

Der Übergabepunkt ist die generische HTTP-Route `POST /api/query`:

```typescript
interface VoiceQuery {
  sessionId: string;
  userId?: string;
  text: string;
}

interface AssistantResponse {
  speech: string;            // für Sprachausgabe immer gesetzt
  ssml?: boolean;            // true: speech enthält fertiges SSML (Passthrough)
  display?: DisplayPayload;  // optional, siehe unten
  followUp?: boolean;        // true: Session offen halten (Rückfrage)
  followupPrompt?: string;   // konkrete Rückfrage der Engine (situativ)
  keepOpen?: boolean;        // LLM-Signal, dass die Antwort nachfrageoffen ist
}
```

### Lieferanten-Agnostik (Design-Prinzip)

Das Gateway weiß **nicht**, von wem ein Auftrag kommt — es bekommt eine
`VoiceQuery` und liefert eine `AssistantResponse`. „Lieferant" ist damit
austauschbar:

- **Heute implementiert:** der **Alexa-Adapter** (AWS Lambda, `alexa/`, siehe
  unten). Er übersetzt Alexa-Requests in `POST /api/query` und die Antwort
  zurück in SSML/Card/APL.
- **Konzeptionell möglich, heute nicht vorhanden:** jeder weitere Lieferant,
  z. B. ein **Google-Assistant-Adapter**, ein Web-Adapter, ein eigener
  Voice-Adapter oder ein API-Client. Er müsste nur seine Eingaben auf
  `VoiceQuery` abbilden und `POST /api/query` aufrufen — **der Core bleibt
  unverändert**.

Voraussetzung dafür ist, dass weder Core noch MCP-/Template-Schicht
Client-Wissen enthalten. Deshalb existiert im Gateway keine Alexa-Route und
keine Alexa-Signaturprüfung mehr; diese Verantwortung liegt vollständig beim
Adapter.

## Komponenten und Repo-Layout

| Pfad | Rolle |
|---|---|
| `gateway/` | Node-22-Gateway (TypeScript ESM, Express 5, better-sqlite3, nunjucks): Core, MCP-/LLM-Anbindung, Admin-API/-UI |
| `alexa/` | Alexa-Adapter: `lambda/` (Python, ask-sdk), `skill-package/` (Interaktionsmodell + Manifest), `scripts/` (Skill-Sync) |
| `packages/` | Installationspakete, sprachspezifisch unter `packages/<lang>/<id>/` (Registry für die Admin-UI) |
| `doc/` | Diese Dokumentation |

Gateway-Module unter `gateway/src/`:

- `server.ts`, `config.ts`, `auth.ts`, `rateLimit.ts`, `version.ts`, `types.ts`
- `routes/{query,admin,mcp,packages}.ts`
- `core/{engine,router,template,extract,response,session,tools,inventory,indexTools,entityIndex,indexAssistant,packages,httpCache,normalize,usage}.ts`
- `llm/client.ts`, `mcp/{client,stdio,registry}.ts`
- `db/schema.ts` + `db/{actions,functions,mcpServers,settings,logs,packages}.ts`
- `web/` — Admin-UI (Vanilla JS)

## Pipeline (`core/engine.ts` → `processQuery`)

```text
POST /api/query  (VoiceQuery)
  ▼
1. Chat-/OneShot-Umschaltung (Regex, Session-Zustand) ──▶ route "chat"
  ▼
2. Router: Action-Treffer? (Bigram-Ähnlichkeit, Fuzzy global, Kombi-Erkennung)
  │   ├─ Treffer ──▶ executeAction ──▶ route "action"
  │   │       deterministic: nur Funktion rendern
  │   │       llm:           Tool-Loop mit system_prompt + Tool-Allowlist
  │   │       hybrid:        Funktion rendern, LLM formuliert sprachlich um
  │   └─ kein Treffer ──▶ runAgent ──▶ route "agent"  (freier Tool-Loop)
  ▼
3. Nachbereitung: withSsmlBreaks → withDisplay
  ▼
4. FollowUp-Entscheidung (Chat-Modus bzw. Setting session_followup)
  ▼
5. addLog(...) mit Route, Latenz, Trace, Token-Usage
  ▼
EngineResult { response, route, actionId?, score?, durationMs, trace }
```

- **Router** (`core/router.ts`): normalisiert (lowercase, Satzzeichen weg),
  Treffer per Gleichheit/Enthaltensein/Bigram-Ähnlichkeit; kombinierte
  Anfragen („und/sowie/&“/Komma) überspringen deterministische Actions und
  gehen an den Agenten.
- **Kombinierte Anfragen** nutzen das Tool-Inventory des Agenten.
- **`POST /admin/api/query`** ruft denselben Handler (für Tests/UI).

## Agent-Tool-Loop und LLM

- **LLM-Client** (`llm/client.ts`): eigener OpenAI-kompatibler Client gegen
  `POST {LLM_BASE_URL}/chat/completions` (mit Tool-Calling) — **kein litellm**.
  Modell/Token/Reasoning stammen aus Env bzw. überschreibenden DB-Settings
  (`llm_model`, `llm_max_tokens`, `llm_reasoning_effort`). Tool-Runden können
  ein eigenes, schnelles Modell nutzen (`tool_model`).
- **Tool-Loop** (`runToolLoop`): baut Tool-Specs (`buildTools`), schickt sie
  mit System-Prompt + Gedächtnis an das LLM, führt Tool-Calls **parallel** aus,
  zählt Budgets pro Tool, respektiert ein Gesamt-Deadline
  (`tool_deadline_ms`, Hälfte für Tool-Runden, Hälfte für Formulierung) und
  erzwingt in der letzten Runde die finale Formulierung. Timeouts werden
  abgefangen (ein Retry-Round, sonst Zeitüberschreitungs-Antwort).
- **Tool-Quellen** (`core/tools.ts`):
  1. **Basis-Werkzeuge** `fn_find_entities` / `fn_get_entity` (fest im Code,
     immer angeboten, außer bei explizit leerer Allowlist),
  2. **MCP-Tools** aus der Registry (Namensbereinigung, serverpräfixte Namen
     bei Kollisionen, hart geblockte Tools via `LLM_BLOCKED_TOOLS`),
  3. **registrierte Funktionen** als `fn_<name>` mit optionalem Parameter-Schema.
- **Allowlist-Semantik** (Setting `agent_tools`): nicht gesetzt / `alle` = alle
  Tools, `keine` = keine, sonst Komma-Liste. Actions haben zusätzlich ihre
  eigene `tools`-Liste. Budgets (`budget`-Spalte) begrenzen Aufrufe pro Frage.
- **Agent-Antwortformat**: JSON `{ "needs_clarification", "speech", "keep_open" }`
  (`parseAgentAnswer`, toleriert Text-Reste und filtet Leaks).

## MCP-Schicht (`mcp/`)

- **Transporte**: **Streamable HTTP** (`McpClient`, Bearer-Token optional,
  `mcp-session-id`, SSE-Antworten) und **stdio** (`McpStdioClient`, spawnt
  Prozess, JSON-RPC über stdin/stdout, Timeout 60 s).
- **Registry** (`getMcpContext`): lädt je aktivem Server `initialize` +
  `tools/list`, hält sie im Cache („serve-stale": liefert sofort den letzten
  Stand, aktualisiert im Hintergrund nach 300 s) und isoliert Fehler pro
  Server. `side_effect: read|write` steuert die Index-Invalidierung.
- **Discovery-Vertrag**: Tools werden automatisch zu LLM-Specs und
  Admin-UI-Einträgen; Zielsysteme liefern vollständige JSON-Schemas.

## Funktionen, Templates und Bausteine

Jinja2/nunjucks bekommt **keinen direkten MCP-Zugriff**, sondern feste
Bausteine. Der Template-`preheat` (`core/extract.ts` + `core/template.ts`)
findet alle datenholenden Aufrufe statisch und führt sie **parallel** vor dem
Rendern aus:

- `index.find` / `index.state` / `index.get` — lokale, gecachte Lesesicht
- `mcp.call(tool, args)` — gezielter MCP-Aufruf (auch mit dynamischen Args)
- `http(url, ttlMs?)` — generischer GET (Timeout + Größen-Cap; **dynamische**
  URLs mit SSRF-Schutz gegen private Netze; TTL-Cache)
- `shell(command)` — Admin-only, Timeout 5 s + Output-Cap
- `fn(name)` — Einbettung anderer Funktionen (Tiefe ≤ 3, Zyklus-Erkennung)
- `args`, `now` — Argumente bzw. Gateway-Zeit

Rückgabe: `AssistantResponse`. Erkennt der Renderer `<speak>…</speak>` oder
ein `{"speech": …}`-Objekt, setzt er `ssml: true` bzw. übernimmt Display-Daten
(inkl. Unwrap alter Envelope-Formen).

## Entity-Index (`core/entityIndex.ts`, `core/indexTools.ts`)

- **Generisch und systemneutral**: pro Index wird **ein** parametrierter
  MCP-Call je TTL-Fenster ausgeführt (Default 60 s) und lokal interpretiert.
- **Datenvertrag** pro Zeile: `id|area|state|unit|name|key=value;key=value…`.
- **Configuration statt Code**: Setting `entity_index` (Default-Index) bzw.
  `entity_index_<key>` (Multi-Index, z. B. `ma`) enthält `tool`, `args`,
  optional `transform` (nunjucks: JSON → Pipe-Zeilen für reine JSON-Server),
  `ttlMs`, `aliases`, `domainHints`, `stopwords`. Der Code-Default ist **leer**
  (kein Tool) — die Anbindung eines Systems (HA, Music Assistant, …) ist reine
  Konfiguration, kein Sonderfall.
- **Fuzzy-Suche** (Umlaut-Folding, Aliase, Domain-Hints, Stopwords) läuft im
  RAM (< 1 ms); Treffer werden sprechbar formatiert.
- **Basis-Werkzeuge** `fn_find_entities` / `fn_get_entity` sind fest im Code
  (nicht mehr geseedet) und unzerstörbar.
- **Index-Assistent** (`core/indexAssistant.ts`, `POST /admin/api/index/assist`
  + `/index/apply`): das LLM entwirft ein Draft, ein **deterministischer
  Validator** prüft es live gegen Server und Datenvertrag (nur erkennbar
  lesende Tools, max. 3 Self-Correction-Iterationen); gespeichert wird erst
  nach Admin-Bestätigung.

## Tool-Inventory und Prompts

- Der Fähigkeits-Katalog des Agenten wird **generiert** (`core/inventory.ts`):
  aus dem `inventory_prompt` der registrierten Funktionen und dem
  `inventory_prompt` der MCP-Server. Der Prompt `agent_inventory` ist der
  Regel-Block mit Marker `{{AGENT_FNS}}`.
- Prompts liegen in der DB (`prompts`): `agent_system`, `agent_inventory`.
  Der Assistenten-Name kommt aus dem Setting `assistant_name` (Platzhalter
  `{assistant_name}`). Seed-Texte für frische Installationen:
  `db/seeds.ts`.

## SSML, Display und Response-Nachbearbeitung

- **Der Core arbeitet sprachneutral**; `AssistantResponse.speech` ist
  standardmäßig Klartext. Enthält eine Quelle fertiges SSML, wird `ssml: true`
  gesetzt und unverändert durchgereicht.
- **`withSsmlBreaks`** (`core/response.ts`) wandelt mehrteiligen Klartext
  (Absätze/Listen bzw. lange Sätze ≥ 150 Zeichen) in
  `<speak>…<break/>…</speak>` um.
- **`withDisplay`** füllt `display` (Titel aus Setting `display_title`, Text
  aus speech, SSML zu Klartext bereinigt).
- **Das SSML-/Card-/APL-Wrapping macht der Adapter** (Alexa-Lambda), nicht der
  Core — kein Doppel-Wrapping, kein Escaping von gültigem SSML.

## Authentifizierung: getrennte Ebenen

| Ebene | Umsetzung im Code |
|---|---|
| **Client-Auth** (Sprachclient → Adapter) | liegt beim Adapter: die Alexa-Lambda nutzt den eingebauten ask-sdk-Skill-ID-Verifier (`applicationId` gegen `alexa_skill_id`). Das Gateway hat **keinen** Client-Endpunkt. |
| **API-/Admin-Auth** (`/api/*`, `/admin/*`) | Bearer-Token (`AUTH_TOKEN`, constant-time via `timingSafeEqual`); Admin-UI zusätzlich per Session-Cookie (`HttpOnly`, `SameSite=Lax`, `Path=/admin`, 12 h) |
| **Admin-Login** (`POST /admin/login`) | Token → Session-Cookie, rate-limited (10 Versuche/Minute pro IP) |
| **MCP-Server-Auth** (Gateway → MCP) | je Server: ohne Token (LAN-intern) oder Bearer-Token in der Registry; stdio über `env` |

Beide Ebenen sind bewusst getrennt: Client-Authentifizierung sagt „welcher
Skill/Lieferant“, die API-Auth „welcher Aufrufer darf das Gateway nutzen“. Eine
spätere Trennung von Client-Auth und User-Identität bleibt möglich.

## Berechtigungen

```text
Quellsystem (z. B. Home Assistant)
└── Welche Entities/States darf MCP sehen?   (Steuerung des Quellsystems)

Gateway
└── Welche Tools darf das LLM nutzen?         (agent_tools / Action-tools / fn_Budgets)
```

Das Gateway baut **keine zweite Entity-Berechtigungsschicht** nach. Zusätzlich
blockt `LLM_BLOCKED_TOOLS` einzelne Tool-Namen hart aus dem Agent-Katalog.

## Datenmodell (SQLite)

Schema in `db/schema.ts` (Init + idempotente Migrationen inline):

| Tabelle | Inhalt |
|---|---|
| `mcp_servers` | MCP-Registry (Name, URL, Token, `transport` http/stdio + command/args/env, `inventory_prompt`, `side_effect`, aktiv) |
| `actions` | Vorgänge: `mode` (deterministic/llm/hybrid), Trigger, `system_prompt`, `function_ref` + `function_args`, `tools`, Flags |
| `tpl_functions` | Funktions-Registry: `template`, Parameter-Schema, `budget`, `inventory_prompt`, `side_effect` |
| `prompts` | `agent_system`, `agent_inventory` |
| `settings` | Laufzeit-Einstellungen (u. a. `assistant_name`, `fuzzy_global`, `session_followup`, `memory_turns`/`memory_minutes`, `agent_tools`, `entity_index*`, `registry_language`) |
| `packages` / `package_items` | Provenienz installierter Pakete (Version, Quelle, Hashes der angelegten Artefakte) |
| `logs` | Request-Log (Route, Latenz, Trace, Token-Usage) |

Credentials pragmatisch per `.env`/Env-Vars; MCP-Token in der Registry.

## Admin-API und Admin-UI

- Routen unter `/admin/api/*` (alle mit `requireAuth`): `bootstrap`,
  `settings` (+ `restore-defaults`), `actions`, `functions` (+ `preview`),
  `indexes` (+ `index/assist`, `index/apply`), `mcp-servers` (+ `health`),
  `tools`, `prompts`, `logs`, `usage`, `packages/*` (+ `backup`/`restore`).
- Statische Admin-UI (`web/`) hinter Session-Auth; Admin-Zugriff bedeutet
  bewusst weitreichende Kontrolle (Templates mit `shell`, stdio-MCP).

## Installationspakete (`packages/`, `core/packages.ts`, `db/packages.ts`)

- **Zweck**: fertige, generische Rezepte (MCP-Server + Index + Funktionen +
  Allowlist) statt Handarbeit. Quelle: das Repo selbst über
  `raw.githubusercontent.com/.../packages/<lang>/<id>/` (Setting
  `registry_language`, Default `de`), alternativ **Offline-Import**.
- **Manifest** (`manifest.json`): `id`/`version` (semver), Anzeige- und
  Vertrauensfelder (`author`, `license`, `homepage`, `changelog`),
  `minGatewayVersion` (erzwungen), `params` (`${key}`-Substitution),
  `servers`/`functions`/`indexes`, `allowTools`.
- **Sicherheit/Vorschau**: `shell()`-Templates gelten als **gefährlich** und
  verlangen eine Bestätigung (`dangerousAck`); `http()` als Info. Installation
  ist Dry-Run-fähig, Upsert mit Konflikt-Entscheidungen pro Element
  (`know`-Abgleich über `content_hash`), Deinstallation, JSON-Backup/Restore.

## Externe Dienste und Konfiguration

- **LLM**: OpenAI-kompatibler Endpunkt (`chat/completions`) — Env
  `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (Pflicht).
- **MCP-Server**: beliebige Server (HTTP oder stdio), die per Registry
  angebunden werden. Home Assistant, Music Assistant usw. kommen als Paket.
- **`.env`** (Pflicht): `AUTH_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`,
  `LLM_MODEL`. **Optional**: `PORT`, `DB_PATH`, `LLM_MAX_TOKENS`,
  `LLM_REASONING_EFFORT`, `LLM_TOOL_DEADLINE_MS`, `MAX_TOOL_ITERATIONS`,
  `AGENT_CLARIFICATION_BUDGET`, `LLM_KEEPALIVE_MS`.
- **DB-Settings** überschreiben zur Laufzeit (u. a. Modell, Token-Budget,
  Fuzzy, Gedächtnis, Followup).

Fachliche Dienste (Wetter, Verkehr, Suche …) sind bewusst **nur allgemein**
über Template-Bausteine bzw. Pakete angebunden und austauschbar; konkrete
Endpunkte/Rezepte stehen in [Praxisrezepte](RECIPES.md).

## Conversation State und Gedächtnis

- In-Memory-History pro `sessionId` (`core/session.ts`): gekappt
  (`HISTORY_MAX_MESSAGES`), TTL 2 h, harter Session-Deckel; zusätzlich ein
  Chat-Modus-Flag.
- **DB-Recall** über die letzten Agent-Logs (`recentAgentTurns`), wenn keine
  In-Memory-History vorliegt; ältere Turns werden als „alt“ markiert.
- Steuerung über Settings `memory_turns`, `memory_minutes` und
  `session_followup` (`llm`/`keyword`/`beides`). Der Chat-Modus
  („starte chat modus“ / „chat beenden“, Regex in der Engine) hält die Session
  offen.

## Trace und Logging

Jede Anfrage wird geloggt (`logs`): Query, Route, Action/Score, Latenz,
Antwort und `trace` (u. a. `route.*`, `tool.call/error/budget_hit`, `llm.usage`,
`template.mcp/http/shell/index/state`, `fn.*`). `llm.usage`-Events speisen die
Token-/Cache-Auswertung (`summarizeUsage`, Admin `GET /admin/api/usage`).

## Alexa-Adapter (heutiger Lieferant, `alexa/`)

- **Lambda** (`lambda_function.py`, Python, ask-sdk): ruft `POST /api/query`
  mit Bearer-Token auf, übersetzt `EngineResult`/`AssistantResponse` zurück.
  Watchdog + Warteton (Progressive Response), Timeouts gegen das
  8-s-/Alexa-Fenster; lediglich die primäre Locale ist de-DE (weitere Sprache =
  zusätzlicher `STRINGS`-Eintrag + Interaktionsmodell).
- **Anzeige**: SimpleCard immer, APL-Dokument für Echo-Show-Geräte (das sich
  nach `apl_exit_delay_ms` selbst beendet); rohe Request-Interfaces werden für
  die APL-Erkennung gepuffert.
- **Client-Auth**: eingebauter Skill-ID-Verifier (`alexa_skill_id`).
- **`/api/lambda-trace`**: Fire-and-forget-Lebenszyklus-Log (Invoke/Antwort),
  nur bei Setting `debug_logging=1` persistiert.

## Betrieb und Tests

- **Docker**: Wurzel-`docker-compose.yaml` (Runtime-Target, Port via
  `GATEWAY_PORT`), `gateway/docker-compose.yml` (Dev-Target, tsx-watch,
  Volume-Mount `.:/app`).
- **Tests**: `gateway/test/*.test.ts` mit `node:test`/`node:assert/strict`
  (`npm test`), Typecheck `npm run typecheck`, Build `npm run build`. Der
  Lambda-Adapter hat eigene Python-Tests unter `alexa/lambda/`.
