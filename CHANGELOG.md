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

## [0.3.2] – 2026-10-04

### Hinzugefügt

- **`packages/<lang>/index.json` wird generiert:** `scripts/build-registry-index.mjs`
  erzeugt das Listing deterministisch aus den Manifesten (Version immer aus dem
  Manifest). Neuer Workflow **Registry CI** lässt die CI rot werden, wenn Index
  und Manifeste divergieren (`--check`).
- **„Update verfügbar"-Badge in der Paketübersicht:** Die Admin-UI vergleicht die
  installierte Version mit der Registry-Version und zeigt bei einer älteren
  Installation „Update verfügbar: vX.Y.Z" (in der verfügbaren und der
  installierten Liste). Gleiche Version → „installiert"; nicht installiert → kein
  Chip.

### Geändert

- `index.json` an die Manifeste angeglichen (u. a. `brave-search` 1.1.1 → 1.1.2,
  Zusammenfassungen aus dem Manifest).

## [0.3.1] – 2026-10-04

### Behoben

- **Paket-Update auf Bestands-DBs wurde als „lokale Änderung" verworfen
  (Blocker):** Der in `package_items` gespeicherte Hash stammte aus der
  v0.2.1-Feldform (ohne `npm_spec`); seit v0.3.0 floss `npm_spec` in die
  Neuberechnung ein, daher galt jede Bestands-Server-Zeile dauerhaft als Konflikt
  und ein normaler `install` (z. B. Brave) überschrieb sie nicht — der 15-s-`npx`-
  Timeout blieb. Migration 3 rebased die Server-Item-Hashes auf die neue
  Feldform, **nur** wenn die Zeile nachweislich unverändert ist; echte lokale
  Änderungen bleiben Konflikt.
- **`npmSpec`-Versionsbump löste kein Reinstall aus:** Der Provisioner verglich
  nur Paketnamen; jetzt vergleicht er Name → Version-Range und installiert bei
  Versionsänderung neu.
- **Prune entfernte nur `package.json`:** Nach Änderungen läuft zusätzlich
  `npm prune`, damit entfernte Pakete auch physisch aus `node_modules/`
  verschwinden.
- **Leerer Provisioner-Lauf:** Ohne Specs und ohne vorhandenes Volume wird jetzt
  sauber übersprungen (kein `npm`-Aufruf, keine `package.json`).

### Geändert

- Smoke-Test berücksichtigt `BASE_PATH` für die Admin-Aufrufe (`/admin` liegt
  optional unter Prefix, `/api` bleibt auf der Wurzel).

## [0.3.0] – 2026-10-04

### Hinzugefügt

- **DB-gestütztes Provisioning der stdio-MCP-Artefakte:** Manifeste deklarieren
  das npm-Paket über `npmSpec` (neues Feld an `mcp_servers.npm_spec`); das Gateway
  installiert es beim Start einmalig in ein persistentes Volume
  (`data/mcp_modules`) und entfernt nicht mehr benötigte Pakete (Prune). Brave
  startet damit ohne Laufzeit-`npx` — kein 15-s-Init-Timeout mehr. Neue Anbieter
  sind reine Registry-Einträge; `MCP_MODULES_DIR` und `MCP_INIT_TIMEOUT_MS` sind
  konfigurierbar.
- **DB-Versionierung mit gestückelten Migrationen:** `PRAGMA user_version` plus
  ein forward-only-Runner (`src/db/migrations/`), der ausstehende Schritte der
  Reihe nach in je eigener Transaktion anwendet. Die bisherigen Inline-Migrationen
  und die einmalige Legacy-Bereinigung sind nummerierte Schritte. Vor der ersten
  Migration einer Bestands-DB wird die Datei inkl. `-wal`/`-shm` nach
  `data/backups/<ts>/` gesichert (WAL-Checkpoint). Die aktuelle `schema_version`
  ist in `/healthz` sichtbar.

## [0.2.1] – 2026-10-02

### Behoben

- Legacy-Bereinigung des alten Referenz-Seeds läuft nur noch **einmal**
  (Marker `_legacy_cleanup_v0_2_0` in `settings`) statt bei jedem Start: eigene,
  gleichnamige Funktionen und Vorgänge (z. B. `boerse*`, ein eigenes
  `hausstatus_gw`) werden nicht mehr bei jedem Containerstart gelöscht oder
  durch generische Seed-Inhalte überschrieben (Datenverlust). Bestands-DBs
  laufen die Bereinigung einmalig beim ersten Start; danach nie wieder.

## [0.2.0] – 2026-10-02

### Geändert (Breaking)

