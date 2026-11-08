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

### Geändert

- **Gateway-Version 0.6.0, Sicherheitsfelder setzen sie voraus (F-003):**
  `gateway/package.json` steht auf 0.6.0. Das Manifest von `aufgabenliste`
  verlangt jetzt `minGatewayVersion: 0.6.0`, weil `side_effect`, `confirm` und
  `tool_params` erst dort wirken; 0.5.1 ignoriert die Felder und würde die
  Bestätigung still auslassen. Ein Vertragstest verlangt für jedes Manifest
  mit diesen Feldern mindestens 0.6.0.
- **Gate-Treppe und Testtiefe nach Risiko:** `npm run gates:fast`
  (Typecheck, Test-Typecheck, Lint, Tests) läuft vor dem Commit,
  `npm run gates:full` (zusätzlich Coverage, Build, Dead-Code, Zyklen,
  Duplikate, Audit) vor Merge und Release. Maßgeblich für neue Änderungen ist
  die Diff-Coverage (≥ 90 %, kritische Pfade 100 %); die globale Quote ist nur
  noch Regressionsbremse. Lines-Schwelle 95 %, Functions 93 % (vorher 97/94) —
  Begründung und Wiederaufnahme-Trigger in `doc/TESTING.md`.
- **Diff-Coverage messbar:** `src/core/diffCoverage.ts` und
  `npm run coverage:diff` werten LCOV gegen den Branch-Diff aus und weisen
  ungetestete geänderte Zeilen aus; kritische Module verlangen 100 %.
- **Coverage misst nur noch den Produktivcode (F-001):** `npm run coverage`
  verwendet `--test-coverage-include='src/**'`. Vorher zählten die Testdateien
  mit und hielten das Gate künstlich grün (Quell-Coverage lag bei
  96,16/81,73/93,21). Mit zusätzlichen Tests liegt sie jetzt bei
  97,00/84,84/94,63 — Schwellen unverändert 97/83/94.
