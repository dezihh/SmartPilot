// Vorwaerts-Migrationsrunner auf Basis von `PRAGMA user_version`. Jede
// Migration laeuft in eigener Transaktion; schlaegt eine fehl, wird sie
// zurueckgerollt und die Version bleibt unveraendert (forward-only).
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export function currentVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

// Fuehrt alle Migrationen mit version > user_version in aufsteigender
// Reihenfolge aus. onBeforeFirst laeuft genau einmal, bevor der erste Schritt
// angewendet wird (z. B. fuer ein Backup). Rueckgabe: erreichte Version.
export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
  onBeforeFirst?: () => void
): number {
  const current = currentVersion(db);
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return current;
  onBeforeFirst?.();
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return currentVersion(db);
}
