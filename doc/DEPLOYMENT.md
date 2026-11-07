# Deployment und CI/CD (Entwicklerdoku)

> Zielgruppe: Betreiber und Entwickler. Diese Datei beschreibt die
> automatisierten Deploy-Wege über GitHub Actions sowie die AWS-/Alexa-Interna.
> Für die klassische Installation durch Anwender siehe [Alexa anbinden](ALEXA.md).

## Architektur

```text
Alexa Skill  ->  AWS Lambda (smartpilot-alexa)  ->  POST /api/query  ->  Gateway
```

Die Lambda ist ein dünner Adapter. Routing, LLM, MCP und Werkzeuge bleiben im
Gateway. Das Gateway hat **keinen** direkten Alexa-Endpunkt; Alexa erreicht es
ausschließlich über die Lambda und `POST /api/query` (Bearer-Token).

## Voraussetzungen

- Ein laufendes, öffentlich per HTTPS erreichbares Gateway (siehe
  [Installation](INSTALLATION.md)); `POST /api/query` antwortet mit dem
  Bearer-Token `API_TOKEN`.
- Ein vorhandener Alexa-Skill (Skill-ID). Die Anlage beschreibt
  [Alexa anbinden](ALEXA.md); ohne Skill gibt es keine `ALEXA_SKILL_ID`.
- Ein AWS-Konto und ein Deploy-Benutzer mit Rechten für Lambda und IAM
  (Funktion, Rolle, `add-permission`).
- Schreibzugriff auf die Actions dieses Repos, um Secrets und Variablen zu setzen.

## GitHub-Konfiguration

Nur Namen und Zweck – die Werte liegen ausschließlich in den Repo-Secrets.

### Secrets

| Secret | Zweck |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS-Deploy-Benutzer |
| `AWS_REGION` | AWS-Region (Default `eu-west-1`) |
| `AWS_LAMBDA_ROLE` | optional: bestehende Rollen-ARN überspringt die Auto-Anlage |
| `GATEWAY_URL` | öffentliche Basisadresse des Gateways |
| `API_TOKEN` | muss dem `API_TOKEN` des Gateways entsprechen (Adapter-API; genutzt von Lambda- und Debug-Workflows) |
| `ALEXA_SKILL_ID` | Skill-ID: Lambda-`applicationId`-Prüfung und Invoke-Trigger |
| `ASK_AUTH_INFO` / `ASK_CLI_CONFIG` | ASK-CLI-/SMAPI-Anmeldung (base64), für Skill-Sync |

### Variables

| Variable | Zweck |
|---|---|
| `EXTERNAL_BASE_URL` | öffentliche Gateway-Basis; Gate für `ext-check` |
| `ALEXA_SKILL_ID` | Skill-ID als Repo-Variable (u. a. Alt-Workflows/Ext-Check) |

### Wo eintragen

Repo → **Settings → Secrets and variables → Actions**. Secrets werden in Logs
maskiert; Variables sind sichtbar.

### ASK-CLI-Anmeldung erzeugen

`ASK_AUTH_INFO` und `ASK_CLI_CONFIG` sind base64 der ASK-CLI-Dateien. Auf einem
Rechner mit eingerichteter ASK CLI (`ask configure`):

```bash
base64 -w0 ~/.ask/auth_info   # -> Secret ASK_AUTH_INFO
base64 -w0 ~/.ask/cli_config  # -> Secret ASK_CLI_CONFIG
```

Ohne diese beiden Secrets laufen `sync-manifest.yml`, `sync-model.yml` und
`deploy-alexa.yml` nicht.

## CI

- `gateway-ci.yml` — Typecheck (Quellcode **und** Tests) und Tests des
  Gateways; läuft bei Änderungen unter `gateway/**` (Push auf `main`,
  Pull Requests) und manuell.
- `lambda-ci.yml` — Tests der Alexa-Lambda
  (`alexa/lambda/test_lambda_function.py`; stubbt ask-sdk/requests, es wird
  nichts installiert); läuft bei Änderungen unter `alexa/lambda/**` und
  manuell.

## Workflows

Die Deploy- und Sync-Workflows startest du manuell über `workflow_dispatch`
(Actions → Workflow → **Run workflow**); `lambda-zip.yml` läuft zusätzlich
automatisch bei Änderungen unter `alexa/lambda/**` (oder am Workflow selbst).