- **Tool-Angebot messbar und begrenzbar (Issue #9):** Das Debug-Log zeigt die
  Größe des Tool-Angebots (`Tool-Specs`: Anzahl, Zeichen, Näherungstokens
  `chars/4`). Das neue Setting `agent_tool_limit` begrenzt die MCP-Tool-Specs
  pro Anfrage deterministisch; Basis-Lesewerkzeuge und `fn_*`-Funktionen
  bleiben immer erhalten (0/leer = unbegrenzt).

### Behoben

- **Aufrufname nur an den Rändern entfernen (F-010):** Die Lambda beschneidet
  den Aufrufnamen nur noch am Anfang oder Ende des `query`-Slots; mitten im
  Satz genannte Namen („schalte smart pilot lampe an") bleiben Teil der Frage.
  Führende Füllpartikel vor dem Namen werden weiterhin entfernt.
- **Vorgangs-Tools bleiben vom Tool-Deckel ausgenommen (F-013):**
  `agent_tool_limit` kürzt nur noch die frei gewählten MCP-Tools des Agenten;
  die explizite Tool-Liste eines Vorgangs wird vollständig angeboten und
  zählt nicht gegen den Deckel.
- **`aufgabenliste` ist als gefährlich markiert (F-009):** Das Manifest
  deklariert die destruktiven Todo-Werkzeuge (`ha_set_todo_item`,
  `ha_remove_todo_item`) als `dangerousItems`; die Installation verlangt jetzt
  eine ausdrückliche Bestätigung. Die neue Manifest-Option `dangerousItems`
  deckt Risiken ab, die nicht aus `shell()`/stdio ableitbar sind
  (Paketversion 1.0.1).
- **Ext-Check-Workflow mit Leserechten (F-008):** `ext-check.yml` deklariert
  jetzt `permissions: contents: read`. Der Job checkt nicht aus und braucht
  keine Schreibrechte; wie die übrigen Workflows ist der Token damit minimal
  berechtigt.
- **`agent_tool_limit` in der Admin-UI (F-005):** Das Setting ist jetzt als
  Zahlenfeld „Agent max. MCP-Tool-Specs“ in den Grundeinstellungen vorhanden;
  leer oder 0 = unbegrenzt. Die Doku nannte das Feld bereits, das Formular
  fehlte.
- **AWS-Deploy reicht den Aufrufnamen durch (F-004):** `skill_config.py
  --print-env` gibt `SKILL_NAME`, `ASSISTANT_NAME` und `INVOCATION_NAME` in
  Großbuchstaben aus. GitHub behandelt Env-Namen case-sensitiv, deshalb kamen
  `SKILL_NAME` und `ASSISTANT_NAME` im Deploy-Workflow bisher leer an;
  `invocation_name` erreicht die Lambda jetzt ebenfalls. Doku-Beispiele für den
  hosted Pfad und die Weg-B-Tabelle sind ergänzt.
- **Paket-`allowTools` verengt die globale Tool-Liste nicht mehr (F-002):** Die
  Allowlist wird nur noch in eine **explizite** `agent_tools`-Liste gemerged;
  „nicht gesetzt“ (= alle) und „keine“ bleiben unangetastet.
- **`log_verbatim=0` gilt für alle Routen (F-003):** Vorgänge speichern bei
  deaktiviertem Verbatim-Logging weder Frage/Antwort noch Trace-Details.

### Hinzugefügt

- **Action-Security: Wirkung und Bestätigung pro Vorgang (#4):** Vorgänge
  deklarieren `side_effect` (`read`/`write`, Default `write`) und optional
  `confirm`. Bei schreibenden Vorgängen mit Bestätigung führt das Gateway
  nicht sofort aus, sondern fragt „Soll ich … ausführen? Sag ja oder nein."
  und startet erst nach einem „ja" (gleiche Session, 60 s TTL; Trace
  `action.confirm_pending`/`confirmed`/`cancelled`). Manifest-Actions
  unterstützen dieselben Felder; `aufgabenliste` nutzt sie als erster
  Verbraucher. Zusätzlich lässt sich pro Tool eine Parameter-Allowlist
  (`tool_params`) hinterlegen: Das Schema im Prompt wird gekürzt, zusätzliche
  Argumente weist die Engine zur Laufzeit ab (`tool.param_blocked`).
- **Paket `aufgabenliste` (Home Assistant):** Liest und schreibt
  HA-Todo-Listen über die bestehende `ha-mcp`-Anbindung
  (`ha_get_todo`, `ha_set_todo_item`, `ha_remove_todo_item`). Der Vorgang
  `aufgabenliste` deckt Lesen, Ergänzen, Abhaken, Umbenennen und Entfernen ab;
  die Werkzeuge werden zusätzlich in die globale Allowlist aufgenommen. Das
  Paket legt keinen eigenen Server an.

## [0.5.1] – 2026-11-07

### Geändert

- **Query-Slot wird vor dem Routing bereinigt (Issue #7):** Die Lambda
  entfernt Aufrufnamen (auch zusammengeschrieben, `SmartPilot` ≡
  `smart pilot`) und führende Füllpartikel (`bitte`, `mal`, `sag`, …) aus dem
  `query`-Slot, bevor die Frage ans Gateway geht. Reine Carrier-Phrasen
  bleiben unverändert, damit nie eine leere Frage entsteht. Der Aufrufname
  kommt aus `invocation_name` (Default `smart pilot`, gesetzt aus
  `alexa/skill.config.json`).

### Sicherheit

- **Replay-Schutz für die Adapter-API (Issue #5):** Ist `API_SIGNING_SECRET`
  gesetzt, muss jede Anfrage an `/api/query` und `/api/lambda-trace` mit
  HMAC-SHA256 über Zeitstempel, Nonce und Body-Hash signiert sein
  (`X-Timestamp`, `X-Nonce`, `X-Signature`). Das Gateway akzeptiert eine
  Signatur nur innerhalb von `API_SIGNATURE_TTL_SECONDS` (Default 300 s,
  maximal 3600 s) und nur einmal pro Nonce; ein voller Nonce-Cache lehnt
  fail-closed ab statt Einträge zu verdrängen. Die Lambda signiert automatisch,
  sobald `api_signing_secret` gesetzt ist; die Deploy-Workflows geben das
  Secret an die Funktion weiter, `ext-check` signiert seinen Probeaufruf.
  Ohne Secret bleibt es beim Bearer-Token.

- **`/metrics` hängt am Admin-Limiter (F-010):** eigener Bucket
  (`adminLimiter('metrics')`) getrennt von der Admin-API, Limit über
  `ADMIN_RATE_MAX`.
- **Rate-Limit-Map hart begrenzt (F-015):** Bei Überlauf werden zuerst
  abgelaufene, dann die ältesten Keys entfernt, bis `MAX_KEYS` (1000)
  erreicht ist — fail-open dokumentiert.
- **Trace-Leak bei `log_verbatim=0` behoben (F-001):** Der Trace enthält ohne
  Verbatim-Logging nur noch `ts`/`step` sowie das `llm.usage`-Event; Frage,
  Tool-Argumente, URLs und Shell-Kommandos werden nicht mehr persistiert.
- **Backup-Token-Export ist jetzt Opt-in (F-002):** Die Checkbox
  „Server-Auth-Tokens einschließen" ist nicht mehr vorbelegt.
- **SSRF-Schutz erkennt IPv4-gemappte IPv6-Ziele (F-003):** `isSensitiveHost`
  nutzt die Kanonisierung aus `isPrivateHost`, damit
  `::ffff:169.254.169.254` und `[::ffff:127.0.0.1]` als sensibel gelten.
- **Admin-API maskiert Server-Secrets (F-014):** POST/PUT auf
  `/admin/api/mcp-servers` geben `auth_token`, `env` und `headers` nicht mehr
  im Klartext zurück.

### Betrieb

- **Graceful Shutdown ist getestet (F-012):** Der Test startet den echten
  Serverprozess, sendet `SIGTERM` und prüft Exit-Code 0 samt Shutdown-Log.
- **Audit-Gate hat ein Zeitlimit (F-016):** `npm audit` bricht nach 120 s ab
  und meldet „nicht bewertbar" (Exit 2, GRAU) statt den CI-Job zu blockieren.

### Tests

- Vertragstests für F-001, F-002, F-003 und F-014 sind nicht mehr `todo`,
  sondern scharfe Regressionsproben.
- **Frontend-Helfer getestet (F-007):** `esc`, `cmpVersion` und `diffValue`
  haben Verhaltenstests; `web/**` ist aus der Coverage-Messung ausgenommen,
  weil Browser-Code dort nicht sinnvoll messbar ist (F-009).

### Doku

- **`SECURITY.md` und PR-Template (F-008):** Meldeweg über GitHub
  Security Advisories, Umfang und Ablauf dokumentiert.
- **Token-Namen korrigiert (F-004):** `doc/DEPLOYMENT.md` und `doc/ALEXA.md`
  nennen `API_TOKEN` für `/api/query` und `ADMIN_TOKEN` für die Admin-UI.
- **Workflow-Rechte eingeschränkt (F-017):** `permissions: contents: read` in
  `deploy-alexa.yml`, `sync-manifest.yml`, `sync-model.yml` und
  `list-skills.yml`.

### Code-Hygiene

- **Tote Admin-Routen-Liste entfernt (F-005):** `PUBLIC_ADMIN_FILES` matchte
  nie; die drei expliziten Login-Asset-Routen bleiben die einzige Quelle.
- **Test-Hooks im Produktionsbetrieb inaktiv (F-006):** Die `*ForTests`-Exporte
  sind hinter `TEST_HOOKS_ENABLED` (`NODE_ENV !== 'production'`) gegated; das
  Image setzt `NODE_ENV=production`. Der Schalter ist bewusst default-offen
  (nur `production` sperrt) — der Kommentar im Modul sagt das jetzt korrekt
  (G-02).

### Tests und Messbasis

- **Coverage-Schwellen auf das gemessene Niveau gehoben (G-01):** 97/84/94
  statt 95/80/90. Der Ausschluss `web/**` ist in
  [Tests und Coverage](doc/TESTING.md) begründet und mit Ist-Werten
  festgehalten; ohne Ausschluss läge die Quote bei 92,91/81,24/90,39.
- **Branch-Schwelle auf 83 % gesenkt (bewusst):** Die gemessene Spanne liegt
  bei 83,94–84,13, deshalb flakte die 84er-Schwelle. Dokumentierte Ausnahme
  von „Schwellen nur verbessern“; Ziel ist die Rückkehr auf ≥ 85, sobald
  zusätzliche Tests den Puffer herstellen (siehe `doc/TESTING.md`).
- **CI-Gate reproduzierbar gemacht:** CI pinnt Node auf `26.13.0` (wie das
  Image). Der stdio-Fallback-Timer ist injizierbar und wird deterministisch
  getestet; der SIGTERM-Test wiederholt sich bei Port-Kollision.
- **Produktionszweig der Test-Hooks getestet (G-03):** `contract-test-hooks`
  startet echte Kindprozesse mit und ohne `NODE_ENV=production`.
- **Bekannte Grenzen dokumentiert (G-06–G-08):** Audit-Gate-Timeout-Zweig,
  `ADMIN_RATE_MAX`-Prozessisolation und Port-Rennen im SIGTERM-Test stehen in
  `doc/TESTING.md`.

### Doku

- **`ADMIN_RATE_MAX` beschreibt jetzt beide Buckets (G-05):**
  `doc/REFERENCE.md` und `gateway/.env.example` nennen Admin-API **und**
  `/metrics`.
- **`.d.ts`-Kommentare korrigiert (G-04):** Die Deklarationen liegen mit
  `web/` im Image; Browser laden sie nur nie.

## [0.5.0] – 2026-11-06

### Hinzugefügt

- **MQTT-Paket (`packages/de/mqtt`):** Der interne MQTT-MCP-Server
  (`gateway/src/mcp/mqtt-server.ts`, läuft als stdio-Prozess im Container)
  hält einen Last-Value-Cache (1000 Topics, 4 KB pro Wert, max. 50 Zeilen pro
  Snapshot) und bietet `mqtt_get`, `mqtt_snapshot` und `mqtt_set`. Schreiben
  ist grundsätzlich gesperrt und nur auf Topics aus `MQTT_ALLOW_WRITE`
  möglich (exakter Name oder Präfix mit `#`/`*`); ohne Freigabeliste bleibt
  `mqtt_set` aus. Nach dem Verbinden gelten 1,5 s für retained-Nachrichten.
  Das Paket bringt Parametrierung (Broker-URL, Zugangsdaten, Präfix,
  Freigabeliste) und Doku mit.
- **Paket-Kategorien:** Pakete tragen eine Kategorie `driver` (MCP-Treiber),
  `function` (Funktionen/Vorgänge) oder `mixed`. Fehlt der Wert im Manifest,
  wird er aus den Artefakten abgeleitet; `packages/<lang>/index.json` führt
  ihn mit.
- **Konfigurations-API für installierte Pakete:**
  `GET`/`PATCH /admin/api/packages/:id/config` lesen und ändern Parameter,
  ohne Version, Quelle oder Installationszeitpunkt anzutasten. Secrets werden
  maskiert, leere Felder behalten den bestehenden Wert. Änderungen laufen
  über denselben Installationspfad (`configOnly`) inklusive Update-Schutz für
  lokal geänderte Zeilen.
- **Parameter-Metadaten:** `params[].help` und `params[].type`
  (`text`/`password`/`number`) bereiten die generische Formulardarstellung vor.
- **Persistiertes Manifest:** Migration 6 speichert das beim Install
  aufgelöste Manifest in `packages.manifest`; die Konfigurationsansicht
  arbeitet damit auch ohne erreichbare Registry.
- **HTTP-Header in Paketmanifesten:** `servers[].headers` war dokumentiert,
  wurde aber nicht übernommen. Jetzt landen Header (Werte per `${key}`
  ersetzbar) in `mcp_servers.headers`; Migration 7 rebased die Item-Hashes
  ohne Scheinkonflikte. Header-Werte erscheinen im Diff nur als Name.
- **Paketmanager-Oberfläche:** Filter nach Kategorie, Klartextnamen und
  Kategorie-Chips bei installierten Paketen, Konfigurationsdialog aus den
  Manifest-Parametern (mit `help`/`type`, Secrets bleiben maskiert).
  „Testen“ prüft jetzt lesend die MCP-Verbindung statt Vorgänge auszuführen.
  Der Offline-Import steht als Entwicklerwerkzeug eingeklappt am Rand.

### Behoben

- **Admin-UI wieder bedienbar:** `web/js/logs.js` exportierte `loadLogs`
  nicht und `app.js` importierte `token` nicht — der Browser brach die
  Modulkette mit einem SyntaxError ab, die Seite lud zwar (alle Dateien 200),
  aber die Seitenleiste reagierte nicht. Beides korrigiert; ein statischer
  Modul-Test (`test/web-modules.test.ts`) prüft jetzt Importe gegen Exporte.
- **Login-Seite wieder bedienbar:** Inline-Styles und Inline-Skripte sind per
  CSP (`style-src 'self'`, `script-src 'self'`) blockiert — die Login-Seite
  war dadurch ungestylt und der Anmelde-Knopf ohne Funktion. CSS und JS liegen
  jetzt als `web/css/login.css` und `web/js/login.js` vor; nur diese beiden
  Dateien und `login.html` sind ohne Session erreichbar, alle übrigen
  Admin-Assets bleiben gesperrt.
- **Backup/Restore behält das persistierte Manifest.**
- **Backup maskiert Header ohne Opt-in:** `GET /admin/api/backup` entfernt
  `headers` wie `auth_token`/`env`; vollständig nur mit `?tokens=1`.
- **Header-Secrets überleben die Konfiguration:** `existingParams` liest
  `servers[].headers` zurück, sodass `PATCH …/config` Header-Werte nicht mehr
  leert.
- **Health-Check ohne Prozessleck:** Der stdio-Client wird auch im Fehlerfall
  beendet (`finally`).
- **Sauberes Herunterfahren:** `SIGTERM`/`SIGINT` schließen den HTTP-Server,
  beenden alle stdio-Kinder und schließen die SQLite-Verbindung
  (WAL-Checkpoint).
- **Konfigurationsänderungen bestätigen gefährliche Feldinhalte:** Fließt ein
  geänderter Parameter in `shell()`, `command`, `args` oder `env`, verlangt
  das Speichern erneut eine Bestätigung — nicht mehr erst bei geänderter
  Anzahl der Gefahrenpunkte.
- **Zeitzone im Template-Kontext:** `now.hour`/`now.date`/`now.time` nutzen
  `TZ` (Default `Europe/Berlin`) statt der Container-Zeitzone (UTC).
- **MCP-Negativ-Cache:** Ein fehlgeschlagener Init wird für
  `MCP_FAILURE_TTL_MS` (Default 30 s) nicht erneut versucht.
- **Datenschutz in den Logs:** `log_verbatim=0` speichert für Agent-Turns
  keine Frage/Antwort-Texte mehr; `log_retention_days` macht die Aufbewahrung
  konfigurierbar (Standard 30, 1–3650 Tage).
- **Agent-Gedächtnis wählbar:** `memory_scope=session` begrenzt den DB-Recall
  auf die eigene Sitzung (Mehrpersonenhaushalte); Standard bleibt
  sitzungsübergreifend.
- **Zentraler JSON-Fehlerhandler:** Kaputtes JSON oder ein zu großer Body
  liefern jetzt 400/413 als JSON statt der Express-HTML-Seite.
- **ID-Validierung:** Ungültige numerische IDs (`abc`, `0`, `-1`) liefern 400,
  statt still „nicht gefunden“ oder `ok: true` zu melden.
- **`/healthz` prüft die Datenbank:** Lese- und Schreibfähigkeit (BEGIN
  IMMEDIATE/ROLLBACK); sonst 503 statt `ok: true`.
- **stdio-Robustheit:** 8-MB-Obergrenze für unvollständige Zeilen (Speicher-DoS)
  und SIGKILL-Fallback, wenn ein Prozess SIGTERM ignoriert.
- **Einheitliche MCP-Timeouts:** HTTP und stdio nutzen dieselben Grenzen —
  30 s für `init`/`tools/list`, 60 s für `tools/call`.
- **Restore prüft Format und Teil-Sicherungen:** Unbekannte `formatVersion`
  wird abgelehnt; fehlen `packages`/`package_items`, bleibt die bestehende
  Provenienz stehen. Der Body darf bis 25 MB groß sein (vorher 1 MB).
- **Secrets bewusst löschbar:** `PUT /admin/api/mcp-servers/:id` akzeptiert
  `clear_secrets` (`auth_token`, `env`, `headers`); ohne den Hinweis bleibt
  der bestehende Wert wie bisher erhalten.
- **Trace-Redaktion:** Secrets in Tool-Argumenten (`token`, `api_key`,
  `authorization`, …) werden vor dem Speichern maskiert.

### Sicherheit

- **Registry-Integrität:** `packages/<lang>/index.json` führt je Paket die
  Version und den SHA-256 der Manifest-Datei. Das Gateway lädt das Manifest
  als Rohtext, prüft Hash und Version gegen den Index und lehnt Abweichungen
  ab. Alte Registries ohne Hash funktionieren weiter, melden aber eine
  Warnung. Die Registry-CI erkennt jetzt auch ein Manifest, das ohne
  Index-Aktualisierung geändert wurde.
- **undici 8.12.4 statt 6.29.0:** behebt die letzten drei High-Advisories
  (TLS-Zertifikatsprüfung, TLS-Renegotiation, Content-Encoding-DoS);
  `npm audit --omit=dev` meldet keine offenen Befunde mehr. Der gepinnte
  Dispatcher setzt `allowH2: false`, damit undici 8 nicht stillschweigend
  HTTP/2 verhandelt.
- **Lambda-Abhängigkeiten aktualisiert:** `requests` 2.34.2 und `urllib3`
  2.8.0 (vorher 2.31.0 / 1.26.20, mehrere Advisories). Der Testlauf der
  Lambda bleibt mit den echten Bibliotheken grün.
- **Provisioner ohne Gateway-Secrets:** `npm install` für stdio-Pakete erhält
  nur ein minimales Environment (kein `ADMIN_TOKEN`/`API_TOKEN`/`LLM_API_KEY`)
  und läuft mit `--ignore-scripts`. Opt-out für Pakete, die bauen müssen:
  `MCP_NPM_ALLOW_SCRIPTS=1`.
- **Starke Tokens erzwungen:** Beispielwerte (`change-me…`) und in Produktion
  Tokens unter 24 Zeichen verhindern den Start.
- **Rate-Limit vor der Auth:** `/api/query` zählt pro Client-IP vor der
  Token-Prüfung; die Admin-API hat ein eigenes Limit (`ADMIN_RATE_MAX`,
  Standard 600/min), damit auch fehlgeschlagene Tokens begrenzt sind.
- **Lambda fail-closed:** Fehlendes `api_token` oder `alexa_skill_id` bricht
  den Aufruf ab, statt `Bearer ` zu senden bzw. ohne Skill-ID-Prüfung zu
  arbeiten.
- **DNS fail-closed:** Dynamische `http()`-URLs werden blockiert, wenn der
  Host nicht auflösbar ist; Multicast (`224/4`), reservierte Bereiche
  (`240/4`) und Broadcast gelten zusätzlich als privat.
- **SSML nur mit explizitem Flag:** Die Lambda escaped Text auch dann, wenn
  er mit `<speak` beginnt — SSML wird nicht mehr aus dem Textpräfix
  abgeleitet.

- **Sicherheits-Header:** CSP, `X-Content-Type-Options`, `X-Frame-Options`
  und `Referrer-Policy` werden jetzt serverseitig gesetzt. Die Admin-UI
  verwendet keine Inline-Skripte oder externen Quellen.
- **Getrennte Tokens erzwungen:** Der Start bricht ab, wenn `ADMIN_TOKEN` und
  `API_TOKEN` identisch sind (vorher nur dokumentiert).
- **Interne `http()`-Ziele sichtbar:** Nutzt ein Paket eine literale
  `http()`-URL in ein privates Netz, erscheint das als Hinweis in der
  Installationsvorschau. Literale URLs bleiben (anders als dynamische) von
  der SSRF-Prüfung ausgenommen, weil LAN-Ziele gewollt sind.
- **Loopback/Metadaten sind bestätigungspflichtig:** Literale `http()`-URLs
  auf `127.0.0.0/8`, `169.254.0.0/16` (Cloud-Metadata), `0.0.0.0/8` oder
  `::1` zählen als gefährlich und verlangen `dangerousAck`. RFC1918-Ziele
  bleiben ein Hinweis, damit LAN-Pakete installierbar bleiben.

### Entwicklung

- **Gateway-Version auf 0.5.0** gehoben (`package.json` und Lockfile-Root);
  das MQTT-Paket verlangt mindestens diese Version.
- **Abhängigkeiten aktualisiert:** `better-sqlite3` 13.0.3 (N-API, fertige
  Binaries im Paket), `dotenv` 18.0.9, `@types/node` 26.6.6, `tsx` 4.23.15.
  Die Images nutzen `npm ci --ignore-scripts`, damit kein `node-gyp`-Build im
  slim-Image nötig ist.
 High/Critical in den
  Produktionsabhängigkeiten blockieren die Pipeline. Ausnahmen stehen mit
  Begründung, Doku-Verweis, Trigger und Ablaufdatum in
  `gateway/audit-allowlist.json`; abgelaufene, verwaiste oder undokumentierte
  Einträge machen das Gate rot, ein nicht bewertbarer Bericht endet mit
  Exit 2. Damit ist der frühere `continue-on-error`-Audit-Schritt ersetzt.
- **Vertragstest für ausgelieferte Pakete:** Prüft Manifeste, Platzhalter,
  Versionen und die Sicherheitswirkung der Registry-Pakete; in CI ist ein
  fehlendes Paketverzeichnis ein Fehler statt eines stillen Skips.
- **Paket-Vertrag in der Registry-CI:** Änderungen unter `packages/**` lösen
  jetzt den Vertragstest aus (eigener Job, Node 26). Vorher lief dort nur die
  Index-Prüfung, ein defektes Manifest erreichte `main` ungeprüft und war nach
  dem Registry-Cache (60 s) für alle Installationen live.
- **Actions auf Commit-SHAs gepinnt:** Alle Workflows referenzieren die
  GitHub-Actions per SHA (Kommentar nennt die Version) statt per beweglichem
  Tag.
- **Code-Slop aufgeräumt:** Audit-/Issue-Referenzen aus `src/` entfernt
  (Begründungen bleiben), `errMsg`/`parseId` als gemeinsame Helfer,
  Manifest-Projektion einmal statt zweimal, `McpServerRow` statt drei
  Inline-Typen, Template-Re-Exports entfernt.
- **CI-Gates erweitert:** Die Lambda-CI misst Coverage für
  `lambda_function.py` (Schwelle 80 %); die Gateway-CI baut zusätzlich das
  Runtime-Image (`docker build --target runtime`).
- **Strukturierte Logzeilen mit Anfrage-Kennung:** eine Zeile pro Ereignis
  (`Zeit LEVEL req=… Text k=v`); `LOG_LEVEL` steuert die Ausführlichkeit
  (ungültige Werte verhindern den Start). Jede Anfrage bekommt eine
  `X-Request-ID` (übernommen, wenn im erwarteten Zeichensatz, sonst neue UUID),
  die im Antwortheader und in allen Logzeilen dieses Requests steht.
- **Metriken:** `GET /metrics` liefert Prometheus-Text (`smartpilot_http_requests_total`,
  `…_duration_seconds_sum`/`_count`, `…_uptime_seconds`, `…_resident_memory_bytes`)
  — geschützt durch `ADMIN_TOKEN`.
- **CI-Matrix 22 + 26:** Die Gateway-CI testet zusätzlich gegen Node 26
  (Active LTS seit 28.10.2026). Die gepinnte Runtime bleibt vorerst 22.
- **Node 26 (Active LTS):** Runtime-Image, `engines.node` und CI laufen auf
  Node 26.13.0 (`>=26.0.0`). Aus dem Quellcode betrieben setzt das Gateway
  damit Node 26 voraus; das Docker-Image bringt es mit.
- **Admin-Routen aufgeteilt:** `routes/mcp.ts` ist in `mcpServers.ts`,
  `prompts.ts` und `logs.ts` zerlegt (Pfade unverändert).
- **Smoke-Test korrigiert:** `/admin` wird jetzt ohne Credentials auf `401`
  und mit Bearer-Token auf `200` geprüft. Die alte Erwartung („4xx trotz
  Bearer“) widersprach dem dokumentierten Token-oder-Cookie-Modus.
- **Hygiene-Gate:** ESLint, knip (toter Code), jscpd (Duplikate, Schwelle 3 %)
  und madge (Zyklen) sind als `npm run lint|deadcode|dupes|cycles` eingebunden
  und laufen in der Gateway-CI. `noUnusedLocals`/`noUnusedParameters` sind
  aktiv; die Datenbank-Sicherung hat einen Rundlauf-Test über alle
  Datenspalten, MCP-Fehlerfälle sind für HTTP und stdio paritätisch getestet.

### Geplant

- Native Alexa-Anbindung ohne Skill-Namen (Ausbau, siehe README „Warum es
  SmartPilot gibt")
- Weitere Sprachen: `packages/en/`, Interaktionsmodelle weiterer Locales,
  Sprechtexte der Lambda (derzeit nur `de-DE`)
- Signaturen bzw. eine geprüfte Paket-Registry (Ausbau laut

  [packages/README.md](packages/README.md))

## [0.4.0] – 2026-11-03

### Hinzugefügt

- **Zusätzliche HTTP-Header für MCP-Server:** `mcp_servers.headers` (JSON)
  sendet konfigurierbare Header mit, etwa `X-Portainer-API-Key` für das
  offizielle Portainer-MCP. Die Admin-UI akzeptiert `Name: Wert`-Zeilen;
  leer bedeutet „bestehenden Wert behalten“. Werte werden in der Admin-API
  maskiert.

### Behoben

- **Agent-Allowlist beachtet Groß-/Kleinschreibung:** MCP-Werkzeugnamen wie
  `EndpointList` wurden beim Einlesen der Allowlist kleingeschrieben und
  dadurch nicht gefunden. Die Namensliste bleibt jetzt im Originalcase;
  nur die Sonderwerte `alle`/`keine` werden case-insensitiv erkannt.

## [0.3.7] – 2026-11-01

### Behoben (Paket `music-assistant` 1.1.5)

- **Keine Wiedergabe-Werkzeuge für den Agenten:** Das MA-MCP bietet kein
  `search_tools`/`get_tool_schema`/`call_tool` mehr. Die Paket-Allowlist lief
  dadurch leer, der Agent meldete „keine Wiedergabe-Funktion". `allowTools`
  listet jetzt die echten Tool-Namen: `library_search_*`,
  `library_list_library_playlists/radio`, `queue_get_active_queue`,
  `playback_*`, `players_list_players/set_power`, `volume_*` sowie
  `fn_ma_players`.

### Geändert (Paket `home-assistant` 1.0.4)

- **Musik nur über Music Assistant:** Der Server-Prompt sperrt
  `ha_call_service`/`media_player.play_media` und andere `media_player.*`-
  Entities für Musik/Radio/Audio — auch bei Entities wie „Echo Wohnzimmer"
  (HA-Kopien, Amazon blockiert den direkten Stream). Musik läuft
  ausschließlich über `fn_ma_players` + `library_search_*`/`playback_*`;
  `fn_find_entities` wird für Player-Namen nicht mehr genutzt.

## [0.3.6] – 2026-11-01

### Behoben (Paket `music-assistant` 1.1.4)

- **Echo-Wiedergabe über den falschen Player:** Wurde ein Echo als
  HA-Kopie (`media_player.*`, Alexa Media Player) angesteuert, blockierte
  Amazon den direkten Stream („Direct music streaming isn't supported").
  Der Agent nutzt für Musik jetzt ausschließlich MA-native Player
  (`player_id` = Gerätename, z. B. `Echo Wohnzimmer`) und meidet
  `media_player.*` sowie `ha_call_service`; `ma_default_player` mit
  HA-Kopie wird ignoriert.

## [0.3.5] – 2026-10-04

### Geändert / Behoben (UX der Wartungsseite)

- **Reinstall ohne erneute Parametereingabe:** Das Install-Formular ist mit den
  bestehenden Werten vorbelegt; Secrets bleiben erhalten (Feld „(gesetzt – leer
  lassen zum Behalten)"). `existingParams()` rekonstruiert die Werte (nicht-geheim
  aus `packages.params`, Secrets aus den aufgelösten Server-Feldern) und der
  Install-Route füllt leere Felder auf. Nur eine echte Neuinstallation ohne Wert
  meldet weiterhin „erforderlich".
- **Konflikte mit Feld-Diff:** Der Dialog zeigt je Konflikt „lokal … → Paket …"
  (aus `packageDiff`, Secrets maskiert); die Entscheidung keep/take steht direkt
  daneben.
- **Diff-Vorschau lesbar:** Nur relevante (geänderte/neue/konfliktäre) Items;
  lange Werte (Template/Prompt) sind eingeklappt (`<details>`); verständliche
  Feldnamen statt Rohschlüssel; einheitliche Chips.
- **„Installierte Pakete" als Karten:** Artefakte klar getrennt, Kopfzeile mit
  Name/Version/Chips, Items darunter; die drei Aktionen (Testen, Neu installieren,
  Entfernen) stehen in einer Zeile (mit Umbruch auf schmalen Ansichten).
- **Optik:** Karten-Look, konsistente Abstände/Chips/Buttons, Hervorhebung von
  Konflikten/Updates.

## [0.3.4] – 2026-10-04

### Hinzugefügt

- **Diff-Vorschau im Install-/Update-Dialog:** Ein neuer Endpoint
  `POST /admin/api/packages/:id/diff` (kein Schreiben) liefert je Item den Status
  (neu / geändert / unverändert / Konflikt lokal) und die geänderten Felder als
  alt → neu; Secret-Felder (`auth_token`, `env`) werden maskiert. Der Dialog zeigt
  das vor dem Speichern.
- **Neustart-Hinweis nach Paket-Install:** Bringt ein Paket ein stdio-`npm_spec`
  mit, weist der Dialog vor dem Speichern und die Meldung nach dem Install auf den
  nötigen Container-Neustart hin (Provisioner läuft beim Start). Ohne `npm_spec`
  kein Hinweis.

### Behoben

- **Scheinkonflikt bei `args` (`'[]'` vs. `null`)** (Finding aus der Praxis):
  Die Bestandszeile trug `args='[]'`, das Manifest ohne `args` ergibt `null` —
  dadurch galt eine unveränderte Zeile (z. B. `searxng`) dauerhaft als Konflikt.
  `args` wird jetzt einheitlich normalisiert (`'[]'`/leer/`null` gleich); Migration 4
  hebt nachweislich unveränderte Item-Hashes entsprechend. Echte lokale Änderungen
  bleiben Konflikt.

## [0.3.3] – 2026-10-04

### Behoben

- **„Neu installieren" in der Paketübersicht wirkte wie ohne Funktion:** Der Klick
  öffnete das Bestätigungsformular, das aber im Card „Installationspakete"
  (unterhalb der verfügbaren Liste bzw. oberhalb der installierten Liste) außerhalb
  des sichtbaren Bereichs lag. Das Formular wird jetzt nach dem Öffnen in den Blick
  gescrollt.

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

[Unreleased]: https://github.com/dezihh/SmartPilot/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/dezihh/SmartPilot/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/dezihh/SmartPilot/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dezihh/SmartPilot/releases/tag/v0.4.0
[0.3.7]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.7
[0.3.6]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.6
[0.3.5]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.5
[0.3.4]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.4
[0.3.3]: https://github.com/dezihh/SmartPilot/releases/tag/v0.3.3
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
