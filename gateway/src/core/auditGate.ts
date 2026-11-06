// Audit-Gate fuer Produktions-Abhaengigkeiten: bewertet den Bericht von
// `npm audit --omit=dev --json` gegen eine ausdrueckliche Allowlist.
//
// Grundsatz: High/Critical blockieren immer. Sie werden entweder behoben, oder
// die Ausnahme steht mit Begruendung, Doku-Verweis, Wiederaufnahme-Trigger und
// Ablaufdatum in der Allowlist. Eine stille Absenkung der Schwelle
// (`--audit-level`) gibt es nicht - sie wuerde den Befund verstecken.

export interface AuditAdvisory {
  /** GHSA-Id, sonst numerische Advisory-Id, sonst der Paketname. */
  id: string;
  package: string;
  severity: string;
  title: string;
  url: string;
}

export interface AuditException {
  id: string;
  package: string;
  reason: string;
  doc: string;
  trigger: string;
  expires: string;
}

export interface AuditGateResult {
  /** Gesetzt, wenn der Audit-Bericht nicht lesbar war (Bewertung dann GRAU). */
  invalidReport: string | null;
  blocking: AuditAdvisory[];
  accepted: { advisory: AuditAdvisory; exception: AuditException }[];
  /** Allowlist-Fehler: ungueltig, abgelaufen oder verwaist. */
  errors: string[];
}

const BLOCKING = new Set(['high', 'critical']);
const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Kuerzere Begruendungen sind keine Begruendung. */
const MIN_REASON_LENGTH = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function ghsaFrom(url: string): string | null {
  const m = GHSA.exec(url);
  return m ? m[0].toUpperCase() : null;
}

function advisoryFrom(pkg: string, pkgSeverity: string, via: unknown): AuditAdvisory {
  if (typeof via === 'string') {
    // Transitive Kette: npm liefert hier nur den Namen der Abhaengigkeit.
    return {
      id: via,
      package: pkg,
      severity: pkgSeverity,
      title: `${pkg} ist abhaengig von ${via}`,
      url: '',
    };
  }
  if (!isRecord(via)) {
    return { id: pkg, package: pkg, severity: pkgSeverity, title: '', url: '' };
  }
  const url = text(via.url);
  const source = via.source === undefined || via.source === null ? '' : String(via.source);
  return {
    id: ghsaFrom(url) ?? (source || pkg),
    package: pkg,
    severity: text(via.severity) || pkgSeverity,
    title: text(via.title),
    url,
  };
}

function parseAdvisories(report: unknown): AuditAdvisory[] | null {
  if (!isRecord(report) || !isRecord(report.vulnerabilities)) return null;
  const out: AuditAdvisory[] = [];
  const seen = new Set<string>();
  for (const [pkg, raw] of Object.entries(report.vulnerabilities)) {
    if (!isRecord(raw)) continue;
    const pkgSeverity = text(raw.severity);
    if (!BLOCKING.has(pkgSeverity)) continue;
    const via = Array.isArray(raw.via) ? raw.via : [];
    const items: unknown[] = via.length > 0 ? via : [null];
    for (const item of items) {
      const advisory = advisoryFrom(pkg, pkgSeverity, item);
      const key = `${advisory.package}|${advisory.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(advisory);
    }
  }
  return out;
}

function readException(entry: unknown, index: number, errors: string[]): AuditException | null {
  const where = `Allowlist-Eintrag ${index + 1}`;
  if (!isRecord(entry)) {
    errors.push(`${where}: kein Objekt`);
    return null;
  }
  const fields = ['id', 'package', 'reason', 'doc', 'trigger', 'expires'] as const;
  for (const f of fields) {
    if (text(entry[f]).trim() === '') {
      errors.push(`${where}: Feld "${f}" fehlt`);
      return null;
    }
  }
  const exception: AuditException = {
    id: text(entry.id).trim(),
    package: text(entry.package).trim(),
    reason: text(entry.reason).trim(),
    doc: text(entry.doc).trim(),
    trigger: text(entry.trigger).trim(),
    expires: text(entry.expires).trim(),
  };
  if (exception.reason.length < MIN_REASON_LENGTH) {
    errors.push(`${where} (${exception.id}): Begruendung zu kurz (min. ${MIN_REASON_LENGTH} Zeichen)`);
    return null;
  }
  if (!DATE.test(exception.expires) || Number.isNaN(Date.parse(exception.expires))) {
    errors.push(`${where} (${exception.id}): expires muss Datum JJJJ-MM-TT sein`);
    return null;
  }
  return exception;
}

/**
 * Bewertet einen Audit-Bericht gegen die Allowlist. `today` ist ein Datum
 * (JJJJ-MM-TT) und wird injiziert, damit die Bewertung deterministisch bleibt.
 */
export function evaluateAudit(report: unknown, allowlist: unknown, today: string): AuditGateResult {
  const errors: string[] = [];
  const advisories = parseAdvisories(report);
  if (advisories === null) {
    return {
      invalidReport: 'Audit-Bericht nicht lesbar (erwartet wird JSON mit "vulnerabilities")',
      blocking: [],
      accepted: [],
      errors,
    };
  }
  if (!Array.isArray(allowlist)) {
    errors.push('Allowlist ist kein Array');
    return { invalidReport: null, blocking: advisories, accepted: [], errors };
  }

  const exceptions: AuditException[] = [];
  const ids = new Set<string>();
  allowlist.forEach((entry, i) => {
    const exception = readException(entry, i, errors);
    if (!exception) return;
    const key = `${exception.package}|${exception.id}`;
    if (ids.has(key)) {
      errors.push(`Allowlist: doppelter Eintrag ${exception.id} (${exception.package})`);
      return;
    }
    ids.add(key);
    exceptions.push(exception);
  });

  const blocking: AuditAdvisory[] = [];
  const accepted: AuditGateResult['accepted'] = [];
  const used = new Set<string>();
  for (const advisory of advisories) {
    const exception = exceptions.find(
      (e) => e.package === advisory.package && e.id === advisory.id,
    );
    if (!exception) {
      blocking.push(advisory);
      continue;
    }
    used.add(`${exception.package}|${exception.id}`);
    if (exception.expires < today) {
      errors.push(
        `Ausnahme ${exception.id} (${exception.package}) ist am ${exception.expires} abgelaufen`,
      );
      blocking.push(advisory);
      continue;
    }
    accepted.push({ advisory, exception });
  }

  for (const exception of exceptions) {
    if (!used.has(`${exception.package}|${exception.id}`)) {
      errors.push(
        `Ausnahme ${exception.id} (${exception.package}) ist verwaist: ` +
          'keine passende High-/Critical-Advisory gefunden - Eintrag entfernen',
      );
    }
  }

  return { invalidReport: null, blocking, accepted, errors };
}