| Workflow | Zweck |
|---|---|
| `lambda-zip.yml` | Baut bei Änderungen unter `alexa/lambda/**` zwei Zips: `smartpilot-alexa-lambda.zip` (eigene AWS-Lambda) und `smartpilot-alexa-hosted.zip` (`lambda/`-Struktur für den Alexa-hosted-Import); Artifacts + rollendes `latest`-Release, bei Tag `v*` oder manuellem Start (`workflow_dispatch`) zusätzlich ein versioniertes Release `v<version>` (Version aus `gateway/package.json`) |
| `deploy-aws-lambda.yml` | Nutzt den zentralen Build (`lambda-zip.yml`) und deployt das Artifact: legt Funktion + Ausführungsrolle an/aktualisiert sie, setzt Env-Variablen und den Alexa-Invoke-Trigger |
| `sync-manifest.yml` | Read-modify-write des Skill-Manifests: Endpoint auf Lambda-ARN (Top-Level und `regions.*`), ergänzt APL-Interface + Viewports; Inputs `endpoint_arn`, `add_apl`, `dry_run` |
| `sync-model.yml` | Rendert die Aufrufnamen aus `skill.config.json` und lädt die Interaction Models aller eingetragenen Locales in den development-Stage; pollt den Build-Status |
| `deploy-alexa.yml` | Optional/Legacy: rendert Namen und Aufrufnamen aus `skill.config.json` und pusht das Skill-Package in das Alexa-hosted CodeCommit-Repo (Branch `dev`/`master`) + SMAPI-Build |
| `ext-check.yml` | Prüft TLS, `POST /api/query` mit `API_TOKEN` und dass `/alexa`, `/privacy`, `/admin` öffentlich nicht erreichbar sind. Sendet keine direkten Alexa-Requests |
| `lambda-logs.yml` | CloudWatch-Logs der Lambda (`/aws/lambda/smartpilot-alexa`) |
| `list-skills.yml` | Listet die Skills des Vendors |

### `lambda-zip.yml`

Baut bei jeder Änderung unter `alexa/lambda/**` zwei Zips:

- `smartpilot-alexa-lambda.zip` – Funktion + Abhängigkeiten (aus
  `alexa/lambda/requirements.txt`), für die eigene AWS-Lambda.
- `smartpilot-alexa-hosted.zip` – `lambda/`-Struktur (`lambda_function.py`,
  `requirements.txt`, `config.json.example`) für den Import in einen
  Alexa-hosted Skill. Enthält bewusst **kein `config.json`** (öffentliches
  Asset) — die Vorlage `config.json.example` wird nach dem Import als
  `config.json` mit Token angelegt.

Ergebnis: Actions-Artifacts für den CI-Weg, ein rollendes Release `latest`
(stabile Links `releases/download/latest/…`) und **zusätzlich ein versioniertes
Release `v<version>`** — bei Tag `v*` (Tag-Name) sowie bei manuellem Start
(`workflow_dispatch`). Die Version liest der Workflow aus
`gateway/package.json`; der optionale Input `version` überschreibt sie. Ein per
`workflow_call` gestarteter Build (aus `deploy-aws-lambda.yml`) veröffentlicht
kein Release.

### `deploy-aws-lambda.yml`

Ruft zuerst `lambda-zip.yml` per `workflow_call` auf und lädt dessen Artifact;
das Zip wird also nur an einer Stelle gebaut.

1. Lädt das im Build-Job erzeugte Zip (Funktion + ask-sdk + requests).
2. Legt bei Bedarf die IAM-Ausführungsrolle `smartpilot-lambda-execution` an
   (inkl. CloudWatch-Logs-Policy) oder nutzt `AWS_LAMBDA_ROLE`.
3. Erstellt/aktualisiert `smartpilot-alexa` (Python, 512 MB, Timeout
   konfigurierbar) und setzt die Env-Variablen. `skill_name` und
   `assistant_name` kommen aus `alexa/skill.config.json` (primäre Locale).
4. Setzt den Alexa-Skills-Kit-Trigger (`aws lambda add-permission`,
   `--event-source-token` = Skill-ID). Eine zuvor gesetzte Permission wird
   **vorher entfernt**, damit eine geänderte `ALEXA_SKILL_ID` die alte
   Permission tatsächlich ersetzt und nicht an einem Statement-ID-Konflikt
    scheitert. Ohne Trigger lehnt Amazon den ARN-Endpoint ab.
5. Neuanlage nutzt die Runtime `python3.14`. Existiert sie in der Region nicht,
   schlägt nur `create-function` fehl; eine bestehende Funktion wird per
   `update-function-code` aktualisiert und ist davon nicht betroffen.

### `sync-manifest.yml`

Das Manifest wird **ausschließlich hier** auf die Lambda-ARN gesetzt. Wichtig:
Amazon liefert über `regions.*.endpoint` aus – nur das Top-Level-`endpoint`
zu setzen reicht nicht, der Workflow schreibt `regions.EU`/`NA`/`FE` mit.
Der ARN kommt als Input `endpoint_arn` (Ausgabe von `deploy-aws-lambda.yml`);
ohne diesen Input bleibt der Endpoint unverändert. Mit `dry_run=1` wird nur der
aktuelle Zustand angezeigt (kein PUT).