- **Getrennte Token mit sprechenden Namen:** `ADMIN_TOKEN` schützt nur den
  Admin-Bereich, `API_TOKEN` nur die Adapter-API (`/api/query`,
  `/api/lambda-trace`); die Lambda nutzt `api_token`. Die alten Namen
  `AUTH_TOKEN` und `QUERY_TOKEN` entfallen. Bestehende Installationen:
  `gateway/.env` (`ADMIN_TOKEN`/`API_TOKEN`), Repo-Secret `API_TOKEN`,
  Lambda-Env `gateway_token` → `api_token` (Details in
  `doc/INSTALLATION.md`).

### Sicherheit

- `/api/query` erhält Rate-Limit (`QUERY_RATE_MAX`) und Längenlimit
  (`QUERY_MAX_CHARS`); `trust proxy` ist über `TRUST_PROXY` konfigurierbar
  (vorher sah der Login-Limiter hinter nginx nur die Proxy-IP).
- Paket-Install: jeder `stdio`-Server gilt als gefährlich und verlangt
  `dangerousAck` (vorher nur `shell()`-Templates).
- Compose bindet den Port standardmäßig nur lokal (`GATEWAY_BIND=127.0.0.1`),
  bringt einen Healthcheck, das Basis-Image ist gepinnt; Admin-Sessions haben
  eine absolute Obergrenze (`SESSION_MAX_HOURS`) zusätzlich zur Sliding-TTL.
- Skill-ID-Handling: die `applicationId`-Prüfung bleibt autoritativ in der
  Lambda (`sb.skill_id`, Fail-Closed beim Deploy — beide Deploy-Workflows
  verlangen `ALEXA_SKILL_ID`; hosted schreibt sie nun in die `config.json`).
  Der an das Gateway gesendete Header `X-Alexa-Skill-Id` ist **keine**
  Sicherheitsgrenze und wird nur zum Loggen ausgewertet.
- Router: Ganz-Wort-Treffer, bei Gleichstand gewinnt die längste Phrase,
  Verneinungen blockieren Vorgänge mit Seiteneffekt, kombinierte Anfragen
  gehen komplett an den Agenten (auch hybrid/llm).
- Abhängigkeiten: `mcp-searxng` 2.5.0 + `ip-address`-Override → `npm audit`
  ohne Funde; Dependabot für npm/pip/github-actions.

### Hinzugefügt

