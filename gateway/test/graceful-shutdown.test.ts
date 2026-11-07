// Betriebsvertrag: Docker stoppt den Container mit SIGTERM. Der Prozess muss
// daraufhin mit Code 0 enden, damit der Shutdown im Log als sauber erkennbar
// ist (Audit F-012). Der Test startet den echten Serverprozess auf einem
// freien Port und misst das Verhalten, statt nur den Code zu lesen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const READY = 'SmartPilot Gateway auf Port';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function runShutdownScenario(): Promise<void> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'sp-shutdown-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(dir, 'gateway.db'),
      MCP_MODULES_DIR: join(dir, 'mcp_modules'),
      ADMIN_TOKEN: 'admin-token-fuer-shutdown-test-0001',
      API_TOKEN: 'api-token-fuer-shutdown-test-0002',
      LOG_LEVEL: 'info',
      LLM_KEEPALIVE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Server nicht bereit nach 30 s:\n${output}`)),
        30_000,
      );
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(READY)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Server endete vorzeitig (code=${code}, signal=${signal}):\n${output}`));
      });
    });

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const { code, signal } = await exit;

    assert.equal(signal, null, 'Prozess muss regulaer beenden, nicht durch Signal sterben');
    assert.equal(code, 0, `Exit-Code nach SIGTERM (Ausgabe:\n${output})`);
    assert.match(output, /Gateway wird beendet/);
    assert.match(output, /SIGTERM/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SIGTERM beendet das Gateway sauber mit Exit-Code 0', { timeout: 120_000 }, async () => {
  // Zwischen freePort() und listen() kann der Port belegt werden (bekanntes
  // Rennen, G-08). Bis zu drei Versuche; echte Fehler sofort melden.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await runShutdownScenario();
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/EADDRINUSE|endete vorzeitig/.test(message) || attempt === 3) throw error;
    }
  }
  throw lastError;
});
