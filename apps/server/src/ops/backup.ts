// Consistent snapshots of the live database. `VACUUM INTO` is safe while the server is writing (unlike copying the
// file, which can catch the WAL mid-write), and each snapshot is integrity-checked before it counts as a backup.
// Snapshots stay on the same disk: copy the backups folder off the machine too (see docs/operations.md).
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Alerter } from './alert.ts';
import type { DB } from '../db/db.ts';

const NAME = /^vouch-\d{14}\.db$/;

export function snapshot(db: DB, dir: string, keep: number, now = new Date()): string | null {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const file = join(dir, `vouch-${stamp}.db`);
  if (existsSync(file)) return null; // already took one this second
  db.prepare('VACUUM INTO ?').run(file);

  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const result = (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (result !== 'ok') {
      rmSync(file, { force: true });
      throw new Error(`snapshot failed its integrity check: ${result}`);
    }
  } finally {
    check.close();
  }

  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) rmSync(join(dir, old), { force: true });
  return file;
}

/** Snapshot now, then every `hours`. Returns a stop function. A failed snapshot alerts; it never crashes the server. */
export function startBackups(db: DB, dbPath: string, hours: number, keep: number, alert: Alerter): () => void {
  if (dbPath === ':memory:' || hours <= 0) return () => {};
  const dir = join(dirname(dbPath), 'backups');
  const run = () => {
    try {
      const f = snapshot(db, dir, keep);
      if (f) console.log(`backup: ${f}`);
    } catch (e) {
      alert('backup-failed', `database backup failed: ${(e as Error).message}`);
    }
  };
  run();
  const timer = setInterval(run, hours * 3_600_000);
  return () => clearInterval(timer);
}
