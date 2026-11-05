// Installationspakete: Manifest-Typen, Validierung, Platzhalter-Substitution
// und "gefaehrliche Aktion"-Erkennung. Pakete leben im Repo (packages/<id>/)
// bzw. kommen per Offline-Import; installiert werden sie nur mit Vorschau +
// Bestaetigung. Konvention: nur generische Inhalte (keine Infra-Spezifika).
import { createHash } from 'node:crypto';
import type { SideEffect } from '../types.js';
import { isPrivateHost } from './ssrf.js';

export interface PackageParam {
  key: string;
  label: string;
  placeholder?: string;
  default?: string;
  /** Token/Key - landet nur in der Zielzeile (auth_token/env), nie geloggt */
  secret?: boolean;
  required?: boolean;
  /** Kurzer Hilfetext fuer die Konfigurationsansicht. */
  help?: string;
  /** Eingabetyp der Konfigurationsansicht (Default: text). */
  type?: 'text' | 'password' | 'number';
}

export interface PackageServer {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  auth_token?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** npm-Paket, das der Provisioner fuer den stdio-Server bereitstellt. */
  npmSpec?: string;
  /** Zusaetzliche HTTP-Header (nur transport http), Werte per ${key} ersetzbar. */
  headers?: Record<string, string>;
  inventory_prompt?: string;
  sideEffect?: SideEffect;
  enabled?: boolean;
}

export interface PackageFunction {
  name: string;
  description?: string;
  template: string;
  parameters?: string | Record<string, unknown>;
  budget?: number;
  inventory_prompt?: string;
  sideEffect?: SideEffect;
}

export interface PackageIndex {
  key: string; // '' = Standard-Index (entity_index)
  config: Record<string, unknown>;
}

export interface PackageAction {
  name: string;
  mode: 'deterministic' | 'llm' | 'hybrid';
  trigger_phrases?: string[];
  fuzzy_threshold?: number;
  system_prompt?: string;
  template?: string;
  function_ref?: string;
  function_args?: string | Record<string, unknown>;
  tools?: string[];
  enabled?: boolean;
}

export interface PackageManifest {
  id: string;
  version: string;
  name: string;
  summary: string;
  description: string;
  /** Herkunft/Autor des Pakets (Community-Vertrauensmodell). */
  author?: string;
  /** Lizenz-Kennung, z. B. "MIT". */
  license?: string;
  /** Sprache des Pakets (BCP-47-Kuerzel, z. B. "de"). Default: de. */
  language?: string;
  /** Projekt-/Doku-Link. */
  homepage?: string;
  /** Darstellungs-Kategorie: Treiber, Funktion oder Kombination. */
  category?: 'driver' | 'function' | 'mixed';
  requires?: string;
  /** Getestete Gateway-Mindestversion (semver); Installation wird sonst abgelehnt. */
  minGatewayVersion?: string;
  params?: PackageParam[];
  servers?: PackageServer[];
  functions?: PackageFunction[];
  indexes?: PackageIndex[];
  actions?: PackageAction[];
  allowTools?: string[];
  setupDocs?: string;
  changelog?: string;
}

// Zahl-fuer-Zahl-Vergleich zweier "x.y.z"-Versionen: <0, 0, >0.
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function meetsMinVersion(current: string, min: string | undefined): boolean {
  if (!min) return true;
  return compareSemver(current, min) >= 0;
}

