# Beitragen

Danke, dass du zu SmartPilot beitragen möchtest! Es gibt drei Wege — nach
Aufwand sortiert. Alle laufen über GitHub-Issues oder Pull Requests in diesem
Repository.

Für alle Wege gilt der [Verhaltenskodex](CODE_OF_CONDUCT.md)
(zweisprachig, Englisch/Deutsch).

## 1. Fehler melden und Ideen einbringen

Der einfachste Beitrag. Nutze die Issue-Vorlagen:

- **Bug** — Fehlerbericht mit Reproduktionsschritten und Log-Ausschnitt
  (ohne Secrets). Vorlage: `.github/ISSUE_TEMPLATE/bug_report.md`
- **Feature / Funktion** — Idee mit Bereich und MVP-Skizze.
  Vorlage: `.github/ISSUE_TEMPLATE/feature_request.md`

Hilfreich für jeden Bericht: Gateway-Version (bzw. Commit), was du erwartet
hast, was passiert ist, und ein Trace-/Log-Ausschnitt aus der Admin-Oberfläche.

## 2. Installationspakete beisteuern

Pakete sind generische Praxisrezepte, die überall laufen, wo die genannte
Gegenseite vorhanden ist. Der Grundgedanke, die Parametrierung und das
Vertrauensmodell sind in [`packages/README.md`](packages/README.md)
beschrieben — bitte vorher lesen, dort stehen auch die Struktur- und
Meta-Regeln für ein Paket.

Kurzfassung:

- Vor dem eigenen Paket ein bestehendes als Muster lesen: `autobahn`
  (schlank) oder `home-assistant` (vollständig).
- Installations-spezifische Werte (Hosts, Tokens, Pfade) gehören in
  Parameter (`params` + `${key}`); nötige Beispielwerte sind erlaubt, müssen
  aber klar als Beispiel markiert sein.
- Beitrag per Pull Request gegen `packages/de/<id>/` — inklusive Eintrag in
  `packages/de/index.json`.

## 3. Code beitragen

Für Gateway- und Lambda-Änderungen:

1. Issue aufmachen (oder ein bestehendes abonnieren), bevor größer gebaut
   wird — so stimmen wir über den Ansatz ab.
2. Entwicklungsumgebung und Tests: siehe
   [Deployment und lokale Entwicklung](doc/DEPLOYMENT.md#lokale-entwicklung-und-tests)
   (Docker-Dev-Modus oder direkt auf dem Host).
3. Pull Request mit Bezug zum Issue; die CI (Smoke-Tests) muss grün sein.
   Nennenswerte Änderungen zusätzlich unter `[Unreleased]` im
   [Changelog](CHANGELOG.md) eintragen.

Dabei gelten drei Grundsätze:

- **Klein und testbar.** Gelieferter Code kommt in kleinen, testbaren
  Einheiten (Paketen) — inklusive Tests, wo möglich. `gateway/test/`
  zeigt das Muster; größere Vorhaben werden in Schritte zerlegt, die
  einzeln review- und testbar sind.
- **Wenig an Bestehendem ändern.** Bestehenden Code möglichst unverändert
  lassen: Jede Änderung am laufenden Code ist ein Regressionsrisiko.
  Erweiterungen bevorzugen — neues Modul, neue Funktion, neuer Test
  statt Umbau.
- **Keine Breaking Changes.** Änderungen dürfen bestehende Setups nicht
  brechen: Konfiguration, Env-Variablen, Paket-Manifeste und
  Schnittstellen bleiben abwärtskompatibel. Ist ein Bruch unvermeidlich,
  gehört er ins Issue und wird in der Doku deutlich markiert
  (Migrations-Hinweis).

Architektur-Regeln und Design-Entscheidungen stehen in
[doc/ARCHITECTURE.md](doc/ARCHITECTURE.md) — insbesondere das
Adapter-Muster (der Core kennt kein Alexa) und die Trennung von
generischen Inhalten (Pakete) und Infrastruktur.

## Versionierung

Zwei unabhängige Versionen, beide nach
[SemVer](https://semver.org/lang/de/):

| Achse | Ort | Wirkung |
|---|---|---|
| Gateway | `gateway/package.json` | wird beim Paket-Install gegen `minGatewayVersion` geprüft (erzwungen) |
| Paket | `manifest.json` **und** Eintrag in `packages/de/index.json` (müssen übereinstimmen) | nur das jeweilige Paket |

Stufen:

- **PATCH** (`0.1.0 → 0.1.1`): Bugfixes, Doku, Dependency-Updates — kein
  Verhaltenswechsel.
- **MINOR** (`0.1.x → 0.2.0`): neue Features abwärtskompatibel — neue
  Template-Bausteine, Settings, Admin-Endpunkte, neue Pakete.
- **MAJOR**: Breaking Changes — Env-Variablen entfernt oder umbenannt,
  Antwortvertrag, DB-Schema, Paket-Parameter umbenannt. Immer mit
  Migrations-Hinweis im Changelog.

Ablauf Gateway-Release: Änderungen sammeln sich unter `[Unreleased]` im
[Changelog](CHANGELOG.md); beim Release Version heben, `[Unreleased]` zum
datierten Abschnitt machen und Tag `v*` pushen — `lambda-zip.yml` baut
dann automatisch ein versioniertes Release (neben dem rollenden
`latest`).

Ablauf Paket-Release: `version` im `manifest.json` heben, denselben Wert
in `packages/de/index.json` eintragen, `changelog`-Feld im Manifest
ergänzen (neueste Zeile oben), Paket-README bei Verhaltensänderungen
anpassen.

Solange die Version unter `1.0.0` liegt: Features als MINOR, Fixes als
PATCH, Breaking Changes vermeiden (siehe Grundsätze oben). `1.0.0` setzt
du bewusst, wenn der Env-/API-Vertrag eingefroren ist — es signalisiert,
dass bestehende Setups Updates überleben.

## Stil für Dokumentation

Doku-Änderungen sind ebenfalls Beiträge. Konventionen:

- Sprache: (aktuell)Deutsch.
- Schreibprinzip: Ziel → Einrichtung → Prüfung → Hintergrund; jeder Schritt
  mit Prüfschritt.
- Code-Fakten vor Behauptungen: Was die Doku über Verhalten sagt, sollte im
  Code verifiziert sein.
- Umgangsformen: siehe [Verhaltenskodex](CODE_OF_CONDUCT.md).
