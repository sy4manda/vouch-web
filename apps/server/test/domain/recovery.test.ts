import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverStuckPosts } from '../../src/domain/recovery.ts';
import { ALICE, alertSpy, testDeps } from '../helpers.ts';

const insert = (db: ReturnType<typeof testDeps>['db'], id: string, status: string, createdAt: number, token: string | null = null) =>
  db.prepare(`INSERT INTO posts(id, title, text, creator, fee_usd, created_at, status, service_name, endpoint_url, symbol, token_address) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 't', 'x', ALICE.wallet, 1, createdAt, status, `vouch-${id}`, '', 'T', token);
const status = (db: ReturnType<typeof testDeps>['db'], id: string) => (db.prepare('SELECT status, error FROM posts WHERE id = ?').get(id) as { status: string; error: string | null });

test('startup recovery fails every post left in launching and alerts for each', () => {
  const { db } = testDeps();
  const spy = alertSpy();
  insert(db, 'a', 'launching', Date.now());
  insert(db, 'b', 'launching', Date.now() - 3_600_000, '0xtoken');
  insert(db, 'c', 'live', Date.now());
  assert.equal(recoverStuckPosts(db, 0, spy, Date.now() + 1), 2);
  assert.equal(status(db, 'a').status, 'failed');
  assert.match(status(db, 'a').error!, /interrupted/);
  assert.equal(status(db, 'b').status, 'failed');
  assert.equal(status(db, 'c').status, 'live'); // untouched
  assert.deepEqual(spy.keys().sort(), ['stuck-a', 'stuck-b']);
  assert.match(spy.sent.find((s) => s.key === 'stuck-b')!.message, /0xtoken/); // says where the launched token is
});

test('the periodic pass only touches old rows, so a publish still running is left alone', () => {
  const { db } = testDeps();
  const now = Date.now();
  insert(db, 'fresh', 'launching', now - 60_000);
  insert(db, 'old', 'launching', now - 30 * 60_000);
  assert.equal(recoverStuckPosts(db, 15 * 60_000, alertSpy(), now), 1);
  assert.equal(status(db, 'fresh').status, 'launching');
  assert.equal(status(db, 'old').status, 'failed');
});