## Lambda-Umgebungsvariablen

| Variable | Herkunft |
|---|---|
| `gateway_url` | Secret `GATEWAY_URL` |
| `api_token` | Secret `API_TOKEN` (gleich `API_TOKEN` des Gateways) |
| `api_signing_secret` | optional, Secret `API_SIGNING_SECRET` (gleich dem Gateway); gesetzt = signierte Anfragen mit `X-Timestamp`, `X-Nonce`, `X-Signature` |
| `alexa_skill_id` | Secret `ALEXA_SKILL_ID`; wird vor der Verarbeitung gegen die `applicationId` geprüft |
| `watchdog_delay`, `gateway_timeout`, `apl_exit_delay_ms` | feste Werte aus dem Workflow |
| `skill_name`, `assistant_name` | aus `alexa/skill.config.json` (primäre Locale) |

## Skill-Namen und Sprachen

`alexa/skill.config.json` ist die zentrale Quelle für Anzeigename, Aufrufname
und Assistenten-Name, aufgebaut pro Locale:

```json
{ "locales": { "de-DE": { "skill_name": "SmartPilot", "invocation_name": "smart pilot", "assistant_name": "Dein SmartPilot" } } }
```

`alexa/scripts/skill_config.py` rendert daraus den `invocationName` (Modell) und
den Anzeigenamen (Manifest) und gibt die Namen für die Lambda-Umgebung aus
(`--render-all`, `--check`, `--print-env <locale>`). `sync-model.yml`,
`deploy-alexa.yml` und `deploy-aws-lambda.yml` nutzen dieses Skript. Eine weitere
Sprache ist ein zusätzlicher `locales`-Eintrag plus eine Modell-Datei
`interactionModels/custom/<locale>.json`; die festen Sprechtexte der Lambda sind
derzeit nur für `de-DE` hinterlegt.

## Skill-ID-Handling

- `ALEXA_SKILL_ID` ist Deployment-Pflicht (Secret); `deploy-aws-lambda.yml`
  und `deploy-alexa.yml` brechen ohne sie ab.
- Die Prüfung der `applicationId` passiert **autoritativ in der Lambda**: der
  eingebaute ASK-SDK-Verifier (`sb.skill_id`) lehnt Events mit abweichender
  `applicationId` ab. Im AWS-Fall ist zusätzlich die Invoke-Permission auf die
  Skill-ID begrenzt (`--event-source-token`), im hosted-Fall steht die ID in
  der `config.json`.
- **Wichtig:** Die Skill-ID ist **keine** Gateway-Authentisierung. Am
  `/api/query`-Request gilt allein Bearer (`API_TOKEN`). Die Lambda sendet die
  ID zusätzlich als Header `X-Alexa-Skill-Id` mit — das ist **nur Log/Trace**
  und **keine Sicherheitsgrenze** (der Header ist frei setzbar; wer das
  `API_TOKEN` hat, kann ihn beliebig wählen). Deshalb prüft das Gateway ihn nur
  warnend (`ALEXA_SKILL_ID`, optional) und lehnt nichts ab.
- **Optionaler Replay-Schutz:** Mit `API_SIGNING_SECRET` (Gateway) bzw.
  `api_signing_secret` (Lambda) signiert die Lambda zusätzlich
  `X-Timestamp`, `X-Nonce` und den SHA-256 des Body-Hashes mit
  HMAC-SHA256 (`X-Signature`). Das Gateway akzeptiert die Signatur nur
  innerhalb von `API_SIGNATURE_TTL_SECONDS` (Default 300 s) und nur einmal pro
  Nonce. Ohne Secret bleibt es beim reinen Bearer-Token.
  **Reihenfolge beim Aktivieren:** erst die Lambda mit dem Secret deployen,
  dann das Gateway — das Gateway ignoriert die Header ohne Secret, umgekehrt
  würde es alle Adapter-Aufrufe mit 401 ablehnen.

## Deployment-Reihenfolge

1. `deploy-aws-lambda.yml` – Funktion, Env, Trigger. Am Ende gibt der Job
   `LAMBDA_ARN=…` aus; diesen Wert kopieren.
2. `sync-manifest.yml` – Input `endpoint_arn` = diese ARN. Setzt den Endpoint
   (Top-Level und `regions.*`) und ergänzt APL/Viewports. Ohne `endpoint_arn`
   bleibt der Endpoint unverändert (kein hartcodierter Fallback).
