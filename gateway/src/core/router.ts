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

// Ganz-Wort-/Ganz-Phrasen-Treffer: verhindert, dass ein kurzer Trigger
// ("haus") mitten in einem laengeren Wort ("hausstatus") matcht.
function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

// Verneinungen: eine negierte Anfrage darf keinen Vorgang mit Seiteneffekt
// ausloesen (z. B. "schalte das Licht nicht ein").
const NEGATIONS = ['nicht', 'kein', 'keine', 'keinen', 'keiner', 'keinem', 'ohne'];

function hasNegation(query: string): boolean {
  const padded = ` ${query} `;
  return NEGATIONS.some((n) => padded.includes(` ${n} `));
}

// Grobe Seiteneffekt-Heuristik (der Router ist rein/DB-frei): Vorlagen mit
// mcp.call()/shell(), Funktionen (Default side_effect 'write') und LLM-/Hybrid-
// Actions mit Tools koennen den Zustand veraendern.
function actionHasSideEffect(action: ParsedAction): boolean {
  if (/\bmcp\.call\s*\(|\bshell\s*\(/.test(action.template ?? '')) return true;
  if (action.function_ref) return true;
  return action.mode !== 'deterministic' && action.toolList.length > 0;
}

export function routeAction(
  text: string,
  actions: ParsedAction[],
  fuzzyGlobal: boolean
): RouteMatch | null {
  const query = normalize(text);
  // Kombinierte Anfrage (mehrere Themen)? Keine Action kann die Kombination
  // zuverlaessig bedienen (auch nicht hybrid/llm) -> komplett an den Agent,
  // der das Tool-Inventory nutzt.
  if (isCombinedQuery(text)) return null;
  const negated = hasNegation(query);
  let best: RouteMatch | null = null;
  let bestLen = 0;
  for (const action of actions) {
    // Schwellwert haerten: negative/ungueltige Werte wuerden sonst jede Anfrage
    // treffen (score 0 >= threshold). Nur (0,1] zulassen, sonst Default.
    const rawThreshold = action.fuzzy_threshold ?? 0.85;
    const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? Math.min(1, rawThreshold) : 0.85;
    if (negated && actionHasSideEffect(action)) continue;
    for (const phrase of action.triggers) {
      const target = normalize(phrase);
      if (!target) continue;
      let score = 0;
      if (query === target) score = 1;
      else if (containsPhrase(query, target)) score = Math.max(0.95, threshold);
      else if (fuzzyGlobal) score = similarity(query, target);
      // Bei Gleichstand gewinnt die laengere (spezifischere) Phrase.
      const better = !best || score > best.score || (score === best.score && target.length > bestLen);
      if (score >= threshold && better) {
        best = { action, score, phrase };
        bestLen = target.length;
      }
    }
  }
  return best;
}
