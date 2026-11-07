# Tests und Coverage

Die Gateway-Tests laufen mit dem Node-Test-Runner (`node --test`) über
`tsx`, ohne Browser und ohne echtes Netz.

```bash
npm test        # alle Tests in test/*.test.ts
npm run coverage  # dieselben Tests mit Abdeckungsmessung
```

## Messbasis

`npm run coverage` schließt das Frontend aus:

```bash
--test-coverage-exclude='web/**'
```

**Grund:** `web/js/lib.js` und `web/js/packages.js` sind Browser-Skripte. Die
Node-Tests laden sie nur über einen DOM-Stub, um reine Helfer wie `esc`,
`cmpVersion` und `diffValue` zu prüfen; DOM- und Event-Pfade sind ohne Browser
nicht erreichbar. Ohne Ausschluss ziehen diese Dateien die Quote auf
92,91 / 81,24 / 90,39 (Lines / Branches / Functions) und das Gate würde nur
noch zufällig bestehen.

Die Web-Tests bleiben trotzdem im Lauf: sie sichern die Helfer ab, zählen aber
nicht in die Quote.

## Schwellen

| Kennzahl | Schwelle |
|---|---|
| Lines | 97 % |
| Branches | 83 % |
| Functions | 94 % |

Gemessener Stand (CI und lokal, Node 26.13.0): 97,70 / 83,94–84,13 / 94,39.

Die Branch-Schwelle liegt bewusst **unter** der Messspanne: CI-Läufe auf
unverändertem Code streuten zwischen 83,94 und 84,13 Prozent, eine Schwelle
von 84 ließ das Gate zufällig fehlschlagen. Das ist eine dokumentierte
Ausnahme von der Regel „Schwellen nur verbessern“ — sie wird nachgezogen,
sobald zusätzliche Tests den Puffer herstellen (Ziel ≥ 85). Lines und
Functions bleiben bei 97/94; dort reicht der Abstand.

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
