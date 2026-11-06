import 'dotenv/config';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CURRENT_DB_PATH = './data/smartpilot.db';
const LEGACY_DB_PATH = './data/meinhelfer.db';

// Upgrade-Kompatibilitaet : ohne explizites DB_PATH die bestehende
// Legacy-Datei weiterverwenden, statt nach dem Default-Wechsel eine leere neue
// DB anzulegen. Reine Funktion fuer Tests.
export function resolveDbPath(envPath: string | undefined, exists: (p: string) => boolean): string {
  if (envPath) return envPath;
  if (exists(LEGACY_DB_PATH) && !exists(CURRENT_DB_PATH)) return LEGACY_DB_PATH;
  return CURRENT_DB_PATH;
}

// Admin-Pfad-Prefix : '' (Wurzel) oder '/prefix' ohne
// Trailing-Slash. Betrifft nur die Admin-UI; die oeffentliche API bleibt unter
// '/api/...'. Reine Funktion fuer Tests.
export function normalizeBasePath(raw: string | undefined): string {
  const p = (raw ?? '').trim();
  if (!p || p === '/') return '';
  return ('/' + p.replace(/^\/+/, '')).replace(/\/+$/, '');
}

// Positive Zahl aus der Umgebung. Fehlend, leer, ungueltig oder <= 0 -> Default.
// Verhindert stilles Fail-open (NaN deaktiviert Limits) bzw. versehentliches
// Sperren (0). Reine Funktion fuer Tests.
export function envPositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return v;
}

const adminToken = req('ADMIN_TOKEN');
const apiToken = req('API_TOKEN');
// Beide Schluessel schuetzen unterschiedliche Bereiche. Waeren sie gleich,
// haette ein kompromittiertes API-Token (Alexa-Lambda) auch Admin-Zugriff.
export function assertTokensDistinct(admin: string, api: string): void {
  if (admin === api) throw new Error('ADMIN_TOKEN und API_TOKEN muessen sich unterscheiden');
}
// Beispielwerte aus .env.example duerfen nie produktiv laufen; in Produktion
// (Docker-Image setzt NODE_ENV=production) muss der Wert ausserdem lang genug
// sein. Tests/CI laufen bewusst mit kurzen, eindeutigen Tokens.
const PLACEHOLDER_TOKEN = /^change-me/i;
export function assertStrongToken(name: string, value: string): void {
  if (PLACEHOLDER_TOKEN.test(value)) throw new Error(`${name} ist noch der Platzhalter aus .env.example`);
  if (process.env.NODE_ENV === 'production' && value.length < 24) {
    throw new Error(`${name} muss in Produktion mindestens 24 Zeichen haben`);
  }
}
assertStrongToken('ADMIN_TOKEN', adminToken);
assertStrongToken('API_TOKEN', apiToken);
assertTokensDistinct(adminToken, apiToken);
const dbPath = resolveDbPath(process.env.DB_PATH, existsSync);

export const config = {
  port: envPositiveNumber(process.env.PORT, 3000),
  // Zwei getrennte Schluessel (Principle of Least Privilege): ADMIN_TOKEN nur fuer
  // den Admin-Bereich, API_TOKEN nur fuer die Adapter-API (/api/query,
  // /api/lambda-trace). Kein gemeinsamer Token mehr.
  adminToken,
  apiToken,
  dbPath,
  // Persistentes Volume fuer provisionierte stdio-MCP-Artefakte (npm-Pakete).
  // Default neben der DB, damit beide zusammen persistieren.
  mcpModulesDir:
    process.env.MCP_MODULES_DIR?.trim() ||
    join(dirname(dbPath), 'mcp_modules'),
  // Zeitlimit fuer den stdio-MCP-Init (initialize/listTools). Der Provisioner
  // stellt Pakete vorab bereit; ein hoeheres Limit faengt kalte Erstinstallation
  // ohne Laufzeit-npx ab.
  mcpInitTimeoutMs: envPositiveNumber(process.env.MCP_INIT_TIMEOUT_MS, 15_000),
  // Nach einem fehlgeschlagenen MCP-Init wird der Server fuer diese Zeit nicht
  // erneut versucht (schuetzt das Alexa-Fenster vor wiederholten 15-s-Init-
  // Timeouts).
  mcpFailureTtlMs: envPositiveNumber(process.env.MCP_FAILURE_TTL_MS, 30_000),
  basePath: normalizeBasePath(process.env.BASE_PATH),
  // Zeitzone fuer den Template-Kontext (now.hour/date/time). Der Container
  // laeuft in UTC; ohne explizite Zone waeren "Guten Morgen"-Templates falsch.
  timezone: (process.env.TZ ?? '').trim() || 'Europe/Berlin',
  llm: {
    baseUrl: req('LLM_BASE_URL').replace(/\/+$/, ''),
    apiKey: req('LLM_API_KEY'),
    model: req('LLM_MODEL'),
    maxTokens: envPositiveNumber(process.env.LLM_MAX_TOKENS, 2000),
    reasoningEffort: process.env.LLM_REASONING_EFFORT,
  },
  agentClarificationBudget: envPositiveNumber(process.env.AGENT_CLARIFICATION_BUDGET, 2),
  maxToolIterations: envPositiveNumber(process.env.MAX_TOOL_ITERATIONS, 6),
  toolDeadlineMs: envPositiveNumber(process.env.LLM_TOOL_DEADLINE_MS, 9000),
  // Paket-Registry-Basis (die Sprache wird angehaengt). Default = Haupt-Repo;
  // per PACKAGES_REGISTRY_URL z. B. auf einen Test-Branch umstellbar.
  packagesRegistryUrl:
    process.env.PACKAGES_REGISTRY_URL?.trim().replace(/\/+$/, '') ||
    'https://raw.githubusercontent.com/dezihh/SmartPilot/main/packages',
  // Express 'trust proxy' (Anzahl Hops, z. B. 1/2, oder 'loopback'/'linklocal').
  // Leer = nicht setzen. Hinter einem Reverse-Proxy noetig, damit req.ip die
  // echte Client-IP (X-Forwarded-For) liefert und das Rate-Limit pro Client greift.
  trustProxy: ((): number | string | undefined => {
    const v = (process.env.TRUST_PROXY ?? '').trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  })(),
  // Maximale Laenge des Query-Texts in Zeichen (Kostenschutz fuer /api/query).
  queryMaxChars: envPositiveNumber(process.env.QUERY_MAX_CHARS, 500),
  // Rate-Limit fuer /api/query (Anfragen pro Minute und Client, Kostenschutz).
  queryRateMax: envPositiveNumber(process.env.QUERY_RATE_MAX, 30),
  // Grosszuegiges Limit fuer die Admin-API pro Client-IP. Auch fehlgeschlagene
  // Token-Versuche zaehlen, damit Brute-Force nicht unbegrenzt ist.
  adminRateMax: envPositiveNumber(process.env.ADMIN_RATE_MAX, 600),
  // Erwartete Alexa-Skill-ID. Die Lambda sendet ihre applicationId als Header
  // X-Alexa-Skill-Id; gesetzt + abweichend -> Warnung (spaeter ggf. Ablehnung).
  alexaSkillId: (process.env.ALEXA_SKILL_ID ?? '').trim(),
  // Absolute Obergrenze einer Admin-Session (Sliding-TTL verlaengert sonst
  // unbegrenzt).
  sessionMaxMs: envPositiveNumber(process.env.SESSION_MAX_HOURS, 24) * 60 * 60 * 1000,
};
