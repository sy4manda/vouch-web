import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/http/app.ts';
import { HttpError } from '../../src/errors.ts';
import * as svc from '../../src/domain/service.ts';
import { ALICE, BOB, alertSpy, fakeChain, fakeDeployer, testAuth, testDeps, withEnv } from '../helpers.ts';

const post = (d: svc.Deps, user = ALICE) => svc.createPost(d, user, { title: 'A post', text: 'x', feeUsd: 1 });
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as HttpError; } throw new Error('expected a rejection'); };

test('a wallet can publish a limited number of posts per day; others are unaffected', async () => {
  await withEnv({ POSTS_PER_USER_PER_DAY: '2' }, async () => {
    const d = testDeps();
    await post(d); await post(d);
    const e = await rejection(post(d));
    assert.equal(e.status, 429);
    assert.match(e.message, /2 posts per day/);
    assert.ok(e.retryAfter! >= 60);
    await post(d, BOB); // a different wallet still can
  });
});

test('a cooldown spaces out one wallet\'s posts', async () => {
  await withEnv({ POST_COOLDOWN_SEC: '60' }, async () => {
    const d = testDeps();
    await post(d);
    const e = await rejection(post(d));
    assert.equal(e.status, 429);
    assert.match(e.message, /Wait \d+s/);
    assert.ok(e.retryAfter! > 0 && e.retryAfter! <= 60);
  });
});

test('the whole app has a daily post cap, and hitting it alerts the operator', async () => {
  await withEnv({ POSTS_PER_DAY_TOTAL: '1' }, async () => {
    const spy = alertSpy();
    const d = { ...testDeps(), alert: spy };
    await post(d);
    const e = await rejection(post(d, BOB));
    assert.equal(e.status, 503);
    assert.deepEqual(spy.keys(), ['posts-daily-cap']);
  });
});

test('posts that failed before any token was launched cost no gas, so they do not use up the daily cap', async () => {
  await withEnv({ POSTS_PER_USER_PER_DAY: '1' }, async () => {
    const chain = fakeChain();
    const d = testDeps({ chain, deployer: fakeDeployer(true) }); // every deploy fails, before any launch
    for (let i = 0; i < 3; i++) await rejection(post(d));
    assert.equal(chain.launched, 0);
    d.deployer = fakeDeployer(); // Bankr recovers: the user can still publish their one post
    await post(d);
  });
});

test('a nearly empty deployer refuses new posts up front, before deploying or launching anything', async () => {
  const spy = alertSpy();
  const chain = fakeChain({ deployerBalance: async () => 1_000n });
  const deployer = fakeDeployer();
  const d = { ...testDeps({ chain, deployer }), alert: spy };
  const e = await rejection(post(d));
  assert.equal(e.status, 503);
  assert.match(e.message, /temporarily unavailable/);
  assert.deepEqual(spy.keys(), ['deployer-low']);
  assert.equal(deployer.deployed.length, 0);
  assert.equal(d.db.prepare('SELECT COUNT(*) c FROM posts').get()!.c, 0); // no half-created row either
});

test('a token that launched but could not be recorded tells the operator where it is', async () => {
  const spy = alertSpy();
  const d = { ...testDeps(), alert: spy };
  const real = d.db.prepare.bind(d.db);
  d.db.prepare = ((sql: string) => {
    if (sql.includes('SET token_address')) throw new Error('disk full');
    return real(sql);
  }) as typeof d.db.prepare;
  await assert.rejects(post(d), /Could not publish/);
  assert.equal(spy.sent.length, 1);
  assert.match(spy.sent[0].message, /was launched but the post could not go live/);
  assert.match(spy.sent[0].message, /0x/); // includes the token address
});

test('over the HTTP API a limit is a 429 with Retry-After', async () => {
  await withEnv({ POSTS_PER_USER_PER_DAY: '1' }, async () => {
    const app = createApp(testDeps(), testAuth);
    const req = () => app.request('/posts', { method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', text: 'x', feeUsd: 1 }) });
    assert.equal((await req()).status, 201);
    const res = await req();
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 60);
  });
});
