# Changelog

Alle nennenswerten Änderungen an SmartPilot werden hier festgehalten —
Mensch-lesbar, neueste zuerst. Format angelehnt an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/); Versionen folgen
[SemVer](https://semver.org/lang/de/). Das Gateway trägt seine Version in
`gateway/package.json`; Pakete versionieren sich separat in ihren
`manifest.json`.

Beitrag mit nennenswerter Änderung? Bitte unter `[Unreleased]` eintragen
(siehe [CONTRIBUTING.md](CONTRIBUTING.md)).

## [Unreleased]

### Geplant

- Native Alexa-Anbindung ohne Skill-Namen (Ausbau, siehe README „Warum es
  SmartPilot gibt")
- Weitere Sprachen: `packages/en/`, Interaktionsmodelle weiterer Locales,
  Sprechtexte der Lambda (derzeit nur `de-DE`)
- Signaturen bzw. eine geprüfte Paket-Registry (Ausbau laut
  [packages/README.md](packages/README.md))

## [0.1.2] – 2026-09-28

### Hinzugefügt

- Reverse-Proxy-Betrieb: die statische Admin-UI (`/admin/`) akzeptiert jetzt
  auch das Bearer-Token, nicht nur den Session-Cookie. Ein vorgelagerter Proxy
  (z. B. tinyauth/Authelia) kann `Authorization: Bearer <AUTH_TOKEN>` setzen und
  den App-Login überspringen; das Token bleibt proxy-seitig und gelangt nie in
  den Browser (Issue #10)

### Behoben

- Hilfe nennt nur noch tatsächlich eingerichtete Fähigkeiten: bei leerem
  Nachschlagewerk wird kein roher Marker mehr an das LLM gegeben (kein Erfinden
  von Fähigkeiten); der Hilfe-Vorgang beschreibt jetzt alle eingerichteten
  Funktionen und Systeme und führt sonst nur die Grundfunktionen auf
- Standard-Datenbankpfad von „meinhelfer.db" auf „smartpilot.db" umgestellt
  (`config.ts`, `.env.example`, Doku)
- Hilfe-Inventory: nur ein Vorgang mit Nachschlagewerk-Marker und ohne eigene
  Tools (Hilfe) zeigt alle Systeme; andere Vorgänge bleiben auf ihre Tool-Liste
  begrenzt (F-D1)
- Hilfe-Prompt-Migration ersetzt nur die alte Seed-Formulierung und lässt
  Nutzer-Anpassungen unangetastet (F-D2)
- `lambda-zip.yml`: Dispatch-Version über `env` statt Shell-Interpolation (F-D3);
  versionierte Releases tragen den „Latest"-Badge, das rollende `latest` ist ein
  reiner Alias (F-D7)
- Bearer-Parsing zentral in `auth.ts` (`bearerToken`) statt dupliziert (F-D4)
- `.gitignore`: `/AGENTS.md` nur im Repo-Root verankert (F-D5)
- Ohne `DB_PATH` wird eine vorhandene `meinhelfer.db` weiterverwendet, statt eine
  leere `smartpilot.db` anzulegen (F-D6)

## [0.1.1] – 2026-09-27

Nachbesserungen aus dem Sicherheits-/Qualitäts-Audit. Kein neues
Funktionsverhalten, aber mehrere Sicherheits- und Robustheitskorrekturen.

### Behoben — Sicherheit

- SSRF-Härtung: `isPrivateHost` erkennt Dezimal-/Hex-/IPv6-Schreibweisen
  privater Adressen; dynamische `http(...)`-URLs werden vorab aufgelöst,
  private Ziele blockiert und die geprüfte IP im Request **gepinnt**
  (Schutz vor DNS-Rebinding, F-07)
- Der Template-`preheat` führt `shell()`/`mcp.call()` nicht mehr aus
  Jinja-Kontrollblöcken (`if`/`for`/`macro`/`call`, `raw`/`verbatim`) aus;
  gerenderte Blöcke (`filter`/`autoescape`/`block`) bleiben erhalten
  (F-01/F-36)
- Admin-API maskiert `auth_token` **und** `env` der MCP-Server; der
  Backup-Export liefert Secrets nur mit `?tokens=1` (F-09/F-29/F-34)
- `/admin/login` gibt die Session-ID nicht mehr im Antwort-Body zurück
- stdio-MCP gibt den Kindprozess nach stdin-`EPIPE` frei (kein Prozess-Leck,
  F-37)

### Behoben — Robustheit

- LLM-Aufrufe haben ein Default-Timeout (9 s, F-08); der MCP-Kontext wird
  nur im MCP-Zweig geladen (F-11)
- Entity-Index: Single-Flight bei parallelen Kaltabrufen und
  Stale-while-error mit Altersgrenze `max(10 × ttl, 5 min)` (F-15/F-38)
- MCP-Registry: Kaltstart-Guard gegen doppelte Initialisierung (F-32);
  stdio-`stdin`-Fehler und übergroße HTTP-Antworten werden sauber
  abgefangen (F-16/F-14)
- `isError`-Ergebnisse aus `tools/call` werden als Fehler behandelt (F-13);
  SSML-Entities werden dekodiert (F-06/F-25); `fuzzy_threshold` wird auf
  `(0,1]` begrenzt (F-03)
- `/api/lambda-trace` loggt nur noch eine Feld-Whitelist statt des ganzen
  Bodys (F-30)

### Geändert

- `createApp()` aus `server.ts` extrahiert — die Routen sind ohne
  Serverstart testbar
- Runtime-Container läuft als non-root (Nutzer `node` via `gosu`)
- `undici` als direkte Abhängigkeit auf Major 6 (wie Node 22) konsolidiert

### Tests / CI

- Testdateien werden unter strikter TypeScript-Konfiguration geprüft
  (`npm run typecheck:tests`); CI-Workflow für Typecheck + Tests
- Neue Proben: Audit-Findings, Routen (Auth/Admin/MCP/Query),
  Index-Assistent, Entity-Index-Robustheit, stdio-Regressionen

## [0.1.0] – 2026-09-27

Erste dokumentierte Fassung. Der lokale Weg (Gateway + Testmonitor + Pakete)
ist stabil und getestet; die Alexa-Anbindung läuft produktiv mit eigener
AWS-Lambda. Grundlage ist der Architektur-Review vom 2026-09-06
(Improvement-Issues #3–#6, siehe
[doc/ARCHITECTURE.md](doc/ARCHITECTURE.md)).

### Gateway

- `POST /api/query` als einziger Adapter-Eingang (Bearer-Token
  `AUTH_TOKEN`, constant-time Vergleich); Admin-Oberfläche mit
  Session-Login (HttpOnly, 12 h), Rate-Limit und JSON-Body-Limit (1 MB)
- Router mit drei Antwortwegen pro Vorgang: `deterministic`, `hybrid`,
  `llm` — Trigger-Phrasen mit Fuzzy-Schwellwert, ohne Treffer übernimmt
  der Agent
- LLM-Agent mit eigenem OpenAI-kompatiblen Client (kein litellm) und
  Tool-Loop: `MAX_TOOL_ITERATIONS=6`, `LLM_TOOL_DEADLINE_MS=9000`,
  Rückfrage-Budget `AGENT_CLARIFICATION_BUDGET=2`
- Rückfragen bei Mehrdeutigkeit halten den Kanal offen
  (`needs_clarification`/`keepOpen`); Chat-Modus per
  „starte chat modus" / „chat beenden"; Kurzzeitgedächtnis pro Session
  (`session_followup`: llm/keyword/beides)
- Template-Bausteine für Funktionen: `index.find/state/get`, `mcp.call`,
  `http(url, ttlMs?)`, `shell()` (gefährlich, 5 s / 4000 Zeichen),
  `fn()` (Tiefe 3), `args`, `now`
- Entity-Index mit TTL, Aliase, Domain-Hints, Stopwords; eingebaute
  Lesetools `fn_find_entities`/`fn_get_entity` (Budget 2/3); Index wird
  nur bei schreibenden Aufrufen (`sideEffect: write`) invalidiert
- Index-Assistent: LLM entwirft Index-Bindungen, deterministischer
  Validator prüft live (max. 3 Nachbesserungen), Speichern erst nach
  Admin-Bestätigung
- MCP-Registry für Streamable-HTTP- und stdio-Server; Katalog-Cache mit
  5-Minuten-Frischegrenze, Hintergrund-Refresh
- Caches: Entity-Index (TTL), HTTP-Cache (max. 200 Einträge),
  MCP-Katalog, Paket-Registry (60 s) — alles bedarfsgesteuert, kein
  Polling (siehe [doc/CACHE.md](doc/CACHE.md))
- SQLite-Datenmodell: `mcp_servers`, `actions`, `prompts`, `settings`,
  `logs`; Admin-Tabs für Grundeinstellungen, Monitor/Test, Vorgänge,
  Funktionen, Index-Quellen, Tool-Registry, Wartung und Pakete, Logs

### Pakete

- Paket-Registry unter `packages/de/` mit Parametrierung (`params` +
  `${key}`), erzwungenem `minGatewayVersion`, `dangerousAck` für
  `shell()`-Pakete und Upsert-Install („Neu installieren" erkennt lokale
  Änderungen); Grundgedanke und Vertrauensmodell in
  [packages/README.md](packages/README.md)
- Sieben Pakete: `home-assistant`, `music-assistant`, `searxng`,
  `brave-search`, `system-info`, `open-meteo-wetter` (1.0.1), `autobahn`
  (1.0.1)

### Alexa

- Dünne AWS-Lambda (Python, ask-sdk) als einziger Alexa-Adapter; sie ruft
  `POST /api/query` auf — die frühere Gateway-Route `/alexa` samt
  Signaturprüfung ist entfernt
- Skill-ID-Prüfung in der Lambda (`applicationId`, ASK-SDK-Verifier) und
  auf die Skill-ID begrenzter Alexa-Trigger
- Zwei Wege: Alexa-hosted (Weg A) und eigene AWS-Lambda (Weg B,
  empfohlen); Sprache derzeit `de-DE`
- CI/CD über GitHub Actions: `lambda-zip`, `deploy-aws-lambda`,
  `sync-manifest`, `sync-model`, `ext-check` sowie Debug-Workflows
  (siehe [doc/DEPLOYMENT.md](doc/DEPLOYMENT.md))

### Geändert (gegenüber dem POC)

- Template-Bausteine heißen systemneutral `index.*`/`mcp.call`/`http`/
  `shell`/`fn` (statt `ha.*`); der Gateway-Code enthält keinen
  Systembezug mehr — Fähigkeiten kommen ausschließlich über MCP,
  HTTP- oder Shell-Bausteine
- Modus `search_summary` entfernt; `tool_budgets`-Setting durch die
  `budget`-Spalte der Funktionen ersetzt
- LLM-Anbindung auf eigenen OpenAI-kompatiblen Client umgestellt
  (litellm entfernt)

### Dokumentation

- Kanon unter `doc/`: Installation, Grundbegriffe, Konfiguration, Cache,
  Praxisrezepte, Alexa anbinden, Fehler beheben, Referenz — plus
  Architektur (Design-Archiv) und Deployment/CI-CD
- 2026-09-27: `helpdoc/` → `doc/` umbenannt; Root-README neu gegliedert
  (Story, Funktionsweise, Schnellstart, Sicherheit, Struktur,
  Dokumentations-Lernpfad, Status); `CONTRIBUTING.md` und
  `CODE_OF_CONDUCT.md` (zweisprachig) ergänzt

[Unreleased]: https://github.com/dezihh/SmartPilot/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.2
[0.1.1]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.1
[0.1.0]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.0
