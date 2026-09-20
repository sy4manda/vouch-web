import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/http/app.ts';
import { hookSecret } from '../../src/bankr/deploy.ts';
import { seedDemoFeed } from '../../src/domain/demoSeed.ts';
import { ALICE, BOB, testAuth, testDeps, withEnv } from '../helpers.ts';

const setup = () => {
  const deps = testDeps();
  const app = createApp(deps, testAuth);
  const req = (path: string, o: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, {
      method: o.method ?? (o.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers },
      body: o.body ? JSON.stringify(o.body) : undefined,
    }) as Promise<Omit<Response, 'json'> & { json(): Promise<any> }>;
  return { deps, req };
};

test('posting needs a session; the creator can read, everyone else sees a locked post', async () => {
  const { req } = setup();
  assert.equal((await req('/posts', { body: { title: 't', text: 'x', feeUsd: 1 } })).status, 401);
  assert.equal((await req('/posts', { token: 'garbage', body: { title: 't', text: 'x', feeUsd: 1 } })).status, 401);
  const created = await req('/posts', { token: 'alice', body: { title: 'Hello', text: 'the secret', feeUsd: 1 } });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const anon = await (await req('/posts')).json();
  assert.equal(anon[0].text, undefined);
  assert.equal(anon[0].unlocked, false);
  const asAlice = await (await req(`/posts/${id}`, { token: 'alice' })).json();
  assert.equal(asAlice.text, 'the secret');
  assert.equal((await req('/posts/nope')).status, 404);
});

test('the viewer query param is not trusted: it cannot reveal someone else\'s unlocked text', async () => {
  const { req } = setup();
  const { id } = await (await req('/posts', { token: 'alice', body: { title: 'Hello', text: 'the secret', feeUsd: 1 } })).json();
  await req('/hooks/unlock', { headers: { 'x-vouch-secret': hookSecret(id) }, body: { postId: id, payer: BOB.wallet, eventId: 'e1' } });
  const spoof = await (await req(`/posts/${id}?viewer=${BOB.wallet}`)).json();
  assert.equal(spoof.text, undefined);
  const real = await (await req(`/posts/${id}`, { token: 'bob' })).json();
  assert.equal(real.text, 'the secret');
  assert.equal(real.unlocked, true);
});

test('unlock webhook needs the per-post secret', async () => {
  const { req } = setup();
  const { id } = await (await req('/posts', { token: 'alice', body: { title: 'Hello', text: 'x', feeUsd: 1 } })).json();
  const body = { postId: id, payer: BOB.wallet, eventId: 'e1' };
  assert.equal((await req('/hooks/unlock', { body })).status, 401);
  assert.equal((await req('/hooks/unlock', { body, headers: { 'x-vouch-secret': hookSecret('other') } })).status, 401);
  const ok = await req('/hooks/unlock', { body, headers: { 'x-vouch-secret': hookSecret(id) } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { newUnlock: true });
});

test('buy returns ordered transactions and rejects a wallet the user does not own', async () => {
  const { req } = setup();
  const { id } = await (await req('/posts', { token: 'alice', body: { title: 'Hello', text: 'x', feeUsd: 1 } })).json();
  assert.equal((await req(`/posts/${id}/buy`, { body: { usd: 5, wallet: BOB.wallet } })).status, 401);
  const res = await req(`/posts/${id}/buy`, { token: 'bob', body: { usd: 5, slippageBps: 300, wallet: BOB.wallet } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).transactions.length, 1);
  const stolen = await req(`/posts/${id}/buy`, { token: 'bob', body: { usd: 5, wallet: ALICE.wallet } });
  assert.equal(stolen.status, 400);
  assert.match((await stolen.json()).error, /not linked/);
  assert.equal((await req(`/posts/${id}/buy/confirm`, { token: 'bob', body: { hash: '0x12' } })).status, 400);
  assert.equal((await req(`/posts/${id}/buy/confirm`, { token: 'bob', body: { hash: '0x' + 'a'.repeat(64) } })).status, 200);
  assert.equal((await (await req(`/posts/${id}/quote?usd=10`)).json()).usdIn, 10);
});

test('profiles by X username', async () => {
  const { req } = setup();
  await req('/posts', { token: 'alice', body: { title: 'Hello', text: 'x', feeUsd: 1 } });
  const p = await (await req('/profiles/alice')).json();
  assert.equal(p.profile.x.username, 'alice');
  assert.equal(p.created.length, 1);
  assert.equal((await req('/profiles/ghost')).status, 404);
});

test('CORS allows each origin in CORS_ORIGIN and rejects others', async () => {
  await withEnv({ CORS_ORIGIN: 'https://vouch.vercel.app, http://localhost:5173' }, async () => {
    const { req } = setup();
    const vercel = await req('/health', { headers: { origin: 'https://vouch.vercel.app' } });
    assert.equal(vercel.headers.get('access-control-allow-origin'), 'https://vouch.vercel.app');
    const local = await req('/health', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const evil = await req('/health', { headers: { origin: 'https://evil.example' } });
    assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example');
  });
});

test('demo posts unlock with a session and stay locked without one', async () => {
  const { deps, req } = setup();
  seedDemoFeed(deps.db);
  const feed = await (await req('/posts?sort=new')).json();
  assert.equal(feed[0].demo, true);
  assert.equal(feed[0].text, undefined);
  const id = feed[0].id;
  assert.equal((await req(`/posts/${id}/unlock`, { method: 'POST' })).status, 401);
  const paid = await req(`/posts/${id}/unlock`, { method: 'POST', token: 'bob' });
  assert.equal(paid.status, 200);
  assert.ok((await paid.json()).text.length > 0);
  const asBob = await (await req(`/posts/${id}`, { token: 'bob' })).json();
  assert.equal(asBob.unlocked, true);
  const real = await req('/posts', { token: 'alice', body: { title: 'Hello', text: 'the secret', feeUsd: 1 } });
  const liveId = (await real.json()).id;
  assert.equal((await req(`/posts/${liveId}/unlock`, { method: 'POST', token: 'bob' })).status, 400);
});
