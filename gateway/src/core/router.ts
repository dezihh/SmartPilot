import type { ParsedAction } from '../types.js';

export interface RouteMatch {
  action: ParsedAction;
  score: number;
  phrase: string;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'´`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Erkennt Anfragen mit mehreren Themen/Verknuepfungen, die deterministische
// Einzel-Actions nicht bedienen koennen (z.B. "Temperatur und Licht").
function isCombinedQuery(text: string): boolean {
  const q = normalize(text);
  if (q.includes(' und ') || q.includes(' sowie ') || q.includes(' ausserdem ') || q.includes(' außerdem ')) {
    return true;
  }
  const fragments = q.split(' ').filter((w) => w === 'und' || w === 'sowie' || w === '&').length;
  if (fragments > 1) return true;
  // Kommas im ROHTEXT zaehlen: normalize() entfernt Kommas bereits, bevor
  // dieser Check laeuft (z.B. "wetter, temperatur").
  const commaParts = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return commaParts.length >= 2;
}

function bigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 1; i++) out.add(padded.slice(i, i + 2));
  return out;
}

export function similarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size);
}

export function routeAction(
  text: string,
  actions: ParsedAction[],
  fuzzyGlobal: boolean
): RouteMatch | null {
  const query = normalize(text);
  // Kombinierte Anfrage (mehrere Themen)? Deterministische Actions koennen nur EIN
  // Template bedienen -> Kombinationen an den Agent (der nutzt das Tool-Inventory).
  const combined = isCombinedQuery(text);
  let best: RouteMatch | null = null;
  for (const action of actions) {
    // Schwellwert haerten: negative/ungueltige Werte wuerden sonst jede Anfrage
    // treffen (score 0 >= threshold). Nur (0,1] zulassen, sonst Default.
    const rawThreshold = action.fuzzy_threshold ?? 0.85;
    const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? Math.min(1, rawThreshold) : 0.85;
    for (const phrase of action.triggers) {
      const target = normalize(phrase);
      if (!target) continue;
      let score = 0;
      if (query === target) score = 1;
      else if (query.includes(target)) score = Math.max(0.95, threshold);
      else if (fuzzyGlobal) score = similarity(query, target);
      if (score >= threshold && (!best || score > best.score)) {
        if (combined && action.mode === 'deterministic') continue;
        best = { action, score, phrase };
      }
    }
  }
  return best;
}