- Testbuttons für Vorgänge und installierte Pakete (führen direkt im Monitor
  aus; im Funktions-Editor rendert „Test" das Template).
- Registry-Kanäle (stabil `main` / Vorschlag `packages/community`) in
  `packages/README.md` dokumentiert.
- Einrichtungshinweis für `stdio`-Server in der Tool-Registry.

### Behoben

- Alexa: getrennte Fehlermeldungen („Ich erreiche meinen Server gerade nicht."
  / „Das dauert zu lange.") statt eines Sammeltexts; die Session bleibt nach
  einem Fehler offen.
- Einheitliche Du-Anrede (Willkommen/Hilfe zuvor „Sie").
- HelpIntent fragt die Gateway-`hilfe` ab (kennt die installierten Fähigkeiten)
  statt eines festen Texts.
- Lambda: Query- und Hilfe-Pfad nutzen denselben Worker mit Watchdog/Warteton;
  die Hilfe kann ein langsamer LLM-Aufruf das Alexa-Zeitfenster nicht mehr
  reißen (Diff-Review F-D18).
- Lambda: der dynamische Hilfe-Text wird XML-escaped gesprochen — `&`/`<` aus
  Gateway/Entity-Namen brechen die SSML-Antwort nicht mehr (F-D17).
- Gateway: `SESSION_MAX_HOURS`, `QUERY_RATE_MAX` und `QUERY_MAX_CHARS` werden
  beim Start validiert; ein ungültiger Wert fällt auf den Default zurück statt
  das Limit still zu deaktivieren (NaN) oder zu sperren (F-D19).
- Agent nutzt die zentrale `agentFnAllowlist()` statt einer inline duplizierten
  Auswertung (F-D15).

## [0.1.8] – 2026-09-30

### Hinzugefügt

- Template-Baustein `mcp.call(tool, args, { fallback })`: optionales Ersatz-Tool
  (Kaskade), das nur bei leerem oder fehlgeschlagenem Primär-Aufruf mit
  denselben Argumenten greift — z. B. erst SearXNG, sonst Brave
  (siehe `doc/RECIPES.md`, `doc/REFERENCE.md`)
- Paket `brave-search` (1.1.1): `recherche` nutzt die Kaskade — primär
  `searxng_web_search`, nur bei leerem Ergebnis `brave_web_search`

### Behoben

- Paket-Aktualisierung schützt lokale Anpassungen: lokal geänderte Zeilen
  (Server/Funktion/Aktion/Index) bleiben standardmäßig erhalten; nur ein
  ausdrückliches „Paket-Version übernehmen" überschreibt sie (Backend-Default
  und Dialog-Default angepasst)
- Agent: Tool-Ergebnisse sind als alleinige Faktenquelle verankert (Prompt-Regel
  und schärfere Recherche-Auswertung); Bestands-DBs werden migriert — verhindert
  Antworten aus Trainingswissen trotz vorliegender Treffer
- Agent antwortet veränderliche Fakten (Personen und Ämter, Orte, Preise,
  Produkte, Rekorde, Ereignisse, Nachrichten) nicht mehr aus Trainingswissen:
  die Agent-Regel wurde geschärft (bei Veränderlichem zuerst per Such-/Recherche-
  Tool prüfen; nur zeitlose Erklärungen/Definitionen aus eigenem Wissen);
  Bestands-DBs werden per Migration angepasst
- Agent wiederholt nach einer identischen Anfrage keine Rückfrage mehr: gleich-
  lautende frühere Turns werden aus dem Gedächtnis-Kontext gefiltert, damit das
  Modell seine eigene vorige Rückfrage nicht nachahmt
- Paket `music-assistant` (1.1.3): Parameter `ma_url` (vollständige MCP-URL)
  ersetzt `ma_host`/`ma_port` — update-sicher und für https/Reverse-Proxy
  geeignet; generische Player-Wahl — ohne genaue Geräteangabe wird der gerade
  spielende Player verwendet (bei mehreren spielenden bevorzugt mit gesetzter
  Lautstärke; Rückfrage nur bei echter Mehrdeutigkeit); optionaler Parameter
  `ma_default_player` (Repo-Default leer) — hat als fester Standard-Player
  Vorrang vor der generischen Wahl (auch wenn ein anderer Player gerade spielt);
  `fn_ma_players` blendet HA-Kopien
  (`media_player.*`) aus; explizite Befehlszuordnung (nächster Titel →
  `playback_next_track`, weiter/fortsetzen → `playback_resume` usw.);
  Steuercalls nutzen die `queue_id` (via `queue_get_active_queue`),
  Lautstärke/Ein-Aus die `player_id` (lauter/leiser relativ via
  `volume_volume_up`/`-down`)


## [0.1.7] – 2026-09-30

### Hinzugefügt

- Paket-Format: `actions` — Pakete legen jetzt auch **Vorgänge** an
  (Trigger → Antwortweg), inkl. Vorschau, Konflikt-/Deinstall-Schutz
- Beispiel-Pakete als generische Rezept-Vorlagen für alle drei Vorgangs-Modi:
  `beispiel-home-assistant` (`hausstatus` deterministisch), `beispiel-http`
  (`meine_ip` deterministisch, `luftqualitaet` hybrid) und `beispiel-llm`
  (`erklaeren` als reiner LLM-Vorgang)

## [0.1.6] – 2026-09-29

### Dokumentation

- Paket `music-assistant`: Setup-Doku zum Connect-Wizard präzisiert — im Wizard
  **Network** statt Localhost/Loopback wählen, den AI-Client beliebig (z. B.
  Claude), dann **nur den Token** aus dem erzeugten Snippet als `ma_token`
  übernehmen
- Pakete `searxng` (1.0.3)/`brave-search`: Installationsdoku präzisiert — der
  Install-Dialog fragt nur die deklarierten Parameter ab, die stdio-Felder
  (`command`/`args`/`env`) setzt das Paket automatisch (änderbar im
  MCP-Server-Editor, Transport `stdio`); SearXNG-Parameter korrigiert
  (**Basis-URL ohne `/search`**)

## [0.1.5] – 2026-09-29

### Behoben

- Paket `home-assistant` (1.0.3): Das Index-Template enthielt eine literale
  Escape-Sequenz (Backslash-n), die Jinja nicht als Zeilenumbruch rendert.
  Dadurch landeten statt aller HA-States nur wenige Einträge im Entity-Index und
  die Entity-Suche lief ins Leere. Das Template nutzt jetzt einen echten
  Zeilenumbruch; `entityIndex.splitLines` normalisiert solche Folgen zusätzlich
  defensiv.

### Dokumentation

- `doc/INSTALLATION.md`: Reverse-Proxy-/`BASE_PATH`-Anleitung überarbeitet — ein
  nginx-Referenzaufbau (TLS, nur `/api/query` öffentlich) mit Ziel-URL und
  Trailing-Slash-Falle; zentrale Auth, `BASE_PATH` und Ganz-Instanz-Betrieb nur
  beschrieben
- `README.md`: Hinweis, dass die Admin-UI mit `BASE_PATH` unter
  `<BASE_PATH>/admin/` liegt

## [0.1.4] – 2026-09-28

### Hinzugefügt

- `BASE_PATH`: Die Admin-UI kann unter einem Pfad-Prefix laufen (z. B.
  `BASE_PATH=/smartpilot` → UI unter `/smartpilot/admin/`, UI-API unter
  `/smartpilot/admin/api/*`), ohne Pfad-Rewrites im vorgelagerten Proxy. Die
  öffentliche Adapter-API bleibt unter `/api/…` (Ausbaustufe zu Issue #10)

### Behoben

- Die Hilfe nennt jetzt zuverlässig die nutzbaren Fähigkeiten: Der Hilfe-Prompt
  bekommt einen vollständigen Katalog der für den Agenten freigegebenen
  Funktionen (mit Beschreibung und Parametern) und Systeme — auch von Tools
  ohne `inventory_prompt` — statt eines Inventars, das solche Tools ausließ.
  Das Modell formuliert daraus je Tool eine verständliche Zeile mit Nutzung.
  Ohne Fähigkeiten oder bei LLM-Fehler greift ein deterministischer Fallback.
- Der Admin-Redirect `/admin` → `/admin/` erhält jetzt den Query-String und
  läuft erst nach der Authentifizierung.

## [0.1.3] – 2026-09-28

Findings aus dem Diff-Review zu v0.1.2.

### Geändert

- `lambda-zip.yml`: die Dispatch-Version wird über `env` übergeben (keine
  Shell-Interpolation, F-D3); versionierte Releases tragen den „Latest"-Badge,
  das rollende `latest` ist ein reiner Alias (F-D7)
- `.gitignore`: `/AGENTS.md` nur im Repo-Root verankert statt in jedem
  Verzeichnis (F-D5)

### Behoben

- Hilfe-Inventory: nur ein Vorgang mit Nachschlagewerk-Marker und ohne eigene
  Tools (Hilfe) zeigt alle Systeme; andere Vorgänge bleiben auf ihre Tool-Liste
  begrenzt (F-D1)
- Hilfe-Prompt-Migration ersetzt nur die alte Seed-Formulierung und lässt
  Nutzer-Anpassungen unangetastet (F-D2)
- Bearer-Parsing zentral in `auth.ts` (`bearerToken`) statt dupliziert (F-D4)
- Ohne `DB_PATH` wird eine vorhandene `meinhelfer.db` weiterverwendet, statt eine
  leere `smartpilot.db` anzulegen (F-D6)

## [0.1.2] – 2026-09-28

### Hinzugefügt

- Reverse-Proxy-Betrieb: die statische Admin-UI (`/admin/`) akzeptiert jetzt
  auch das Bearer-Token, nicht nur den Session-Cookie. Ein vorgelagerter Proxy
  (z. B. tinyauth/Authelia) kann `Authorization: Bearer <ADMIN_TOKEN>` setzen und
  den App-Login überspringen; das Token bleibt proxy-seitig und gelangt nie in
  den Browser (Issue #10)

### Behoben

- Hilfe nennt nur noch tatsächlich eingerichtete Fähigkeiten: bei leerem
  Nachschlagewerk wird kein roher Marker mehr an das LLM gegeben (kein Erfinden
  von Fähigkeiten); der Hilfe-Vorgang beschreibt jetzt alle eingerichteten
  Funktionen und Systeme und führt sonst nur die Grundfunktionen auf
- Standard-Datenbankpfad von „meinhelfer.db" auf „smartpilot.db" umgestellt
  (`config.ts`, `.env.example`, Doku)

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
  `ADMIN_TOKEN`, constant-time Vergleich); Admin-Oberfläche mit
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

[Unreleased]: https://github.com/dezihh/SmartPilot/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.2
[0.3.1]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.1
[0.3.0]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.0
[0.2.1]: https://github.com/dezihh/SmartPilot/releases/tag/v0.2.1
[0.2.0]: https://github.com/dezihh/SmartPilot/releases/tag/v0.2.0
[0.1.8]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.8
[0.1.7]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.7
[0.1.6]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.6
[0.1.5]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.5
[0.1.4]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.4
[0.1.3]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.3
[0.1.2]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.2
[0.1.1]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.1
[0.1.0]: https://github.com/dezihh/SmartPilot/releases/tag/v0.1.0
