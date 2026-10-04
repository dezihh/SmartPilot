// Provisioner: idempotent (kein zweiter npm-Aufruf), Prune entfernter Pakete
// und "fehlend -> installieren". Reine Logik mit injiziertem Runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionMcpServers, specName, type InstallRunner } from '../src/mcp/provision.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'prov-'));
}

// Runner-Stub: legt node_modules an und protokolliert die Aufrufe, ohne npm.
function stubRunner(calls: { dir: string; specs: string[] }[]): InstallRunner {
  return (dir, specs) => {
    calls.push({ dir, specs });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  };
}

function deps(dir: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies;
}

test('specName: scoped und unscoped', () => {
  assert.equal(specName('@brave/brave-search-mcp-server@2.1.4'), '@brave/brave-search-mcp-server');
  assert.equal(specName('@scope/pkg'), '@scope/pkg');
  assert.equal(specName('mcp-searxng@^2.5.0'), 'mcp-searxng');
  assert.equal(specName('mcp-searxng'), 'mcp-searxng');
});

test('missing -> install: erster Lauf installiert, zweiter ist idempotent', () => {
  const dir = tmpDir();
  const calls: { dir: string; specs: string[] }[] = [];
  const specs = ['@brave/brave-search-mcp-server@2.1.4'];

  const r1 = provisionMcpServers({ specs, dir, runInstall: stubRunner(calls) });
  assert.equal(r1.installed.length, 1);
  assert.equal(r1.skipped, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(deps(dir), { '@brave/brave-search-mcp-server': '2.1.4' });

  const r2 = provisionMcpServers({ specs, dir, runInstall: stubRunner(calls) });
  assert.equal(r2.skipped, true);
  assert.equal(r2.installed.length, 0);
  assert.equal(calls.length, 1, 'zweiter Lauf darf npm nicht erneut aufrufen');
});

test('prune: entfernte Specs werden aus package.json entfernt', () => {
  const dir = tmpDir();
  const calls: { dir: string; specs: string[] }[] = [];
  const run = stubRunner(calls);

  provisionMcpServers({ specs: ['mcp-searxng@2.5.0', 'hugo@0.1.0'], dir, runInstall: run });
  assert.deepEqual(Object.keys(deps(dir)).sort(), ['hugo', 'mcp-searxng']);

  const r = provisionMcpServers({ specs: ['mcp-searxng@2.5.0'], dir, runInstall: run });
  assert.deepEqual(r.removed, ['hugo']);
  assert.deepEqual(Object.keys(deps(dir)), ['mcp-searxng']);
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
