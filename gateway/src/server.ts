import { config } from './config.js';
import { listMcpServers } from './db.js';
import { provisionMcpServers, npmInstallRunner } from './mcp/provision.js';
import { chatCompletion } from './llm/client.js';
import { createApp } from './app.js';

// stdio-MCP-Artefakte vor dem Start bereitstellen (persistentes Volume). Fehler
// blockieren den Start nicht - der betroffene Server bleibt "unavailable" und
// wird beim naechsten Start erneut reconciled.
try {
  const specs = listMcpServers(true, true)
    .filter((r) => r.transport === 'stdio' && r.npm_spec)
    .map((r) => r.npm_spec as string);
  const report = provisionMcpServers({ specs, dir: config.mcpModulesDir, runInstall: npmInstallRunner });
  if (report.installed.length) console.log(`MCP-Artefakte provisioniert: ${report.installed.join(', ')}`);
  if (report.removed.length) console.log(`MCP-Artefakte entfernt: ${report.removed.join(', ')}`);
  if (report.failed.length) console.warn('MCP-Provisionierung fehlgeschlagen:', report.failed);
} catch (e) {
  console.warn('MCP-Provisionierung uebersprungen:', e);
}

createApp().listen(config.port, () => {
  console.log(`SmartPilot Gateway auf Port ${config.port}`);
});

if (process.env.LLM_KEEPALIVE_MS !== '0') {
  setInterval(() => {
    chatCompletion([{ role: 'user', content: 'OK' }], undefined, 15000).catch(() => {});
  }, Number(process.env.LLM_KEEPALIVE_MS ?? 120_000)).unref();
}
