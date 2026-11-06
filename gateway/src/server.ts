import { config } from './config.js';
import { initDb, closeDb } from './db/schema.js';
import { listMcpServers } from './db.js';
import { stopAllClients } from './mcp/registry.js';
import { provisionMcpServers, npmInstallRunner, npmPruneRunner } from './mcp/provision.js';
import { chatCompletion } from './llm/client.js';
import { createApp } from './app.js';
import { log, logError, setLogLevel } from './core/logger.js';

// Log-Level vor allem anderen setzen, damit auch die Startmeldungen passen.
setLogLevel(config.logLevel);

// DB explizit vor dem ersten Zugriff initialisieren (kein Import-Seiteneffekt
// in db.ts). Tests rufen initDb weiterhin selbst mit Temp-Pfad auf.
initDb(config.dbPath, true);

// stdio-MCP-Artefakte vor dem Start bereitstellen (persistentes Volume). Fehler
// blockieren den Start nicht - der betroffene Server bleibt "unavailable" und
// wird beim naechsten Start erneut reconciled.
try {
  const specs = listMcpServers(true, true)
    .filter((r) => r.transport === 'stdio' && r.npm_spec)
    .map((r) => r.npm_spec as string);
  const report = provisionMcpServers({
    specs,
    dir: config.mcpModulesDir,
    runInstall: npmInstallRunner,
    runPrune: npmPruneRunner,
  });
  if (report.installed.length) log.info('MCP-Artefakte provisioniert', { specs: report.installed });
  if (report.removed.length) log.info('MCP-Artefakte entfernt', { specs: report.removed });
  if (report.failed.length) log.warn('MCP-Provisionierung fehlgeschlagen', { failed: report.failed });
} catch (e) {
  logError('MCP-Provisionierung uebersprungen', e);
}

const server = createApp().listen(config.port, () => {
  log.info(`SmartPilot Gateway auf Port ${config.port}`, { log_level: config.logLevel });
});

// Docker/Compose beendet den Container mit SIGTERM. Ohne Handler blieben
// stdio-Kindprozesse am Leben und die SQLite-WAL unaufgeraeumt.
function shutdown(signal: string): void {
  log.info('Gateway wird beendet', { signal });
  server.close(() => {
    try { stopAllClients(); } catch { /* best effort */ }
    try { closeDb(); } catch { /* best effort */ }
    process.exit(0);
  });
  // Fallback, falls offene Keep-Alive-Verbindungen das Schliessen blockieren.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// LLM warm halten (0 = aus). Ungueltige Werte deaktivieren den Timer, statt
// mit NaN zu laufen.
const keepaliveRaw = (process.env.LLM_KEEPALIVE_MS ?? '').trim();
const keepaliveMs = Number(keepaliveRaw);
if (keepaliveRaw !== '0' && Number.isFinite(keepaliveMs) && keepaliveMs > 0) {
  setInterval(() => {
    chatCompletion([{ role: 'user', content: 'OK' }], undefined, 15000).catch(() => {});
  }, keepaliveMs).unref();
}
