# Tests und Coverage

Die Gateway-Tests laufen mit dem Node-Test-Runner (`node --test`) über
`tsx`, ohne Browser und ohne echtes Netz.

```bash
npm test        # alle Tests in test/*.test.ts
npm run coverage  # dieselben Tests mit Abdeckungsmessung
```

## Gate-Treppe

Nicht jede Prüfung läuft bei jeder Zwischenänderung. Drei Stufen:

| Stufe | Wann | Befehl |
|---|---|---|
| Innenloop | während der Arbeit | `npm run typecheck` + betroffene Testdatei |
| vor dem Commit | `npm run gates:fast` | Typecheck, Test-Typecheck, Lint, Tests |
| vor Merge/Release | `npm run gates:full` | `gates` + Coverage + Build |

`gates:full` enthält `typecheck`, `typecheck:tests`, `lint`, `deadcode`,
`cycles`, `dupes`, `audit:gate`, `coverage` und `build`. Die früheren
`gates`/`gates:all` bleiben unverändert bestehen.

## Testtiefe nach Risiko

Die Tiefe folgt dem Risiko, nicht der Zeilenzahl (NFR 6):

| Änderung | Pflichtumfang |
|---|---|
| Bugfix | ein Regressionstest, der ohne den Fix rot ist |
| Feature / Verhaltensänderung | Happy Path + zwei Grenzfälle |
| Refactoring, Umbenennung, Formatierung | keine neuen Tests |
| Typ-only, Doku, Kommentar | keine Tests |
| Fehlerpfad einer Fremdbibliothek | nur, wenn eigenes Verhalten daran hängt |

Kritische Pfade — `src/auth.ts`, `src/apiSignature.ts`, `src/rateLimit.ts`,
`src/config.ts`, `src/core/ssrf.ts`, `src/core/session.ts`, `src/db.ts` und
`src/db/` — brauchen zusätzlich die Fehler- und Grenzfälle des Pfads,
unabhängig vom Änderungstyp.

## Messbasis

`npm run coverage` misst ausschließlich den Produktivcode:

```bash
--test-coverage-include='src/**'
```

**Grund:** Ohne Eingrenzung zählt der Runner auch `test/*.test.ts` und
`web/**` mit. Beide verzerren die Quote: Testdateien sind nahezu vollständig
abgedeckt und heben die Zahl künstlich; die Browser-Skripte unter `web/js/`
sind unter `node:test` nicht sinnvoll messbar. Die Web-Helfer-Tests laufen
weiterhin mit, zählen aber nicht in die Quote.

## Diff-Coverage ist maßgeblich

Die globale Quote ist eine **Regressionsbremse**, kein Testziel. Bewertet wird
die Abdeckung der geänderten Zeilen:

- mindestens **90 %** der geänderten Produktivzeilen,
- **100 %** auf den kritischen Pfaden oben.

Nicht instrumentierte Zeilen (Kommentare, Typen) zählen nicht mit. Eine
geänderte Datei ohne LCOV-Eintrag gilt als vollständig ungetestet.

```bash
# LCOV im Container erzeugen, Diff auf dem Host bilden (kein git im Container)
docker exec smartpilot-gateway-gateway-1 npm run coverage:lcov
# Neue Dateien vorher mit `git add -N gateway/src` vormerken, sonst fehlen sie im Diff.
git diff -U0 "$(git merge-base origin/main HEAD)" -- gateway/src \
  | docker exec -i smartpilot-gateway-gateway-1 npm run coverage:diff
```

`coverage:diff` akzeptiert zusätzlich `--threshold <n>`, `--critical a,b` und
`--diff <datei>` statt stdin.

## Globale Schwellen

| Kennzahl | Schwelle |
|---|---|
| Lines | 95 % |
| Branches | 83 % |
| Functions | 93 % |

Gemessener Stand (Node 26.13.0, `src/**`, 622 Cases): 97,10 / 85,03 / 94,73.

**Neubaseline 2026-11-08:** Die Lines-Schwelle sinkt von 97 auf 95 %, die
Functions-Schwelle von 94 auf 93 %. Grund: Die 97-%-Hürde erzwang Tests für
reine Verdrahtung und ließ die Suite auf 9.530 Zeilen anwachsen (mehr als
`src/`), ohne zusätzliche Verhaltenssicherung. Qualitätsmaßstab ist jetzt die
Diff-Coverage. **Wiederaufnahme-Trigger:** Sinkt der gemessene Stand unter
95/83/93 oder bleibt eine Änderung ohne Diff-Coverage-Nachweis, wird die
Schwelle wieder angehoben. Die Branch-Ausnahme (83 %) bleibt bis zur
Neubewertung der Branch-Tests bestehen und ist im Ausnahmen-Register des
Workspace dokumentiert (nicht Teil des Repos).

## Bekannte Grenzen

- **Audit-Gate-Timeout (`scripts/audit-gate.mjs`):** Der ETIMEDOUT-Zweig
  lässt sich nicht ohne echten Hänger testen; geprüft ist er nur per
  Codewalk.
- **`ADMIN_RATE_MAX`-Tests:** Sie setzen die Variable vor dem Modul-Import.
  Das ist nur unter Prozessisolation sicher (eigene Testdatei, kein
  Parallel-Import derselben Config).
- **SIGTERM-Test (`test/graceful-shutdown.test.ts`):** Der Server bindet
  einen freien Port; zwischen Portwahl und `listen` bleibt ein kleines
  Rennen. Der Test wiederholt den Lauf deshalb bis zu dreimal, wenn der Port
  belegt war.
- **Reproduzierbarkeit:** CI und Image nutzen dieselbe Node-Version
  (`26.13.0`, gepinnt in `gateway-ci.yml`/`registry-ci.yml` und per Digest im
  Dockerfile). Abdeckungszahlen sind nur zwischen gleichen Node-Versionen
  vergleichbar (V8 zählt Branches je Version etwas anders).