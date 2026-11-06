// Kleine Helfer fuer die Express-Routen: einheitliche Fehlermeldungen und
// Validierung numerischer IDs (Number('abc') waere NaN und wuerde still
// "nicht gefunden" liefern).

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Positive Ganzzahl aus einem Routen-Parameter; null bei Unsinn. */
export function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
