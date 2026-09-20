// SQLite via node's built-in driver: no native build step, single file. The schema lives in ../../migrations/*.sql.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';

export type DB = DatabaseSync;


export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); // e.g. data/ on a fresh checkout
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db); // versioned SQL in apps/server/migrations, applied at startup
  return db;
}

export const getMeta = (db: DB, k: string) => (db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v;
export const setMeta = (db: DB, k: string, v: string) => void db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);

/**
 * A database belongs to one network: posts hold token addresses that only exist there. Stamp it on first use and
 * refuse to open it on another network, instead of quietly mixing testnet posts into a mainnet run.
 * A DB that has posts but no stamp predates stamping, when only Base Sepolia was ever used.
 */
export function checkNetworkStamp(db: DB, network: string): void {
  let stamp = getMeta(db, 'network');
  if (!stamp) {
    const hasPosts = (db.prepare('SELECT COUNT(*) c FROM posts').get() as { c: number }).c > 0;
    stamp = hasPosts ? 'baseSepolia' : network;
    setMeta(db, 'network', stamp);
  }
  if (stamp !== network) {
    throw new Error(`This database belongs to ${stamp} but NETWORK is ${network}. Use a separate DB_PATH per network (see .env.testnet / .env.mainnet).`);
  }
}

/** Run fn in a transaction; rolls back on throw. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
