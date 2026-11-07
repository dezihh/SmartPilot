// Statischer Modul-Graph der Admin-UI (web/js/*.js).
//
// Ohne Bundler laedt der Browser die Dateien als ES-Module: ein Import ohne
// passenden Export (oder ein Helfer, der benutzt aber nicht importiert wird)
// laesst das ganze Modul scheitern - die Seite wirkt dann "tot" (Navigation
// ohne Funktion), waehrend alle Dateien mit 200 ausgeliefert werden. Dieser
// Test faengt beides ohne Browser ab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'web', 'js');

interface Mod {
  name: string;
  exports: Set<string>;
  imports: Map<string, string[]>; // Ziel -> Namen
  source: string;
}

function load(): Map<string, Mod> {
  const mods = new Map<string, Mod>();
  for (const name of readdirSync(DIR).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(join(DIR, name), 'utf8');
    const exports = new Set<string>();
    for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)) {
      if (m[1]) exports.add(m[1]);
    }
    const imports = new Map<string, string[]>();
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)) {
      const names = (m[1] ?? '')
        .split(',')
        .map((n) => n.split(' as ')[0]?.trim())
        .filter((n): n is string => Boolean(n));
      const target = m[2] ?? '';
      imports.set(target, [...(imports.get(target) ?? []), ...names]);
    }
    mods.set(name, { name, exports, imports, source });
  }
  return mods;
}

const MODS = load();

test('es gibt ueberhaupt Module', () => {
  assert.ok(MODS.size > 3);
});

test('jeder benannte Import hat einen passenden Export', () => {
  for (const mod of MODS.values()) {
    for (const [target, names] of mod.imports) {
      const goal = MODS.get(target);
      assert.ok(goal, `${mod.name}: importiert unbekanntes Modul ${target}`);
      for (const name of names) {
        assert.ok(
          goal!.exports.has(name),
          `${mod.name}: '${name}' wird aus ${target} importiert, dort aber nicht exportiert`
        );
      }
    }
  }
});

test('Helfer aus lib.js werden importiert, nicht nur benutzt', () => {
  const helpers = MODS.get('lib.js')!.exports;
  for (const mod of MODS.values()) {
    if (mod.name === 'lib.js') continue;
    const own = new Set<string>();
    for (const m of mod.source.matchAll(/(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) {
      if (m[1]) own.add(m[1]);
    }
    const imported = new Set([...(mod.imports.get('lib.js') ?? [])]);
    for (const helper of helpers) {
      if (own.has(helper) || imported.has(helper)) continue;
      const used = new RegExp(`(^|[^.\\w$])${helper}\\s*\\(`, 'm').test(mod.source);
      assert.equal(used, false, `${mod.name}: benutzt ${helper}() ohne Import aus lib.js`);
    }
  }
});

test('alle lokalen Importziele existieren', () => {
  for (const mod of MODS.values()) {
    for (const target of mod.imports.keys()) {
      assert.ok(MODS.has(target), `${mod.name}: importiert ${target}, Datei fehlt`);
    }
  }
});

test('Grundeinstellungen: agent_tool_limit ist ein Zahlenfeld (F-005)', () => {
  const src = MODS.get('app.js')!.source;
  const start = src.indexOf('const SETTINGS_FIELDS = [');
  assert.ok(start >= 0, 'SETTINGS_FIELDS fehlt in app.js');
  const block = src.slice(start, src.indexOf('\n];', start));
  const keys = [...block.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, 'doppelte Setting-Keys im Formular');

  const fieldStart = block.indexOf("key: 'agent_tool_limit'");
  assert.ok(fieldStart >= 0, 'agent_tool_limit fehlt in SETTINGS_FIELDS');
  const nextField = block.indexOf("key: '", fieldStart + 1);
  const entry = block.slice(fieldStart, nextField === -1 ? undefined : nextField);
  assert.match(entry, /type: 'number'/, 'agent_tool_limit muss type number sein');
});
