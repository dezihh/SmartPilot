#!/usr/bin/env node
// Baut packages/<lang>/index.json deterministisch aus den Manifesten
// (packages/<lang>/<id>/manifest.json). Die Version kommt IMMER aus dem
// Manifest - so kann der Index nicht mehr driften.
//
// Nutzung:
//   node scripts/build-registry-index.mjs          # Index schreiben
//   node scripts/build-registry-index.mjs --check   # nur pruefen (CI), Exit 1 bei Abweichung
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const CHECK = process.argv.includes('--check');

function dirsIn(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Bestehende Reihenfolge beibehalten (Kuration), neue IDs alphabetisch anhaengen
// - deterministisch und ohne unnoetiges Umsortieren.
function buildIndex(lang) {
  const dir = join(PACKAGES_DIR, lang);
  const ids = dirsIn(dir).filter((id) => existsSync(join(dir, id, 'manifest.json')));
  const indexPath = join(dir, 'index.json');
  let prevOrder = [];
  let registryVersion = 1;
  if (existsSync(indexPath)) {
    try {
      const prev = readJson(indexPath);
      prevOrder = (prev.packages ?? []).map((p) => p.id);
      registryVersion = prev.registryVersion ?? 1;
    } catch {
      // defekter Alt-Index: aus den Manifesten neu aufbauen
    }
  }
  const kept = prevOrder.filter((id) => ids.includes(id));
  const added = ids.filter((id) => !kept.includes(id)).sort();
  const packages = [...kept, ...added].map((id) => {
    const m = readJson(join(dir, id, 'manifest.json'));
    if (m.id !== id) {
      console.error(`Manifest-id "${m.id}" passt nicht zum Ordner "${lang}/${id}"`);
      process.exit(1);
    }
    if (!m.name || !m.summary || !m.version) {
      console.error(`Manifest ${lang}/${id} fehlt name/summary/version`);
      process.exit(1);
    }
    return { id: m.id, name: m.name, summary: m.summary, version: m.version };
  });
  return { registryVersion, packages };
}

function render(index) {
  return JSON.stringify(index, null, 2) + '\n';
}

let changed = 0;
for (const lang of dirsIn(PACKAGES_DIR)) {
  const indexPath = join(PACKAGES_DIR, lang, 'index.json');
  // Nur Verzeichnisse mit mindestens einem Manifest sind Registries.
  if (!dirsIn(join(PACKAGES_DIR, lang)).some((id) => existsSync(join(PACKAGES_DIR, lang, id, 'manifest.json')))) continue;
  const next = render(buildIndex(lang));
  const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  if (next === current) continue;
  changed++;
  if (CHECK) {
    console.error(`::error file=packages/${lang}/index.json::Index ist nicht mit den Manifesten synchron. Bitte "node scripts/build-registry-index.mjs" ausfuehren.`);
  } else {
    writeFileSync(indexPath, next);
    console.log(`packages/${lang}/index.json aktualisiert`);
  }
}

if (CHECK) {
  if (changed > 0) process.exit(1);
  console.log('Registry-Index ist konsistent.');
}
