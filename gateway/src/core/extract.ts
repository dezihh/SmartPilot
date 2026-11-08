// Template-Static-Extraktion: reine Regex-Analyse eines Jinja/nunjucks-Templates.
// Findet alle Datenabrufe, die zur Renderzeit vorgewaermt werden koennen
// (index.*, mcp.call, shell, fn, http). Keine Seiteneffekte - voll testbar.
export interface LiteralCalls {
  usesIndex: boolean;
  // index.state('id') bzw. index.state('id', 'indexKey')
  states: { id: string; key: string }[];
  // Alle in index.*-Aufrufen genutzten Index-Keys ('' = Default-Index)
  indexKeys: string[];
  // Index-Key faellt erst zur Renderzeit aus args (index.find(args.q, args.index))
  // => alle konfigurierten Keys vorwaermen
  indexAll: boolean;
  // fallback = optionales Ersatz-Tool (3. Arg: { fallback: 'tool' }), das nur
  // aufgerufen wird, wenn der Primaer-Aufruf leer bleibt oder fehlschlaegt.
  calls: { tool: string; args: string | null; fallback?: string }[];
  // mcp.call('tool', {…args.x…}) - Args-Expression wird im preheat evaluiert
  mcpCallDyn: { tool: string; expr: string; fallback?: string }[];
  // http('url') bzw. http('url', ttlMs) - ttl > 0 aktiviert den Antwort-Cache
  httpCalls: { url: string; ttl: number }[];
  // http(<nunjucks-Expression>) - URL wird aus args/now berechnet 
  httpDyn: { expr: string; ttl: number }[];
  // http.request(name, path, opts) - Argumente werden im preheat mit args/now
  // ausgewertet; der Aufruf selbst liest nur noch das Ergebnis.
  httpRequests: { expr: string }[];
  shells: string[];
  fns: string[];
  httpUrls: string[];
}

// Argumente eines Aufrufs auf Top-Level-Kommas splitten; Quotes und
// Klammern/Objektliterale bleiben zusammen.
export function splitTopLevelArgs(expr: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = expr.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

// Findet alle Aufrufe "name(...)" mit balancierten Klammern (Strings werden
// respektiert). Liefert den Inhalt zwischen den Klammern.
function extractCallArgs(template: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let idx = 0;
  while ((idx = template.indexOf(needle, idx)) !== -1) {
    const prev = idx === 0 ? '' : template[idx - 1]!;
    if (prev && /[\w.]/.test(prev)) {
      idx += needle.length;
      continue;
    }
    let depth = 1;
    let quote = '';
    let i = idx + needle.length;
    for (; i < template.length; i++) {
      const ch = template[i]!;
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    out.push(template.slice(idx + needle.length, i));
    idx = i + 1;
  }
  return out;
}

// Entfernt nur echte Kontroll-/Definitionsbloecke samt Inhalt: if/for-Zweige
// laufen evtl. nicht, macro-Bodies erst bei Aufruf, call-Bodies erst wenn der
// Aufgerufene caller() nutzt, raw/verbatim sind reiner Text ohne Auswertung.
// Seiteneffekt-behaftete Aufrufe (shell, mcp.call) in solchen Zweigen duerfen
// nicht vorgewaermt werden, weil der Zweig sonst auch bei nicht erfuellter
// Bedingung liefe . Bloecke, deren Inhalt beim Rendern ausgewertet wird
// (filter/autoescape/block/apply und Block-{% set %}), bleiben UNANGETASTET -
// sonst verlieren gerenderte shell-/mcp.call-Aufrufe ihr Ergebnis .
// Tags ausserhalb der Bloecke - etwa {% set x = http(...) %} - bleiben erhalten.
function stripControlBlocks(tpl: string): string {
  const openers = new Set(['if', 'for', 'macro', 'call', 'raw', 'verbatim']);
  const closers = new Set(['endif', 'endfor', 'endmacro', 'endcall', 'endraw', 'endverbatim']);
  const tagRe = /\{%-?\s*([\s\S]*?)\s*-?%\}/g;
  let out = '';
  let depth = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(tpl)) !== null) {
    const tag = (m[1] ?? '').trim();
    const head = tag.split(/\s+/)[0] ?? '';
    const isOpen = openers.has(head);
    const isEnd = closers.has(head);
    if (depth === 0) out += tpl.slice(last, tagRe.lastIndex);
    if (isOpen) depth++;
    else if (isEnd) depth = Math.max(0, depth - 1);
    last = tagRe.lastIndex;
  }
  if (depth === 0) out += tpl.slice(last);
  return out;
}

