# Beitragen

Danke, dass du zu SmartPilot beitragen möchtest! Es gibt drei Wege — nach
Aufwand sortiert. Alle laufen über GitHub-Issues oder Pull Requests in diesem
Repository.

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

Architektur-Regeln und Design-Entscheidungen stehen in
[doc/ARCHITECTURE.md](doc/ARCHITECTURE.md) — insbesondere das
Adapter-Muster (der Core kennt kein Alexa) und die Trennung von
generischen Inhalten (Pakete) und Infrastruktur.

## Stil für Dokumentation

Doku-Änderungen sind ebenfalls Beiträge. Konventionen:

- Sprache: Deutsch.
- Schreibprinzip: Ziel → Einrichtung → Prüfung → Hintergrund; jeder Schritt
  mit Prüfschritt.
- Code-Fakten vor Behauptungen: Was die Doku über Verhalten sagt, sollte im
  Code verifiziert sein.
