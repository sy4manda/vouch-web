// Versioned SQL migrations, applied at startup (same idea as Monaco's supabase/migrations).
// Files in apps/server/migrations are named NNNN_description.sql and applied once, in order, each in its own
// transaction; applied versions are recorded in schema_migrations. To change the schema, add a new file: never edit
// one that has shipped.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function migrate(db: DatabaseSync, dir = MIGRATIONS_DIR, log: (m: string) => void = console.log): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const known = new Set(files.map((f) => f.replace(/\.sql$/, '')));
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version));

  // A database that is ahead of this build (e.g. after rolling back a deploy) must not be run by older code.
  const unknown = [...applied].filter((v) => !known.has(v));
  if (unknown.length) throw new Error(`Database has migrations this build does not know (${unknown.join(', ')}). Deploy a newer build.`);

  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)').run(version, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${version} failed and was rolled back: ${(e as Error).message}`);
    }
    ran.push(version);
    log(`migration applied: ${version}`);
  }
  return ran;
}
