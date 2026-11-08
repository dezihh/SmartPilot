// Diff-Coverage: bewertet nur die in einem Diff geaenderten Produktivzeilen.
//
// Die globale Quote ist eine Regressionsbremse, kein Testziel (NFR 6).
// Massgeblich ist, ob die geaenderten Zeilen getestet sind; kritische Pfade
// muessen vollstaendig abgedeckt sein.

export const DEFAULT_CRITICAL = [
  'src/auth.ts',
  'src/apiSignature.ts',
  'src/rateLimit.ts',
  'src/config.ts',
  'src/core/engine.ts',
  'src/core/tools.ts',
  'src/core/normalize.ts',
  'src/core/ssrf.ts',
  'src/core/session.ts',
  'src/db.ts',
  'src/db/',
];

export type LineRange = readonly [start: number, end: number];

export interface FileCoverage {
  file: string;
  covered: number;
  total: number;
  pct: number;
  required: number;
  ok: boolean;
}

export interface DiffCoverageResult {
  files: FileCoverage[];
  covered: number;
  total: number;
  pct: number;
  threshold: number;
  failures: string[];
  ok: boolean;
}

export interface DiffCoverageOptions {
  threshold?: number;
  critical?: readonly string[];
}

// Schneidet alles vor "src/" ab, damit Diff-Pfade (b/gateway/src/x.ts) und
// LCOV-Pfade (src/x.ts) vergleichbar sind.
export function normalizeSourcePath(file: string): string | null {
  const normalized = file.trim().replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(src\/.+)$/);
  return match?.[1] ?? null;
}

// Liefert je geaenderter Quelldatei die Bereiche neu hinzugefuegter Zeilen.
export function parseUnifiedDiff(diff: string): Map<string, LineRange[]> {
  const files = new Map<string, LineRange[]>();
  let current: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).split('\t')[0]?.trim() ?? '';
      current = raw === '/dev/null' ? null : normalizeSourcePath(raw);
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    if (!current) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) files.get(current)?.push([start, start + count - 1]);
  }
  return files;
}

// Liefert je Quelldatei die ausgefuehrten Zeilen (Zeile -> Trefferzahl).
export function parseLcov(text: string): Map<string, Map<number, number>> {
  const coverage = new Map<string, Map<number, number>>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = normalizeSourcePath(line.slice(3));
      if (current && !coverage.has(current)) coverage.set(current, new Map());
      continue;
    }
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (!current || !line.startsWith('DA:')) continue;
    const [lineNo, hits] = line.slice(3).split(',');
    const number = Number(lineNo);
    const count = Number(hits);
    if (Number.isInteger(number) && Number.isFinite(count)) {
      coverage.get(current)?.set(number, count);
    }
  }
  return coverage;
}

export function isCriticalFile(
  file: string,
  critical: readonly string[] = DEFAULT_CRITICAL,
): boolean {
  return critical.some((pattern) => file === pattern || file.startsWith(pattern));
}

// Nicht instrumentierte Zeilen (Kommentare, Typen) zaehlen nicht mit. Eine
// Datei ohne LCOV-Eintrag gilt dagegen als vollstaendig ungetestet.
export function computeDiffCoverage(
  changedFiles: ReadonlyMap<string, readonly LineRange[]>,
  coverage: ReadonlyMap<string, ReadonlyMap<number, number>>,
  options: DiffCoverageOptions = {},
): DiffCoverageResult {
  const threshold = options.threshold ?? 90;
  const critical = options.critical ?? DEFAULT_CRITICAL;
  const files: FileCoverage[] = [];

  for (const [file, ranges] of changedFiles) {
    const changedLines = new Set<number>();
    for (const [start, end] of ranges) {
      for (let line = start; line <= end; line += 1) changedLines.add(line);
    }
    if (changedLines.size === 0) continue;

    const hits = coverage.get(file);
    let covered = 0;
    let total = 0;
    for (const line of changedLines) {
      if (hits && !hits.has(line)) continue;
      total += 1;
      if (hits && hits.get(line)! > 0) covered += 1;
    }
    if (total === 0) continue;

    const pct = (covered / total) * 100;
    const required = isCriticalFile(file, critical) ? 100 : threshold;
    files.push({ file, covered, total, pct, required, ok: pct + 1e-9 >= required });
  }

  const covered = files.reduce((sum, file) => sum + file.covered, 0);
  const total = files.reduce((sum, file) => sum + file.total, 0);
  const pct = total === 0 ? 100 : (covered / total) * 100;
  const failures = files.filter((file) => !file.ok).map((file) => file.file);

  return {
    files,
    covered,
    total,
    pct,
    threshold,
    failures,
    ok: failures.length === 0 && pct + 1e-9 >= threshold,
  };
}
