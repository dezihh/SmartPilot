// Sicherung der SQLite-Datei vor einer Migration. Der WAL wird vorher in die
// Hauptdatei gecheckpointet, damit die Kopie in sich konsistent ist; -wal/-shm
// werden trotzdem mitkopiert (falls vorhanden).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

export function backupDatabase(db: Database.Database, dbPath: string): string {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(dirname(dbPath), 'backups', stamp);
  mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = dbPath + suffix;
    if (existsSync(src)) copyFileSync(src, join(dir, basename(dbPath) + suffix));
  }
  return dir;
}
