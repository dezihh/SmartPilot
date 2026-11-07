# Sicherheit

## Unterstützte Versionen

Sicherheitskorrekturen erscheinen im jeweils neuesten Release und im rollenden
`latest`-Build. Ältere Stände werden nicht separat gepflegt — bitte vor einer
Meldung prüfen, ob das Problem im aktuellen Stand noch auftritt.

## Sicherheitslücke melden

Bitte **kein öffentliches Issue** für Sicherheitsprobleme. Nutze den privaten
Meldeweg von GitHub:

<https://github.com/dezihh/SmartPilot/security/advisories/new>

Hilfreich sind:

- betroffene Komponente (Gateway, Alexa-Lambda, Paket, Workflow),
- Version bzw. Commit,
- Reproduktion oder PoC, soweit möglich,
- erwartete und tatsächliche Auswirkung.

Bitte keine echten Tokens, Schlüssel oder personenbezogenen Daten mitschicken.
Beispielwerte genügen.

## Ablauf

1. Eingang wird bestätigt, sobald die Meldung gesichtet ist.
2. Wir prüfen Reproduzierbarkeit und Schweregrad und melden uns mit einer
   Einschätzung.
3. Nach dem Fix wird die Lücke im Changelog genannt; auf Wunsch nennen wir
   dich als Melder:in.

Das Projekt wird in der Freizeit gepflegt: Es gibt **keine garantierte
Reaktionszeit und kein Bug-Bounty-Programm**.

## Umfang

Im Scope:

- Gateway (`gateway/`): Authentifizierung/Autorisierung, SSRF-Schutz,
  Rate-Limiting, Secret-Handling, SQLite-Zugriff, Container-Härtung.
- Alexa-Lambda (`alexa/`): Token-Prüfung, Replay-Schutz, Umgang mit
  Nutzerdaten.
- Pakete (`packages/`): Manifest-Injection, Aufruf externer Ziele,
  Parametrisierung von Zugangsdaten.
- CI/CD-Workflows (`.github/workflows/`): Token-Rechte, Secrets in Logs.

Nicht im Scope:

- Fehlkonfiguration der eigenen Installation ohne Sicherheitsauswirkung
  (z. B. schwache Tokens bei deaktivierter Produktionsprüfung).
- Schwachstellen in Abhängigkeiten — bitte zusätzlich upstream melden; wir
  übernehmen sie über Dependabot und das Audit-Gate.
- Lasttests und Ressourcen-Erschöpfung ohne Umgehung einer Schutzschicht.

## Offenlegung

Wir veröffentlichen Details erst, nachdem ein Fix verfügbar ist, und stimmen
den Zeitpunkt bei Bedarf mit dir ab.