3. `sync-model.yml` – Interaction Models aller Locales in den development-Stage.
4. `ext-check.yml` – Verifikation (TLS, `/api/query`, öffentliche Sperren).
5. Abnahme – Simulator- und Echo-Test (siehe [Alexa anbinden](ALEXA.md#6-testen)).

Alle SMAPI-Schritte arbeiten im `development`-Stage. Ein Live-Release ist ein
separater Schritt (Console oder `deploy-alexa.yml` auf `master`).

Diagnose-Workflows nach Bedarf.

## Lokale Entwicklung und Tests

### Gateway im Docker-Dev-Modus (Standard)

Die Entwicklung läuft in Docker: Der Quellcode ist per Bind-Mount eingebunden,
Änderungen starten den Prozess automatisch neu (`tsx watch` im Container).

```bash
docker compose -f gateway/docker-compose.yml up --build
```

- Erreichbar unter `http://localhost:3000/admin` (Host-Port via `GATEWAY_PORT`).
- Voraussetzung: `gateway/.env` (Vorlage: `gateway/.env.example`).
- Tests im laufenden Container:
  `docker compose -f gateway/docker-compose.yml exec gateway npm test`

### Direkt auf dem Host (Alternative)

Node.js ≥ 26 erforderlich:

```bash
cd gateway
npm ci
npm test             # Unit-Tests (node:test)
npm run typecheck    # Typprüfung (tsc --noEmit)
npm run dev          # tsx watch für Entwicklung
npm run smoke        # E2E-Smoke-Test gegen laufendes Gateway (Env GATEWAY, ADMIN_TOKEN)
```

### Weitere Werkzeuge

| Werkzeug | Zweck |
|---|---|
| `alexa/scripts/sync_skill.py` | Interaction Models aller Locales lokal per SMAPI synchronisieren; rendert Aufrufnamen aus `skill.config.json`; benötigt `alexa/skill.local.json` (nur `skill_id`) und ASK-CLI-Anmeldung |
| `gateway/scripts/smoke-test.mjs` | End-to-End-Smoke-Tests gegen ein laufendes Gateway |
| `alexa/lambda/test_lambda_function.py` | Lambda-Tests (stubben das ask-sdk, laufen ohne AWS/Netz) |

## Logs und Metriken

- **Logformat:** eine Zeile pro Ereignis, z. B.
  `2026-11-06T20:12:33.456Z INFO  req=3f1a… http method=POST path=/api/query status=200 ms=812`.
  `LOG_LEVEL` steuert die Ausführlichkeit (`info` Standard; `debug` ergänzt
  Stacktraces und Tool-Details). Warnungen und Fehler gehen nach stderr.
- **Anfrage-Kennung:** Das Gateway setzt `X-Request-ID` im Antwortheader und
  schreibt sie in jede Logzeile des Requests. Ein eingehendes `X-Request-ID`
  wird übernommen, sofern es aus 8–64 Zeichen `[A-Za-z0-9._-]` besteht
  (damit nginx-Logs und Gateway-Logs zusammenfinden).
- **Metriken:** `GET /metrics` (Bearer `ADMIN_TOKEN`) liefert Prometheus-Text:
  Anfragen und Dauer je Route/Status, Uptime und Speicherverbrauch. Beispiel
  für einen Scrape-Job:

  ```yaml
  - job_name: smartpilot
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/smartpilot-admin-token
    static_configs:
      - targets: ['127.0.0.1:8331']
  ```

## Sicherheit

- Keine Secret-Werte in Repo, Doku oder Actions-Logs.
- `API_TOKEN` und `ADMIN_TOKEN` nur im `Authorization`-Header; in Diagnose-Logs
  maskiert. `API_TOKEN` gilt für die Adapter-API (`/api/query`), `ADMIN_TOKEN`
  für Admin-UI/API.
- Öffentlich erreichbar ist nur `/api/query` (Bearer). Admin-UI/API und die
  früheren Pfade `/alexa` und `/privacy` sind nicht öffentlich exponiert.
- `TRUST_PROXY` hinter nginx setzen, sonst greift das Login-Rate-Limit nicht
  pro Client (ein Angreifer könnte den Admin-Login global sperren).
- `/api/lambda-trace` ist reine Diagnose und bleibt im öffentlichen VHost
  gesperrt.
- **Paket-Registry = Code-Vertrauensgrenze:** Manifeste sind nicht signiert;
  `index.json` führt aber je Paket Version und SHA-256 der Manifest-Datei.
  Das Gateway lädt das Manifest als Rohtext und lehnt es ab, wenn Hash oder
  Version nicht zum Index passen. Das schützt vor nachträglich getauschten
  Inhalten und halb aktualisierten Registries — nicht vor einer vollständig
  übernommenen Registry (Index und Manifeste stammen von derselben Quelle).

  `shell()`/stdio verlangen ein Ack; die Konfigurationsansicht verlangt es
  erneut, sobald ein Parameter ein gefährliches Feld (`shell()`, `command`,
  `args`, `env`) verändert. `http()`-Ziele in Manifesten gelten als
  vertraut (SSRF-Prüfung nur für dynamische, argumentgesteuerte URLs) —
  nur Registries einsetzen, denen man vertraut.
