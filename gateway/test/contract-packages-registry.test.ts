// Vertragstest fuer die ausgelieferten Pakete (packages/<lang>/<id>/).
//
// Die Manifeste sind Produktionsdaten: die Registry wird von `main` geladen und
// installiert MCP-Server, Templates und Allowlisten. `registry-ci.yml` prueft
// nur, ob index.json zu den Manifesten passt - Schema, Platzhalter, Versionen
// und die Sicherheitswirkung prueft niemand. Das macht dieser Test.
//
// PACKAGES_DIR zeigt auf das Paketverzeichnis (Default: ../packages, im
// Dev-Container per Compose auf /packages gemountet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  deriveCategory,
  manifestDangerous,
  meetsMinVersion,
  sha256Hex,
  validateManifest,
  type PackageManifest,
} from '../src/core/packages.js';
import { GATEWAY_VERSION } from '../src/version.js';

const ROOT = resolve(process.env.PACKAGES_DIR ?? '../packages');
// Lokal darf ohne Paketverzeichnis uebersprungen werden; in CI ist ein
// fehlendes Verzeichnis ein Fehler, kein stiller Skip.
const MISSING = existsSync(ROOT) ? false : `Paketverzeichnis ${ROOT} fehlt (PACKAGES_DIR setzen)`;
const SKIP = MISSING === false || process.env.CI ? false : MISSING;

interface RegistryEntry {
  id: string;
  name: string;
  summary: string;
  version: string;
  category?: string;
  sha256?: string;
}

