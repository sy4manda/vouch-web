import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/http/app.ts';
import { createLimiter } from '../../src/http/rateLimit.ts';
import { hookSecret } from '../../src/bankr/deploy.ts';
import { BOB, testAuth, testDeps, withEnv } from '../helpers.ts';

test('limiter: allows max per window, then blocks with a retry time; windows and keys are independent', () => {
  const l = createLimiter({ windowMs: 60_000, max: 2 });
  assert.equal(l.hit('a', 1000).ok, true);
  assert.equal(l.hit('a', 2000).ok, true);
  const blocked = l.hit('a', 3000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfter, 58);
  assert.equal(l.hit('b', 3000).ok, true); // someone else is unaffected
  assert.equal(l.hit('a', 61_001).ok, true); // window rolled over
});

test('the API answers 429 with Retry-After once a client is over the general limit', async () => {
  await withEnv({ RATE_LIMIT_PER_MIN: '3' }, async () => {
    const app = createApp(testDeps(), testAuth);
    for (let i = 0; i < 3; i++) assert.equal((await app.request('/posts')).status, 200);
    const res = await app.request('/posts');
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
    assert.match((await res.json() as { error: string }).error, /Too many requests/);
  });
});

test('/health and Bankr\'s unlock webhook are never rate limited', async () => {
  await withEnv({ RATE_LIMIT_PER_MIN: '1' }, async () => {
    const deps = testDeps();
    const app = createApp(deps, testAuth);
    await app.request('/posts');
    assert.equal((await app.request('/posts')).status, 429);
    for (let i = 0; i < 5; i++) assert.equal((await app.request('/health')).status, 200);
    // the webhook reaches the handler (404 unknown post, not 429) however often it is called
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/hooks/unlock', { method: 'POST', headers: { 'x-vouch-secret': hookSecret('nope'), 'content-type': 'application/json' }, body: JSON.stringify({ postId: 'nope', payer: BOB.wallet, eventId: `e${i}` }) });
      assert.equal(res.status, 404);
    }
  });
});

test('X-Forwarded-For is only believed behind our own proxy (TRUST_PROXY=1)', async () => {
  const hit = (app: ReturnType<typeof createApp>, ip: string) => app.request('/posts', { headers: { 'x-forwarded-for': ip } });
  await withEnv({ RATE_LIMIT_PER_MIN: '1', TRUST_PROXY: undefined }, async () => {
    const app = createApp(testDeps(), testAuth);
    assert.equal((await hit(app, '1.1.1.1')).status, 200);
    assert.equal((await hit(app, '2.2.2.2')).status, 429); // spoofing another IP buys nothing
  });
  await withEnv({ RATE_LIMIT_PER_MIN: '1', TRUST_PROXY: '1' }, async () => {
    const app = createApp(testDeps(), testAuth);
    assert.equal((await hit(app, '1.1.1.1')).status, 200);
    assert.equal((await hit(app, '2.2.2.2')).status, 200); // different real clients
    assert.equal((await hit(app, '1.1.1.1')).status, 429);
  });
});

test('oversized request bodies are refused', async () => {
  const app = createApp(testDeps(), testAuth);
  const res = await app.request('/posts', {
    method: 'POST',
    headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 't', text: 'x'.repeat(20_000), feeUsd: 1 }),
  });
  assert.equal(res.status, 413);
});
