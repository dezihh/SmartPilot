# Tests und Coverage

Die Gateway-Tests laufen mit dem Node-Test-Runner (`node --test`) über
`tsx`, ohne Browser und ohne echtes Netz.

```bash
npm test        # alle Tests in test/*.test.ts
npm run coverage  # dieselben Tests mit Abdeckungsmessung
```

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

## Schwellen

| Kennzahl | Schwelle |
|---|---|
| Lines | 97 % |
| Branches | 83 % |
| Functions | 94 % |

Gemessener Stand (Node 26.13.0, `src/**`): 97,00 / 84,84 / 94,63.

Lines liegt knapp über der Schwelle. Neue Tests sollen den Puffer vergrößern;
die Schwelle zu senken ist der falsche Weg (Audit F-001).

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
