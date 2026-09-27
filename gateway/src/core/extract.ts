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
  calls: { tool: string; args: string | null }[];
  // mcp.call('tool', {…args.x…}) - Args-Expression wird im preheat evaluiert
  mcpCallDyn: { tool: string; expr: string }[];
  // http('url') bzw. http('url', ttlMs) - ttl > 0 aktiviert den Antwort-Cache
  httpCalls: { url: string; ttl: number }[];
  // http(<nunjucks-Expression>) - URL wird aus args/now berechnet (Finding #1)
  httpDyn: { expr: string; ttl: number }[];
  shells: string[];
  fns: string[];
  httpUrls: string[];
}

export function extractLiterals(rawTemplate: string): LiteralCalls {
  // nunjucks-Kommentare {# ... #} werden nie gerendert -> nicht vorwaermen
  // (F-01). Wortgrenzen in den Regexen verhindern Fehltreffer wie
  // xfn()/myshell()/myhttp() (F-02).
  const template = rawTemplate.replace(/\{#[\s\S]*?#\}/g, '');
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
  for (const m of template.matchAll(/(?<![\w.])mcp\.call\(\s*["']([^"']+)["']\s*(?:,\s*(\{(?![^{}]*\b(?:args|now)\.)[^\n]*?\}))?\s*\)/g)) {
    calls.push({ tool: m[1] as string, args: (m[2] as string | undefined) ?? null });
  }
  // dynamische mcp.call-Args: {…args.x…} (keine verschachtelten Objekte)
  for (const m of template.matchAll(/(?<![\w.])mcp\.call\(\s*["']([^"']+)["']\s*,\s*\{([^{}]*?(?:\bargs\.|\bnow\.)[^{}]*?)\}\s*\)/g)) {
    mcpCallDyn.push({ tool: m[1] as string, expr: `{${m[2] as string}}` });
  }
  for (const m of template.matchAll(/(?<![\w.])shell\(\s*["']([^"']+)["']\s*\)/g)) shells.push(m[1] as string);
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
  const httpUrls = httpCalls.map((c) => c.url);
  return { usesIndex, states, indexKeys: [...indexKeys], indexAll, calls, mcpCallDyn, httpCalls, httpDyn, shells, fns, httpUrls };
}
