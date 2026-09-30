import 'dotenv/config';
import { existsSync } from 'node:fs';

const CURRENT_DB_PATH = './data/smartpilot.db';
const LEGACY_DB_PATH = './data/meinhelfer.db';

// Upgrade-Kompatibilitaet (F-D6): ohne explizites DB_PATH die bestehende
// Legacy-Datei weiterverwenden, statt nach dem Default-Wechsel eine leere neue
// DB anzulegen. Reine Funktion fuer Tests.
export function resolveDbPath(envPath: string | undefined, exists: (p: string) => boolean): string {
  if (envPath) return envPath;
  if (exists(LEGACY_DB_PATH) && !exists(CURRENT_DB_PATH)) return LEGACY_DB_PATH;
  return CURRENT_DB_PATH;
}

// Admin-Pfad-Prefix (Issue #10 Ausbaustufe): '' (Wurzel) oder '/prefix' ohne
// Trailing-Slash. Betrifft nur die Admin-UI; die oeffentliche API bleibt unter
// '/api/...'. Reine Funktion fuer Tests.
export function normalizeBasePath(raw: string | undefined): string {
  const p = (raw ?? '').trim();
  if (!p || p === '/') return '';
  return ('/' + p.replace(/^\/+/, '')).replace(/\/+$/, '');
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  authToken: req('AUTH_TOKEN'),
  dbPath: resolveDbPath(process.env.DB_PATH, existsSync),
  basePath: normalizeBasePath(process.env.BASE_PATH),
  llm: {
    baseUrl: req('LLM_BASE_URL').replace(/\/+$/, ''),
    apiKey: req('LLM_API_KEY'),
    model: req('LLM_MODEL'),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 2000),
    reasoningEffort: process.env.LLM_REASONING_EFFORT,
  },
  agentClarificationBudget: Number(process.env.AGENT_CLARIFICATION_BUDGET ?? 2),
  maxToolIterations: Number(process.env.MAX_TOOL_ITERATIONS ?? 6),
  toolDeadlineMs: Number(process.env.LLM_TOOL_DEADLINE_MS ?? 9000),
  // Paket-Registry-Basis (die Sprache wird angehaengt). Default = Haupt-Repo;
  // per PACKAGES_REGISTRY_URL z. B. auf einen Test-Branch umstellbar.
  packagesRegistryUrl:
    process.env.PACKAGES_REGISTRY_URL?.trim().replace(/\/+$/, '') ||
    'https://raw.githubusercontent.com/dezihh/SmartPilot/main/packages',
};
