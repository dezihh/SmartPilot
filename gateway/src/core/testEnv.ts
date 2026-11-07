/**
 * Schalter fuer Test-Hooks. Das Laufzeit-Image setzt `NODE_ENV=production`
 * (gateway/Dockerfile); nur dann sind die `*ForTests`-Exporte wirkungslos
 * (Audit F-006). In allen anderen Umgebungen - Dev-Container, lokale Tests,
 * CI - sind die Hooks aktiv. Die Hooks sind reine Prozess-intern-Funktionen
 * ohne HTTP-Pfad; `production` ist die einzige Sperre.
 */
export const TEST_HOOKS_ENABLED = process.env.NODE_ENV !== 'production';
