import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { snapshot, startBackups } from '../../src/ops/backup.ts';
import { openDb } from '../../src/db/db.ts';
import { alertSpy } from '../helpers.ts';

const live = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  const db = openDb(join(dir, 'vouch.db'));
  db.prepare(`INSERT INTO users(wallet, created_at) VALUES('0xabc', 1)`).run();
  return { db, dir, backups: join(dir, 'backups') };
};
const at = (s: string) => new Date(`2026-01-01T${s}Z`);

test('a snapshot is a complete, readable copy of the live database', () => {
  const { db, backups } = live();
  const file = snapshot(db, backups, 5, at('10:00:00'))!;
  assert.match(file, /vouch-20260101100000\.db$/);
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal((copy.prepare('SELECT wallet FROM users').get() as { wallet: string }).wallet, '0xabc');
  assert.ok(copy.prepare('SELECT COUNT(*) c FROM schema_migrations').get()!.c as number >= 2);
  copy.close();
});

test('only the newest N snapshots are kept, and a second snapshot in the same second is skipped', () => {
  const { db, backups } = live();
  for (const t of ['10:00:00', '11:00:00', '12:00:00', '13:00:00']) snapshot(db, backups, 2, at(t));
  assert.deepEqual(readdirSync(backups).sort(), ['vouch-20260101120000.db', 'vouch-20260101130000.db']);
  assert.equal(snapshot(db, backups, 2, at('13:00:00')), null);
});

test('backups run once at startup, land next to the database, and are skipped for :memory: or when disabled', () => {
  const { db, dir } = live();
  const stop = startBackups(db, join(dir, 'vouch.db'), 6, 3, alertSpy());
  stop();
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  startBackups(openDb(':memory:'), ':memory:', 6, 3, alertSpy())();
  const other = mkdtempSync(join(tmpdir(), 'bk-'));
  startBackups(openDb(join(other, 'v.db')), join(other, 'v.db'), 0, 3, alertSpy())();
  assert.deepEqual(readdirSync(other).filter((f) => f === 'backups'), []);
});

test('a failing snapshot alerts instead of crashing the server', () => {
  const { db, dir } = live();
  const spy = alertSpy();
  db.close(); // the next VACUUM will throw
  startBackups(db, join(dir, 'vouch.db'), 6, 3, spy)();
  assert.deepEqual(spy.keys(), ['backup-failed']);
});