interface Shipped {
  lang: string;
  id: string;
  file: string;
  manifest: PackageManifest;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function dirsIn(path: string): string[] {
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function languages(): string[] {
  if (!existsSync(ROOT)) return [];
  return dirsIn(ROOT).filter((lang) => existsSync(join(ROOT, lang, 'index.json')));
}

function shipped(): Shipped[] {
  const out: Shipped[] = [];
  for (const lang of languages()) {
    for (const id of dirsIn(join(ROOT, lang))) {
      const file = join(ROOT, lang, id, 'manifest.json');
      if (!existsSync(file)) continue;
      const parsed = validateManifest(readJson(file));
      assert.equal(
        parsed.ok,
        true,
        `${lang}/${id}: ${parsed.ok ? '' : parsed.errors.join('; ')}`,
      );
      if (parsed.ok) out.push({ lang, id, file, manifest: parsed.manifest });
    }
  }
  return out;
}

function indexEntries(lang: string): RegistryEntry[] {
  const raw = readJson(join(ROOT, lang, 'index.json'));
  if (typeof raw !== 'object' || raw === null) return [];
  const packages = (raw as { packages?: unknown }).packages;
  return Array.isArray(packages) ? (packages as RegistryEntry[]) : [];
}

function placeholders(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\$\{([a-z0-9_]+)\}/gi)) {
      if (m[1]) out.add(m[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) placeholders(v, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) placeholders(v, out);
  }
}

const ALL = shipped();
const t = (name: string, fn: () => void): void => {
  test(name, { skip: SKIP }, fn);
};

t('es gibt mindestens ein ausgeliefertes Paket', () => {
  assert.ok(ALL.length > 0, 'keine Manifeste gefunden');
});

t('index.json passt zu den Manifesten', () => {
  for (const lang of languages()) {
    const entries = indexEntries(lang);
    const manifests = ALL.filter((s) => s.lang === lang);
    assert.deepEqual(
      entries.map((e) => e.id).sort(),
      manifests.map((m) => m.id).sort(),
      `${lang}: Index und Manifeste fuehren unterschiedliche Pakete`,
    );
    for (const entry of entries) {
      const actual = manifests.find((m) => m.id === entry.id)?.manifest;
      if (!actual) continue;
      assert.equal(entry.name, actual.name, `${entry.id}: name im Index weicht ab`);
      assert.equal(entry.summary, actual.summary, `${entry.id}: summary im Index weicht ab`);
      assert.equal(entry.version, actual.version, `${entry.id}: version im Index weicht ab`);
      assert.equal(
        entry.category ?? deriveCategory(actual),
        deriveCategory(actual),
        `${entry.id}: category im Index passt nicht zum Manifest`,
      );
      // Der Hash bezieht sich auf die Datei-Bytes; das Gateway laedt genau
      // diese Datei und vergleicht sie mit dem Index.
      const shipped = manifests.find((m) => m.id === entry.id)!;
      assert.equal(sha256Hex(readFileSync(shipped.file, 'utf8')), entry.sha256, `${entry.id}: sha256 im Index passt nicht zur Datei`);
    }
  }
});

t('Manifest-id, Ordnername und Sprache stimmen ueberein', () => {
  for (const s of ALL) {
    assert.equal(s.manifest.id, s.id, `${s.lang}/${s.id}: id passt nicht zum Ordner`);
    if (s.manifest.language !== undefined) {
      assert.equal(s.manifest.language, s.lang, `${s.lang}/${s.id}: language passt nicht`);
    }
    assert.ok(
      statSync(join(ROOT, s.lang, s.id, 'README.md')).isFile(),
      `${s.lang}/${s.id}: README.md fehlt`,
    );
  }
});

t('minGatewayVersion ist nicht neuer als das Gateway', () => {
  for (const s of ALL) {
    assert.equal(
      meetsMinVersion(GATEWAY_VERSION, s.manifest.minGatewayVersion),
      true,
      `${s.id}: verlangt Gateway ${s.manifest.minGatewayVersion ?? '-'}, installiert ${GATEWAY_VERSION}`,
    );
  }
});

t('Sicherheitsfelder verlangen Gateway 0.6.0', () => {
  // side_effect/confirm/tool_params kennt erst das Gateway 0.6.0. Ein Manifest,
  // das sie deklariert und eine aeltere Version zulaesst, wirkt dort still
  // abgeschwaecht: die Felder werden ignoriert, die Bestaetigung faellt aus.
  const SECURITY_MIN = '0.6.0';
  for (const s of ALL) {
    const secured = (s.manifest.actions ?? []).some(
      (a) => a.side_effect !== undefined || a.confirm !== undefined || a.tool_params !== undefined,
    );
    if (!secured) continue;
    assert.equal(
      meetsMinVersion(s.manifest.minGatewayVersion ?? '0.0.0', SECURITY_MIN),
      true,
      `${s.id}: deklariert Sicherheitsfelder, verlangt aber nur Gateway ${s.manifest.minGatewayVersion ?? '-'}`,
    );
  }
});

t('Platzhalter und params passen zusammen', () => {
  for (const s of ALL) {
    const used = new Set<string>();
    placeholders(s.manifest, used);
    const keys = new Set((s.manifest.params ?? []).map((p) => p.key));
    const missing = [...used].filter((k) => !keys.has(k));
    const unused = [...keys].filter((k) => !used.has(k));
    assert.deepEqual(missing, [], `${s.id}: Platzhalter ohne params-Eintrag`);
    assert.deepEqual(unused, [], `${s.id}: params ohne Platzhalter`);
    for (const p of s.manifest.params ?? []) {
      if (!p.required) continue;
      assert.ok(used.has(p.key), `${s.id}: Pflicht-Parameter ${p.key} wird nicht verwendet`);
    }
  }
});

t('Secrets stehen nie literal im Manifest', () => {
  const PLACEHOLDER = /\$\{[a-z0-9_]+\}/i;
  const ok = (v: string): boolean => v.trim() === '' || PLACEHOLDER.test(v);
  for (const s of ALL) {
    for (const server of s.manifest.servers ?? []) {
      if (server.auth_token !== undefined) {
        assert.ok(ok(server.auth_token), `${s.id}: auth_token literal`);
      }
      for (const [name, value] of Object.entries(server.headers ?? {})) {
        assert.ok(ok(value), `${s.id}: Header ${name} literal`);
      }
    }
  }
});

t('version und changelog sind konsistent', () => {
  for (const s of ALL) {
    const changelog = s.manifest.changelog ?? '';
    assert.ok(changelog.length > 0, `${s.id}: kein changelog`);
    assert.ok(
      changelog.startsWith(s.manifest.version),
      `${s.id}: changelog beginnt nicht mit Version ${s.manifest.version}`,
    );
  }
});

t('Sicherheitswirkung der ausgelieferten Pakete ist bekannt', () => {
  // Bewusste Entscheidung: aendert sich diese Liste, muss ein Review sie
  // bestaetigen - neue Shell-Nutzung oder neue stdio-Server fallen sonst auf.
  const dangerous = ALL.filter((s) => manifestDangerous(s.manifest).dangerous)
    .map((s) => s.id)
    .sort();
  assert.deepEqual(dangerous, ['aufgabenliste', 'brave-search', 'mqtt', 'searxng', 'system-info']);

  const shells = ALL.filter((s) => /(?<![\w.])shell\s*\(/.test(JSON.stringify(s.manifest)))
    .map((s) => s.id)
    .sort();
  assert.deepEqual(shells, ['system-info'], 'shell() darf nur system-info nutzen');

  for (const s of ALL) {
    for (const tool of s.manifest.allowTools ?? []) {
      assert.doesNotMatch(tool, /\*/, `${s.id}: Wildcard in allowTools (${tool})`);
    }
  }
});