// "gefaehrliche Aktion": Templates, die shell() mitbringen (Befehle im
// Gateway-Container). http() gilt als Info (externe Aufrufe), ohne
// Bestaetigungspflicht.
export function manifestDangerous(m: PackageManifest): { dangerous: boolean; items: string[]; info: string[] } {
  const items: string[] = [];
  const info: string[] = [];
  // Literale http()-URLs sind nicht SSRF-geprueft (dynamische schon). Weisen
  // wir interne Ziele sichtbar aus, damit die Bestaetigung nicht blind ist.
  const privateHosts = (template: string): string[] => {
    const re = /\bhttp\(\s*['"]([^'"]+)['"]/g;
    const hosts: string[] = [];
    for (let hit = re.exec(template); hit; hit = re.exec(template)) {
      try {
        const h = new URL(hit[1]!).hostname;
        if (isPrivateHost(h)) hosts.push(h);
      } catch {
        // keine absolute URL - ignorieren
      }
    }
    return [...new Set(hosts)];
  };
  // stdio-Server starten einen beliebigen Prozess im Gateway-Container
  // (command/args) - immer als gefaehrlich einstufen, unabhaengig vom command.
  for (const s of m.servers ?? []) {
    if (s.transport === 'stdio') {
      items.push(`Server "${s.name}" laeuft als stdio-Prozess (command "${s.command ?? ''}") - fuehrt Programme im Gateway-Container aus`);
    }
  }
  for (const f of m.functions ?? []) {
    if (/\bshell\s*\(/.test(f.template)) items.push(`Funktion "${f.name}" nutzt shell() - fuehrt Befehle im Gateway-Container aus`);
    if (/\bhttp\s*\(/.test(f.template)) {
      info.push(`Funktion "${f.name}" nutzt http() - ruft externe URLs auf`);
      const hosts = privateHosts(f.template);
      if (hosts.length) info.push(`Funktion "${f.name}" ruft interne Adresse ${hosts.join(', ')} auf (literale http()-URL)`);
    }
  }
  for (const a of m.actions ?? []) {
    if (a.template && /\bshell\s*\(/.test(a.template)) items.push(`Vorgang "${a.name}" nutzt shell() - fuehrt Befehle im Gateway-Container aus`);
    if (a.template && /\bhttp\s*\(/.test(a.template)) {
      info.push(`Vorgang "${a.name}" nutzt http() - ruft externe URLs auf`);
      const hosts = privateHosts(a.template);
      if (hosts.length) info.push(`Vorgang "${a.name}" ruft interne Adresse ${hosts.join(', ')} auf (literale http()-URL)`);
    }
  }
  return { dangerous: items.length > 0, items, info };
}

// Signatur der aufgeloesten, gefaehrlichen Bestandteile. Aendert sich der
// Inhalt (z. B. ein Parameter fliesst in ein shell()-Kommando), muss der
// Nutzer die Konfiguration neu bestaetigen - die blosse Anzahl der
// Gefahrenpunkte reicht als Vergleich nicht aus.
export function dangerSignature(m: PackageManifest): string {
  return JSON.stringify({
    servers: (m.servers ?? [])
      .filter((s) => s.transport === 'stdio')
      .map((s) => [s.name, s.command ?? null, s.args ?? null, s.env ?? null, s.npmSpec ?? null]),
    functions: (m.functions ?? [])
      .filter((f) => /\bshell\s*\(/.test(f.template))
      .map((f) => [f.name, f.template]),
    actions: (m.actions ?? [])
      .filter((a) => a.template && /\bshell\s*\(/.test(a.template))
      .map((a) => [a.name, a.template]),
  });
}

export function validateManifest(raw: unknown): { ok: true; manifest: PackageManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const m = raw as PackageManifest | null;
  if (!m || typeof m !== 'object') return { ok: false, errors: ['Manifest ist kein Objekt'] };
  if (!m.id || !/^[a-z0-9_-]{1,40}$/.test(m.id)) errors.push('id fehlt oder ungueltig');
  if (!m.version || !/^\d+\.\d+\.\d+$/.test(m.version)) errors.push('version fehlt oder kein semver');
  if (!m.name || typeof m.name !== 'string') errors.push('name fehlt');
  if (!m.summary || typeof m.summary !== 'string') errors.push('summary fehlt');
  if (m.language !== undefined && (typeof m.language !== 'string' || !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(m.language))) errors.push('language muss ein Sprachkuerzel wie "de" sein');
  if (m.author !== undefined && typeof m.author !== 'string') errors.push('author muss ein String sein');
  if (m.license !== undefined && typeof m.license !== 'string') errors.push('license muss ein String sein');
  if (m.minGatewayVersion !== undefined && (typeof m.minGatewayVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.minGatewayVersion))) errors.push('minGatewayVersion muss semver (x.y.z) sein');
  if (m.category !== undefined && m.category !== 'driver' && m.category !== 'function' && m.category !== 'mixed') errors.push('category muss driver, function oder mixed sein');
  if (m.servers !== undefined) {
    if (!Array.isArray(m.servers)) errors.push('servers muss ein Array sein');
    else {
      for (const s of m.servers) {
        if (!s?.name) errors.push('server ohne name');
        if (s?.transport !== 'http' && s?.transport !== 'stdio') errors.push(`server "${s?.name}": transport muss http oder stdio sein`);
        if (s?.transport === 'http' && !s.url) errors.push(`server "${s.name}": url erforderlich`);
        if (s?.transport === 'stdio' && !s.command) errors.push(`server "${s.name}": command erforderlich`);
        if (s?.npmSpec !== undefined && (typeof s.npmSpec !== 'string' || !s.npmSpec.trim())) errors.push(`server "${s.name}": npmSpec muss ein nicht-leerer String sein`);
        if (s?.headers !== undefined) {
          if (s.transport !== 'http') errors.push(`server "${s.name}": headers nur bei transport http`);
          else if (typeof s.headers !== 'object' || s.headers === null || Array.isArray(s.headers)) errors.push(`server "${s.name}": headers muss ein Objekt sein`);
          else if (Object.entries(s.headers).some(([k, v]) => !/^[A-Za-z0-9-]+$/.test(k) || typeof v !== 'string')) errors.push(`server "${s.name}": headers braucht gueltige Namen und String-Werte`);
        }
        if (s?.sideEffect !== undefined && s.sideEffect !== 'read' && s.sideEffect !== 'write') errors.push(`server "${s.name}": sideEffect muss read oder write sein`);
      }
    }
  }
  if (m.functions !== undefined) {
    if (!Array.isArray(m.functions)) errors.push('functions muss ein Array sein');
    else {
      for (const f of m.functions) {
        if (!f?.name || !/^[a-z0-9_]{1,60}$/.test(f.name)) errors.push(`function-Name ungueltig: ${f?.name ?? '(leer)'}`);
        if (f && typeof f.template !== 'string') errors.push(`function "${f.name}": template fehlt`);
        if (f?.sideEffect !== undefined && f.sideEffect !== 'read' && f.sideEffect !== 'write') errors.push(`function "${f.name}": sideEffect muss read oder write sein`);
      }
    }
  }
  if (m.indexes !== undefined) {
    if (!Array.isArray(m.indexes)) errors.push('indexes muss ein Array sein');
    else {
      for (const ix of m.indexes) {
        if (!ix || typeof ix.key !== 'string' || !/^[a-z0-9_]{0,30}$/.test(ix.key)) errors.push('index-key ungueltig');
        if (!ix?.config || typeof ix.config !== 'object' || typeof ix.config.tool !== 'string') errors.push('index-config braucht ein "tool"');
      }
    }
  }
  if (m.actions !== undefined) {
    if (!Array.isArray(m.actions)) errors.push('actions muss ein Array sein');
    else {
      for (const a of m.actions) {
        if (!a?.name || !/^[a-z0-9_-]{1,60}$/.test(a.name)) errors.push(`action-Name ungueltig: ${a?.name ?? '(leer)'}`);
        if (a && a.mode !== 'deterministic' && a.mode !== 'llm' && a.mode !== 'hybrid') errors.push(`action "${a.name}": mode muss deterministic, llm oder hybrid sein`);
        if (a?.trigger_phrases !== undefined && (!Array.isArray(a.trigger_phrases) || a.trigger_phrases.some((t) => typeof t !== 'string'))) errors.push(`action "${a?.name}": trigger_phrases muss ein String-Array sein`);
        if (a?.fuzzy_threshold !== undefined && (typeof a.fuzzy_threshold !== 'number' || a.fuzzy_threshold < 0 || a.fuzzy_threshold > 1)) errors.push(`action "${a?.name}": fuzzy_threshold muss zwischen 0 und 1 liegen`);
        if (a?.function_ref !== undefined && (typeof a.function_ref !== 'string' || !/^[a-z0-9_]{1,60}$/.test(a.function_ref))) errors.push(`action "${a?.name}": function_ref ungueltig`);
      }
    }
  }
  if (m.allowTools !== undefined) {
    if (!Array.isArray(m.allowTools) || m.allowTools.some((t) => !/^[a-z0-9_*]{1,60}$/.test(t))) {
      errors.push('allowTools muss ein Array aus Tool-Namen sein');
    }
  }
  if (m.params !== undefined) {
    if (!Array.isArray(m.params)) errors.push('params muss ein Array sein');
    else {
      for (const p of m.params) {
        if (!p || !/^[a-z0-9_]{1,40}$/.test(p.key ?? '')) errors.push('param-key ungueltig');
        if (!p?.label) errors.push(`param "${p?.key}": label fehlt`);
        if (p?.type !== undefined && p.type !== 'text' && p.type !== 'password' && p.type !== 'number') errors.push(`param "${p.key}": type muss text, password oder number sein`);
        if (p?.help !== undefined && typeof p.help !== 'string') errors.push(`param "${p.key}": help muss ein String sein`);
      }
    }
  }
  return errors.length === 0 ? { ok: true, manifest: m } : { ok: false, errors };
}

export function parseManifest(text: string): { ok: true; manifest: PackageManifest } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['Manifest ist kein gueltiges JSON'] };
  }
  return validateManifest(raw);
}

// {{param}} in String-Feldern ersetzen; unbekannte Platzhalter schlagen fehl.
export function substituteParams(text: string, params: Record<string, string>): string {
  return text.replace(/\$\{([a-z0-9_]+)\}/g, (full, key: string) => {
    const v = params[key];
    if (v == null) throw new Error(`Platzhalter ${key} hat keinen Wert`);
    return v;
  });
}

export function requiredParams(m: PackageManifest): string[] {
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const match of v.matchAll(/\$\{([a-z0-9_]+)\}/g)) keys.add(String(match[1]));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk({ servers: m.servers, functions: m.functions, indexes: m.indexes, actions: m.actions });
  return [...keys];
}

export function paramValues(m: PackageManifest, provided: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of m.params ?? []) {
    const v = provided[p.key] ?? p.default ?? '';
    if (p.required && !String(v).trim()) throw new Error(`Parameter "${p.label}" ist erforderlich`);
    out[p.key] = String(v);
  }
  return out;
}

export function substituteManifest(m: PackageManifest, values: Record<string, string>): PackageManifest {
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') return substituteParams(v, values);
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, sub(val)]));
    return v;
  };
  const copy = JSON.parse(JSON.stringify(m)) as PackageManifest;
  const replaced = sub({ servers: copy.servers, functions: copy.functions, indexes: copy.indexes, actions: copy.actions });
  return { ...m, ...(replaced as Record<string, unknown>), params: undefined } as PackageManifest;
}

