import { exec } from 'node:child_process';
import type { TraceEvent } from '../types.js';

// Shell-Helper: admin-only editierbar (Templates), laeuft im Gateway-Container.
// Absicherungen: Timeout + Output-Cap, damit ein haengender Befehl die
// Alexa-Antwort nicht blockiert bzw. den Prompt sprengt.
const SHELL_TIMEOUT_MS = 5000;
const SHELL_OUTPUT_CAP = 4000;

export function runShell(cmd: string, trace: TraceEvent[]): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          trace.push({
            ts: Date.now(),
            step: 'template.shell.error',
            detail: { cmd, error: String(err.message).slice(0, 300), stderr: String(stderr).slice(0, 300) },
          });
          return resolve(null);
        }
        const out = `${stdout}`.trim().slice(0, SHELL_OUTPUT_CAP);
        trace.push({ ts: Date.now(), step: 'template.shell', detail: { cmd, chars: out.length } });
        resolve(out);
      }
    );
  });
}