export function extractLiterals(rawTemplate: string): LiteralCalls {
  // nunjucks-Kommentare {# ... #} werden nie gerendert -> nicht vorwaermen
  // . Wortgrenzen in den Regexen verhindern Fehltreffer wie
  // xfn()/myshell()/myhttp() .
  const template = rawTemplate.replace(/\{#[\s\S]*?#\}/g, '');
  // Seiteneffekt-Aufrufe zusaetzlich ohne Kontrollbloecke auswerten .
  const sideEffectSrc = stripControlBlocks(template);
  // 2. String-Arg eines index.*-Aufrufs = Index-Key ('' = Default-Index).
  const indexKeys = new Set<string>();
  for (const m of template.matchAll(
    /(?<![\w.])index\.(?:state|get|find)\(\s*(?:"[^"]*"|'[^']*')(?:\s*,\s*["']([^"']+)["']\s*)?\)/g
  )) {
    indexKeys.add((m[1] as string | undefined) ?? '');
  }
  // Dynamische Args (z. B. index.find(args.query) in fn-Templates): sonst
  // bleibt usesIndex false und der Agent-Pfad rendert ohne vorgewaermten
  // Index ("Entity-Index nicht verfuegbar"). Key aus 2. Literal-Arg.
  for (const m of template.matchAll(
    /(?<![\w.])index\.(?:state|get|find)\(\s*args\.[a-zA-Z0-9_]+\s*(?:,\s*["']([^"']+)["'])?\s*\)/g
  )) {
    indexKeys.add((m[1] as string | undefined) ?? '');
  }
  const states: { id: string; key: string }[] = [];
  for (const m of template.matchAll(
    /(?<![\w.])index\.state\(\s*["']([^"']+)["']\s*(?:,\s*["']([^"']+)["']\s*)?\)/g
  )) {
    states.push({ id: m[1] as string, key: (m[2] as string | undefined) ?? '' });
    if ((m[2] as string | undefined) !== undefined) indexKeys.add(m[2] as string);
  }
  const usesIndex = indexKeys.size > 0;
  // Dynamischer Index-Key als 2. Arg (index.find(args.q, args.index)): der Key
  // steht erst zur Renderzeit fest -> alle konfigurierten Keys vorwaermen.
  const indexAll = /(?<![\w.])index\.(?:state|get|find)\([^()]*,\s*args\./.test(template);
  const calls: { tool: string; args: string | null }[] = [];
  const mcpCallDyn: { tool: string; expr: string }[] = [];
  const shells: string[] = [];
  const fns: string[] = [];
  const httpCalls: { url: string; ttl: number }[] = [];
  const httpDyn: { expr: string; ttl: number }[] = [];
  // mcp.call('tool') bzw. mcp.call('tool', {flaches JSON-Literal, eine Zeile});
  // Literal-Args mit args./now. sind NICHT literal (die laufen als dynamisch).
  // Optionales 3. Argument { fallback: 'ersatz_tool' } fuer eine Kaskade.
  for (const m of sideEffectSrc.matchAll(/(?<![\w.])mcp\.call\(\s*["']([^"']+)["']\s*(?:,\s*(\{(?![^{}]*\b(?:args|now)\.)[^\n]*?\}))?\s*(?:,\s*\{\s*fallback\s*:\s*["']([^"']+)["']\s*\})?\s*\)/g)) {
    const fb = m[3] as string | undefined;
    calls.push({ tool: m[1] as string, args: (m[2] as string | undefined) ?? null, ...(fb ? { fallback: fb } : {}) });
  }
  // dynamische mcp.call-Args: {…args.x…} (keine verschachtelten Objekte),
  // optional + { fallback: 'ersatz_tool' }.
  for (const m of sideEffectSrc.matchAll(/(?<![\w.])mcp\.call\(\s*["']([^"']+)["']\s*,\s*\{([^{}]*?(?:\bargs\.|\bnow\.)[^{}]*?)\}\s*(?:,\s*\{\s*fallback\s*:\s*["']([^"']+)["']\s*\})?\s*\)/g)) {
    const fb = m[3] as string | undefined;
    mcpCallDyn.push({ tool: m[1] as string, expr: `{${m[2] as string}}`, ...(fb ? { fallback: fb } : {}) });
  }
  for (const m of sideEffectSrc.matchAll(/(?<![\w.])shell\(\s*["']([^"']+)["']\s*\)/g)) shells.push(m[1] as string);
  for (const m of template.matchAll(/(?<![\w.])fn\(\s*["']([a-zA-Z0-9_]+)["']\s*\)/g)) fns.push(m[1] as string);
  // http(...): Inneres je Call extrahieren (eine Klammerebene toleriert),
  // danach reines Literal (optional mit TTL) -> httpCalls; alles andere
  // (Konkatenation mit args/now) -> dynamische Expression.
  for (const m of template.matchAll(/(?<![\w.])http\(\s*((?:[^()]|\([^()]*\))*?)\s*\)/g)) {
    const inner = (m[1] as string).trim();
    if (!inner) continue;
    const lm = /^["']([^"']*)["']\s*(?:,\s*(\d+)\s*)?$/.exec(inner);
    if (lm) {
      httpCalls.push({ url: lm[1] as string, ttl: lm[2] ? Number(lm[2]) : 0 });
      continue;
    }
    let body = inner;
    let ttl = 0;
    const tm = /,\s*(\d+)\s*$/.exec(inner);
    if (tm) {
      ttl = Number(tm[1]);
      body = inner.slice(0, tm.index).trim();
    }
    httpDyn.push({ expr: body, ttl });
  }
  const httpRequests: { expr: string }[] = [];
  for (const expr of extractCallArgs(sideEffectSrc, 'http.request')) httpRequests.push({ expr });
  const httpUrls = httpCalls.map((c) => c.url);
  return {
    usesIndex,
    states,
    indexKeys: [...indexKeys],
    indexAll,
    calls,
    mcpCallDyn,
    httpCalls,
    httpDyn,
    httpRequests,
    shells,
    fns,
    httpUrls,
  };
}
