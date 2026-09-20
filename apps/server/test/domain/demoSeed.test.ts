import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_POSTS } from '@vouch/shared';
import { seedDemoFeed } from '../../src/domain/demoSeed.ts';
import * as svc from '../../src/domain/service.ts';
import { BOB, testDeps } from '../helpers.ts';

test('seedDemoFeed inserts the mock catalog once, with text hidden from strangers', () => {
  const { db } = testDeps();
  assert.equal(seedDemoFeed(db, 1_700_000_000_000), DEMO_POSTS.length);
  assert.equal(seedDemoFeed(db), 0);
  const posts = svc.listPosts(db, 'new', []);
  assert.equal(posts.length, DEMO_POSTS.length);
  assert.equal(posts[0].demo, true);
  assert.equal(posts.every((p) => p.text === undefined), true);
  assert.deepEqual(new Set(posts.map((p) => p.title)), new Set(DEMO_POSTS.map((p) => p.title)));
  assert.ok(posts.some((p) => p.unlocks > 0 && p.vouchers > 0 && p.marketCapUsd > 0));
});

test('signed-in demo unlock reveals text and does not queue a buyback', async () => {
  const d = testDeps();
  seedDemoFeed(d.db);
  const id = svc.listPosts(d.db, 'new', [])[0].id;
  await assert.rejects(svc.quoteBuy(d, id, 1), /not on-chain/);
  const locked = await svc.getPost(d, id, [BOB.wallet]);
  assert.equal(locked.unlocked, false);
  const expected = DEMO_POSTS.find((p) => p.title === locked.title)!.text;
  assert.equal(svc.recordDemoUnlock(d.db, BOB, id).text, expected);
  const seen = await svc.getPost(d, id, [BOB.wallet]);
  assert.equal(seen.unlocked, true);
  assert.equal(seen.text, expected);
  const owed = d.db.prepare('SELECT usd FROM pending_buyback WHERE post_id = ?').get(id);
  assert.equal(owed, undefined);
});
