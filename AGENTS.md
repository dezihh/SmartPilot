# AGENTS.md — Hinweise für Beiträge (SmartPilot)

Kurzanleitung für Menschen und automatisierte Beiträge, damit wir einheitlich
arbeiten. Verbindlicher Kanon bleibt `CONTRIBUTING.md` und `CHANGELOG.md`.

## Projektstruktur

- `gateway/` — Node 22, TypeScript ESM, Express, SQLite (der Server)
- `alexa/lambda/` — Python-Lambda (ask-sdk), einziger Alexa-Adapter
- `packages/` — Installationspakete in der Registry (`packages/<lang>/`)
- `doc/` — Doku-Kanon (Installation, Referenz, Deployment, Architektur)

Gateway und Pakete versionieren **getrennt** (siehe unten).

## Sprache & Format

- Code, Kommentare und Commit-Messages: Englisch/ASCII.
- Doku und Changelog: Deutsch.
- Commits im Conventional-Commits-Format: `feat:`, `fix:`, `chore:`,
  `refactor:`, `docs:`, `test:` (kein Scope-Zwang).

## Prüfen vor jedem Commit

```bash
cd gateway
npm run typecheck && npm run typecheck:tests && npm test && npm run build
python3 ../alexa/lambda/test_lambda_function.py   # falls Lambda berührt
```

## Release (Gateway) — verbindlich

Regeln: `CONTRIBUTING.md` §Versionierung. SemVer; solange < 1.0.0 gilt:
Features = MINOR, Fixes = PATCH, Breaking Changes vermeiden.

1. Änderungen unter `[Unreleased]` im `CHANGELOG.md` sammeln
   (Format angelehnt an „Keep a Changelog", neueste zuerst).
2. Beim Release:
   - `[Unreleased]` in einen **datierten** Abschnitt überführen:
     `## [X.Y.Z] – JJJJ-MM-TT`; ein neues, leeres `[Unreleased]` bleibt oben.
   - `gateway/package.json` → `"version"` auf `X.Y.Z` heben. Das ist die
     Quelle für `GATEWAY_VERSION` (`gateway/src/version.ts`), gegen die der
     Paket-Install `minGatewayVersion` prüft.
   - Compare-Links am Ende des `CHANGELOG.md` aktualisieren.
3. Auf `main` committen, dann Tag setzen und pushen:

   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

   Der Tag `v*` löst `.github/workflows/lambda-zip.yml` aus, das automatisch
   ein **versioniertes GitHub-Release** mit den Lambda-Zips baut (neben dem
   rollenden Release `latest`).
   - Hinweis: Der Workflow hat unter `push` einen `paths`-Filter
     (`alexa/lambda/**`). Triggert ein Tag-Push deshalb nicht, den Workflow
     manuell per `workflow_dispatch` starten — das erzeugt allerdings nur das
     rollende `latest`, kein versioniertes Release.

## Release (Paket) — separat

- `version` im `manifest.json` **und** im passenden `packages/<lang>/index.json`
  angleichen (müssen übereinstimmen), das `changelog`-Feld im Manifest ergänzen
  (neueste Zeile oben) und die Paket-README bei Verhaltensänderungen anpassen.

## Referenzen

- `CONTRIBUTING.md` — Beiträge, Versionierung, Grundsätze
- `CHANGELOG.md` — versionsweise Änderungen
- `doc/DEPLOYMENT.md` — CI/CD, Deploy-Workflows
- `doc/ARCHITECTURE.md` — Design (Architektur-Archiv)
