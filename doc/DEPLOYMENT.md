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
  Bearer-Token `AUTH_TOKEN`.
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
| `GATEWAY_TOKEN` | muss dem `AUTH_TOKEN` des Gateways entsprechen |
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

## Workflows

Die Deploy- und Sync-Workflows startest du manuell über `workflow_dispatch`
(Actions → Workflow → **Run workflow**); `lambda-zip.yml` läuft zusätzlich
automatisch bei Änderungen unter `alexa/lambda/**`.

| Workflow | Zweck |
|---|---|
| `lambda-zip.yml` | Baut bei Änderungen unter `alexa/lambda/**` zwei Zips: `smartpilot-alexa-lambda.zip` (eigene AWS-Lambda) und `smartpilot-alexa-hosted.zip` (`lambda/`-Struktur für den Alexa-hosted-Import); Artifacts + rollendes `latest`-Release, bei Tag `v*` ein versioniertes Release |
| `deploy-aws-lambda.yml` | Nutzt den zentralen Build (`lambda-zip.yml`) und deployt das Artifact: legt Funktion + Ausführungsrolle an/aktualisiert sie, setzt Env-Variablen und den Alexa-Invoke-Trigger |
| `sync-manifest.yml` | Read-modify-write des Skill-Manifests: Endpoint auf Lambda-ARN (Top-Level und `regions.*`), ergänzt APL-Interface + Viewports; Inputs `endpoint_arn`, `add_apl`, `dry_run` |
| `sync-model.yml` | Rendert die Aufrufnamen aus `skill.config.json` und lädt die Interaction Models aller eingetragenen Locales in den development-Stage; pollt den Build-Status |
| `deploy-alexa.yml` | Optional/Legacy: rendert Namen und Aufrufnamen aus `skill.config.json` und pusht das Skill-Package in das Alexa-hosted CodeCommit-Repo (Branch `dev`/`master`) + SMAPI-Build |
| `ext-check.yml` | Prüft TLS, `POST /api/query` mit `GATEWAY_TOKEN` und dass `/alexa`, `/privacy`, `/admin` öffentlich nicht erreichbar sind. Sendet keine direkten Alexa-Requests |
| `debug-lambda-invoke.yml` | Ruft die Lambda direkt mit einem `GptQueryIntent`-Event auf |
| `debug-lambda-live.yml` | Zeigt Lambda-Env-Namen (URLs/Token maskiert) und testet das Gateway direkt |
| `debug-lambda-logs.yml` / `lambda-logs.yml` | CloudWatch-Logs der Lambda (`/aws/lambda/smartpilot-alexa`) |
| `debug-skill.yml` | SMAPI-Diagnose: Invocation/Samples, Manifest-Endpoint je Stage, Build-Status |
| `list-skills.yml` | Listet die Skills des Vendors |

### `lambda-zip.yml`

Baut bei jeder Änderung unter `alexa/lambda/**` zwei Zips:

- `smartpilot-alexa-lambda.zip` – Funktion + Abhängigkeiten (aus
  `alexa/lambda/requirements.txt`), für die eigene AWS-Lambda.
- `smartpilot-alexa-hosted.zip` – `lambda/`-Struktur (`lambda_function.py`,
  `requirements.txt`) für den Import in einen Alexa-hosted Skill. Enthält
  bewusst **kein `config.json`** (öffentliches Asset).

Ergebnis: Actions-Artifacts für den CI-Weg, ein rollendes Release `latest`
(stabile Links `releases/download/latest/…`) und bei Tag `v*` ein versioniertes
Release.

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
| `gateway_token` | Secret `GATEWAY_TOKEN` (gleich `AUTH_TOKEN` des Gateways) |
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

- `ALEXA_SKILL_ID` bleibt als Deployment-Secret erhalten.
- `deploy-aws-lambda.yml` setzt sie als Lambda-Env `alexa_skill_id` **und**
  begrenzt die Invoke-Permission auf genau diese Skill-ID.
- Die Lambda nutzt den eingebauten Verifier des ASK SDK (`sb.skill_id`):
  Events mit abweichender `applicationId` werden abgelehnt.
- Die Skill-ID ist **keine** Gateway-Authentisierung und wird dem
  `/api/query`-Request nicht hinzugefügt; dort gilt weiter Bearer
  (`AUTH_TOKEN`).

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

## Lokale Betreiber-Werkzeuge

| Werkzeug | Zweck |
|---|---|
| `alexa/scripts/sync_skill.py` | Interaction Models aller Locales lokal per SMAPI synchronisieren; rendert Aufrufnamen aus `skill.config.json`; benötigt `alexa/skill.local.json` (nur `skill_id`) und ASK-CLI-Anmeldung |
| `gateway/scripts/smoke-test.mjs` | End-to-End-Smoke-Tests gegen ein laufendes Gateway |
| `alexa/lambda/test_lambda_function.py` | Lambda-Tests (stubben das ask-sdk, laufen ohne AWS/Netz) |
| `gateway` `npm test` / `npm run typecheck` / `npm run build` | Gateway-Tests und Typprüfung |

## Sicherheit

- Keine Secret-Werte in Repo, Doku oder Actions-Logs.
- `GATEWAY_TOKEN` nur im `Authorization`-Header; in Diagnose-Logs maskiert.
- Öffentlich erreichbar ist nur `/api/query` (Bearer). Admin-UI/API und die
  früheren Pfade `/alexa` und `/privacy` sind nicht öffentlich exponiert.
