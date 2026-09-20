import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.ts';
import { openDb } from '../../src/db/db.ts';

const quiet = () => {};
const tmpMigrations = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};

test('a fresh database gets every migration once, in order, and reruns are no-ops', () => {
  const db = new DatabaseSync(':memory:');
  const first = migrate(db, MIGRATIONS_DIR, quiet);
  assert.deepEqual(first, [...first].sort());
  assert.ok(first[0].startsWith('0001_'));
  assert.deepEqual(migrate(db, MIGRATIONS_DIR, quiet), []);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM posts').get() as { c: number }).c, 0);
});

test('a database from before migrations existed adopts 0001 without losing data', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS_DIR, quiet);
  db.prepare(`INSERT INTO users(wallet, created_at) VALUES('0xabc', 1)`).run();
  db.exec('DROP TABLE schema_migrations'); // what an old database looks like: tables, no ledger
  migrate(db, MIGRATIONS_DIR, quiet);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c, 1);
  assert.ok((db.prepare('SELECT COUNT(*) c FROM schema_migrations').get() as { c: number }).c >= 2);
});

test('a failing migration rolls back completely and is not recorded', () => {
  const db = new DatabaseSync(':memory:');
  const dir = tmpMigrations({
    '0001_ok.sql': 'CREATE TABLE a (x INTEGER);',
    '0002_bad.sql': 'CREATE TABLE b (x INTEGER); INSERT INTO missing_table VALUES (1);',
  });
  assert.throws(() => migrate(db, dir, quiet), /0002_bad failed and was rolled back/);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE name = 'b'`).get()!.c, 0); // half of 0002 is undone
  assert.deepEqual((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version), ['0001_ok']);
});

test('refuses to run against a database that is ahead of this build', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, MIGRATIONS_DIR, quiet);
  db.prepare(`INSERT INTO schema_migrations VALUES('9999_from_the_future', 1)`).run();
  assert.throws(() => migrate(db, MIGRATIONS_DIR, quiet), /does not know \(9999_from_the_future\)/);
});

test('openDb applies the migrations', () => {
  const db = openDb(':memory:');
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'posts_creator_created'`).get());
});