export function manifestHash(m: PackageManifest): string {
  return createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 16);
}

// Alle Artefakte mit Kennzeichnung (fuer Vorschau + Provenienz).
export function manifestItems(m: PackageManifest): { kind: string; name: string }[] {
  const items: { kind: string; name: string }[] = [];
  for (const s of m.servers ?? []) items.push({ kind: 'server', name: s.name });
  for (const f of m.functions ?? []) items.push({ kind: 'function', name: f.name });
  for (const a of m.actions ?? []) items.push({ kind: 'action', name: a.name });
  for (const ix of m.indexes ?? []) items.push({ kind: 'index', name: ix.key || '(Standard)' });
  if (m.allowTools?.length) items.push({ kind: 'allowTools', name: m.allowTools.join(',') });
  return items;
}

// Kategorie ableiten, falls im Manifest nicht gesetzt: reine Treiber
// (nur Server), reine Funktionen (nur Funktionen/Vorgaenge) oder gemischt.
export function deriveCategory(m: PackageManifest): 'driver' | 'function' | 'mixed' {
  const hasServers = (m.servers?.length ?? 0) > 0;
  const hasFunctions = (m.functions?.length ?? 0) > 0 || (m.actions?.length ?? 0) > 0;
  if (hasServers && hasFunctions) return 'mixed';
  if (hasServers) return 'driver';
  return 'function';
}