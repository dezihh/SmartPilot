// Provisioner: idempotent (kein zweiter npm-Aufruf bei gleicher Version), Prune
// entfernter Pakete (physisch), "fehlend -> installieren", Versionsbump und
// sauberer Skip ohne Specs. Reine Logik mit injiziertem Runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionMcpServers, specName, type InstallRunner } from '../src/mcp/provision.js';

interface Call {
  op: 'install' | 'prune';
  specs?: string[];
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prov-'));
}

function stubInstall(calls: Call[]): InstallRunner {
  return (dir, specs) => {
    calls.push({ op: 'install', specs });
    for (const spec of specs) {
      mkdirSync(join(dir, 'node_modules', specName(spec)), { recursive: true });
    }
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  };
}

// Simuliert `npm prune`: entfernt node_modules-Ordner, die nicht mehr in
// package.json stehen.
function stubPrune(calls: Call[]): InstallRunner {
  return (dir) => {
    calls.push({ op: 'prune' });
    const deps = readDependenciesRaw(dir);
    const nm = join(dir, 'node_modules');
    if (!existsSync(nm)) return;
    for (const entry of readdirSync(nm)) {
      if (entry === '.bin' || entry.startsWith('@')) continue;
      if (!(entry in deps)) rmSync(join(nm, entry), { recursive: true, force: true });
    }
  };
}

function readDependenciesRaw(dir: string): Record<string, string> {
  const p = join(dir, 'package.json');
  return existsSync(p)
    ? ((JSON.parse(readFileSync(p, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {})
    : {};
}

test('specName: scoped und unscoped', () => {
  assert.equal(specName('@brave/brave-search-mcp-server@2.1.4'), '@brave/brave-search-mcp-server');
  assert.equal(specName('@scope/pkg'), '@scope/pkg');
  assert.equal(specName('mcp-searxng@^2.5.0'), 'mcp-searxng');
  assert.equal(specName('mcp-searxng'), 'mcp-searxng');
});

test('missing -> install: erster Lauf installiert, zweiter ist idempotent', () => {
  const dir = tmpDir();
  const calls: Call[] = [];
  const specs = ['@brave/brave-search-mcp-server@2.1.4'];

  const r1 = provisionMcpServers({ specs, dir, runInstall: stubInstall(calls) });
  assert.equal(r1.installed.length, 1);
  assert.equal(r1.skipped, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(readDependenciesRaw(dir), { '@brave/brave-search-mcp-server': '2.1.4' });

  const r2 = provisionMcpServers({ specs, dir, runInstall: stubInstall(calls) });
  assert.equal(r2.skipped, true);
  assert.equal(r2.installed.length, 0);
  assert.equal(calls.length, 1, 'zweiter Lauf darf npm nicht erneut aufrufen');
});

test('Versionsbump: neue Version loest Reinstall aus, gleiche nicht', () => {
  const dir = tmpDir();
  const calls: Call[] = [];
  const run = stubInstall(calls);

  provisionMcpServers({ specs: ['pkg@1.0.0'], dir, runInstall: run });
  assert.equal(readDependenciesRaw(dir)['pkg'], '1.0.0');

  const same = provisionMcpServers({ specs: ['pkg@1.0.0'], dir, runInstall: run });
  assert.equal(same.skipped, true, 'gleiche Version bleibt ohne Reinstall');
  assert.equal(calls.filter((c) => c.op === 'install').length, 1);

  const bumped = provisionMcpServers({ specs: ['pkg@2.0.0'], dir, runInstall: run });
  assert.equal(bumped.skipped, false);
  assert.deepEqual(bumped.installed, ['pkg@2.0.0']);
  assert.equal(readDependenciesRaw(dir)['pkg'], '2.0.0');
  assert.equal(calls.filter((c) => c.op === 'install').length, 2, 'Versionsbump loest Reinstall aus');
});

test('Prune entfernt nicht mehr deklarierte Pakete physisch', () => {
  const dir = tmpDir();
  const calls: Call[] = [];
  const runInstall = stubInstall(calls);
  const runPrune = stubPrune(calls);

  provisionMcpServers({ specs: ['mcp-searxng@2.5.0', 'hugo@0.1.0'], dir, runInstall, runPrune });
  assert.ok(existsSync(join(dir, 'node_modules', 'hugo')), 'hugo anfangs vorhanden');

  const r = provisionMcpServers({ specs: ['mcp-searxng@2.5.0'], dir, runInstall, runPrune });
  assert.deepEqual(r.removed, ['hugo']);
  assert.ok(!existsSync(join(dir, 'node_modules', 'hugo')), 'hugo physisch entfernt');
  assert.ok(existsSync(join(dir, 'node_modules', 'mcp-searxng')), 'benoetigtes Paket bleibt');
  assert.ok(calls.some((c) => c.op === 'prune'), 'npm prune wurde aufgerufen');
});

test('Ohne Specs und ohne Volume: sauberer Skip (kein npm, keine Datei)', () => {
  const dir = tmpDir();
  const calls: Call[] = [];
  const r = provisionMcpServers({ specs: [], dir, runInstall: stubInstall(calls) });
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(join(dir, 'package.json')), 'keine package.json geschrieben');
});

test('Installationsfehler blockiert nicht: failed gefuellt, kein Wurf', () => {
  const dir = tmpDir();
  const r = provisionMcpServers({
    specs: ['hugo@0.1.0'],
    dir,
    runInstall: () => {
      throw new Error('kein Netz');
    },
  });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0]!.error, /kein Netz/);
  assert.equal(r.installed.length, 0);
});
