// HTTP-Antwort-Cache (TTL-basiert, pro URL im Prozess). Nur aktiv, wenn der
// Call eine TTL > 0 mitgibt (http('url', ttlMs)). Mit periodischem Prune
// (statt ungegrenztem Wachstum) und testbarer Injektion der Zeit.
import { TEST_HOOKS_ENABLED } from './testEnv.js';

const MAX_ENTRIES = 200;
interface CacheEntry {
  ts: number;
  ttl: number;
  data: unknown;
}

const cache = new Map<string, CacheEntry>();
let pruneCounter = 0;

export function resetHttpCacheForTests(): void {
  if (!TEST_HOOKS_ENABLED) return;
  cache.clear();
  pruneCounter = 0;
}

export function httpCacheSize(): number {
  return cache.size;
}

function prune(now: number): void {
  for (const [url, e] of cache) {
    if (now - e.ts >= e.ttl) cache.delete(url);
  }
  while (cache.size > MAX_ENTRIES) {
    // Aelteste zuerst (kleinster ts).
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [url, e] of cache) {
      if (e.ts < oldestTs) {
        oldestTs = e.ts;
        oldest = url;
      }
    }
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function httpCacheGet(url: string, now = Date.now()): unknown | null {
  const hit = cache.get(url);
  if (hit && now - hit.ts < hit.ttl) return hit.data;
  if (hit) cache.delete(url);
  return null;
}

export function httpCacheSet(url: string, data: unknown, ttl: number, now = Date.now()): void {
  cache.set(url, { ts: now, ttl, data });
  // Prune alle 32 Sets (billig amortisiert statt Timer).
  if ((++pruneCounter & 31) === 0) prune(now);
}
