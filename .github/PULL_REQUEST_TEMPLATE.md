## Was ändert sich?

<!-- Kurz: Verhalten, Grund, betroffene Bereiche. -->

## Bezug

<!-- Issue/PR verlinken, z. B. "Fixes #12". -->

## Checkliste

- [ ] Ein Thema pro Change; keine themenfremden Änderungen
- [ ] Neue Logik hat Tests im selben Change; Bugfix mit Regressionstest
- [ ] Gates im Container grün (Exit-Codes einzeln geprüft):

      ```bash
      npm run typecheck
      npm run typecheck:tests
      npm test
      npm run build
      npm run audit:gate
      ```

- [ ] Doku aktualisiert, wenn sich Verhalten oder Bedienung ändert
- [ ] Nennenswerte Änderung unter `[Unreleased]` in `CHANGELOG.md`
- [ ] Keine Secrets, Debug-Ausgaben oder lokalen Pfade im Diff
- [ ] Sicherheitsrelevante Änderungen: `SECURITY.md` beachtet

## Sicherheitshinweis

Bitte keine Sicherheitslücken in öffentlichen PRs beschreiben — Meldeweg siehe
[`SECURITY.md`](../SECURITY.md).
