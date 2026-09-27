import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetischer DB-Pfad je Testlauf: kein festes /tmp/opencode (F-20), keine
// Kollision zwischen parallelen Laeufen. Verzeichnis wird beim ersten Aufruf
// angelegt; der Name haelt die Zuordnung zum Testfile nachvollziehbar.
export function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `smartpilot-${name}-`)), `${name}.db`);
}
