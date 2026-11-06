const buckets = new Map<string, number[]>();
const MAX_KEYS = 1000;

/**
 * In-Memory-Rate-Limiter (gleitendes Fenster, pro Schluessel z. B. Client-IP).
 * `now` ist injizierbar, damit Tests deterministisch sind.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
  windowMs = 60_000,
  max = 10
): boolean {
  if (buckets.size > MAX_KEYS) {
    for (const [k, list] of buckets) {
      const fresh = list.filter((t) => now - t < windowMs);
      if (fresh.length === 0) buckets.delete(k);
      else buckets.set(k, fresh);
    }
  }
  const list = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    buckets.set(key, list);
    return false;
  }
  list.push(now);
  buckets.set(key, list);
  return true;
}

export function resetRateLimitsForTests(): void {
  buckets.clear();
}
