// Provisioner fuer stdio-MCP-Artefakte: stellt die im Manifest deklarierten
// npm-Pakete (npm_spec) deterministisch in einem persistenten Volume bereit,
// damit stdio-Server ohne Laufzeit-`npx` starten (kein 15-s-Kaltstart-Timeout).
// Reine Logik ohne DB-/Config-Zugriff - die Verdrahtung passiert in server.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProvisionReport {
  /** Gewuenschte npm-Specs (dedupliziert, sortiert). */
  desired: string[];
  /** Im aktuellen Lauf installierte Specs (leer bei skip). */
  installed: string[];
  /** Paketnamen, die aus dem Volume entfernt wurden (Prune). */
  removed: string[];
  /** true = alles schon vorhanden, kein npm-Aufruf. */
  skipped: boolean;
  /** Fehlgeschlagene Installationen - Start laeuft trotzdem weiter. */
  failed: { spec: string; error: string }[];
}

export type InstallRunner = (dir: string, specs: string[]) => void;

// Paketname aus einer npm-Spec: "@scope/name@1.2.3" -> "@scope/name",
// "name@^1.0.0" -> "name", "name" -> "name".
export function specName(spec: string): string {
  const s = spec.trim();
  if (s.startsWith('@')) {
    const at = s.indexOf('@', 1);
    return at === -1 ? s : s.slice(0, at);
  }
  const at = s.indexOf('@');
  return at === -1 ? s : s.slice(0, at);
}

interface PkgJson {
  dependencies?: Record<string, string>;
}

function readDependencies(dir: string): Record<string, string> {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return {};
  try {
    return (JSON.parse(readFileSync(p, 'utf8')) as PkgJson).dependencies ?? {};
  } catch {
    return {};
  }
}

// Idempotent: sind die deklarierten Pakete unveraendert vorhanden, wird kein
// npm install ausgefuehrt. Aenderungen (neu/entfernt) werden in package.json
// geschrieben; ein `npm install` gleicht node_modules ab (installiert fehlende,
// entfernt ueberzaehlige = Prune).
export function provisionMcpServers(opts: { specs: string[]; dir: string; runInstall: InstallRunner }): ProvisionReport {
  const desired = [...new Set(opts.specs.map((s) => s.trim()).filter(Boolean))].sort();
  const desiredNames = desired.map(specName).sort();
  const report: ProvisionReport = { desired, installed: [], removed: [], skipped: false, failed: [] };

  mkdirSync(opts.dir, { recursive: true });
  const currentDeps = readDependencies(opts.dir);
  const currentNames = Object.keys(currentDeps).sort();
  report.removed = currentNames.filter((n) => !desiredNames.includes(n));

  const sameDeps = currentNames.length === desiredNames.length && desiredNames.every((n, i) => n === currentNames[i]);
  if (sameDeps && existsSync(join(opts.dir, 'node_modules'))) {
    report.skipped = true;
    return report;
  }

  const dependencies: Record<string, string> = {};
  for (const spec of desired) {
    const name = specName(spec);
    dependencies[name] = spec.slice(name.length).replace(/^@/, '') || '*';
  }
  writeFileSync(
    join(opts.dir, 'package.json'),
    JSON.stringify(
      {
        name: 'smartpilot-mcp-modules',
        version: '0.0.0',
        private: true,
        description: 'Vom SmartPilot-Provisioner verwaltete stdio-MCP-Artefakte - nicht manuell bearbeiten.',
        dependencies,
      },
      null,
      2
    ) + '\n'
  );

  try {
    opts.runInstall(opts.dir, desired);
  } catch (e) {
    report.failed.push({ spec: desired.join(', '), error: e instanceof Error ? e.message : String(e) });
    return report;
  }
  report.installed = desired;
  return report;
}

// Standard-Runner: `npm install` im Volume (packages.json steuert deterministisch).
// Fester Timeout, damit ein Netzhaenger den Containerstart nicht blockiert.
export const npmInstallRunner: InstallRunner = (dir) => {
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: 'inherit',
    timeout: 300_000,
    env: process.env,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`npm install fehlgeschlagen (Exit ${res.status ?? 'unbekannt'})`);
};
