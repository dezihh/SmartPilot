/**
 * Schalter fuer Test-Hooks. Das Laufzeit-Image setzt `NODE_ENV=production`
 * (gateway/Dockerfile), damit die `*ForTests`-Exporte im ausgelieferten
 * Prozess wirkungslos bleiben (Audit F-006). Ausserhalb von Tests ist das
 * Flag ebenfalls false - die Hooks sind dann reine No-ops.
 */
export const TEST_HOOKS_ENABLED = process.env.NODE_ENV !== 'production';
