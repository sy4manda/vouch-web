import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handlerSource, hookSecret, verifyHookSecret } from '../../src/bankr/deploy.ts';
import { keeperTick } from '../../src/bankr/buyback.ts';
import { checkNetworkStamp } from '../../src/db/db.ts';
import * as svc from '../../src/domain/service.ts';
import { ALICE, BOB, addr, fakeChain, fakeDeployer, swap, testDeps } from '../helpers.ts';

const newPost = (d = testDeps(), body: object = { title: 'Good data', text: 'secret alpha', feeUsd: 1 }) => svc.createPost(d, ALICE, body).then((p) => ({ d, p }));

test('createPost deploys the endpoint, launches the token and stores the creator profile', async () => {
  const deployer = fakeDeployer();
  const { d, p } = await newPost(testDeps({ deployer }));
  assert.equal(p.tokenSymbol, 'GOODD');
  assert.equal(p.creator.x?.username, 'alice');
  assert.equal(p.text, 'secret alpha'); // creator can read their own post
  assert.match(p.endpointUrl, /^https:\/\/x402\.bankr\.bot\//);
  assert.equal(deployer.deployed[0].text, 'secret alpha');
  assert.equal(svc.listPosts(d.db, 'new', []).length, 1);
});

test('createPost validates input', async () => {
  const d = testDeps();
  for (const bad of [{ title: '', text: 'x', feeUsd: 1 }, { title: 't', text: 'x'.repeat(281), feeUsd: 1 }, { title: 't', text: 'x', feeUsd: 0.0005 }, { title: 't', text: 'x', feeUsd: 5000 }, { title: 't', text: 'x', feeUsd: 1.2345 }]) {
    await assert.rejects(svc.createPost(d, ALICE, bad), /must|Fee|required/);
  }
  assert.equal(svc.listPosts(d.db, 'new', []).length, 0);
});

test('a failed deploy leaves no live post and never launches a token', async () => {
  const chain = fakeChain();
  const d = testDeps({ chain, deployer: fakeDeployer(true) });
  await assert.rejects(svc.createPost(d, ALICE, { title: 't', text: 'x', feeUsd: 1 }), /Could not publish/);
  assert.equal(svc.listPosts(d.db, 'new', []).length, 0);
  assert.equal(chain.launched, 0);
});

test('text is only served to the creator or a wallet that unlocked', async () => {
  const { d, p } = await newPost();
  assert.equal(svc.listPosts(d.db, 'new', [])[0].text, undefined);
  assert.equal(svc.listPosts(d.db, 'new', [BOB.wallet])[0].unlocked, false);

  const r = svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet.toUpperCase().replace('0X', '0x'), eventId: 'e1' });
  assert.equal(r.newUnlock, true);
  const seen = svc.listPosts(d.db, 'new', [BOB.wallet])[0];
  assert.equal(seen.unlocked, true);
  assert.equal(seen.text, 'secret alpha');
  assert.equal(seen.unlocks, 1);
  assert.equal((await svc.getPost(d, p.id, [])).text, undefined);
});

test('recordUnlock is idempotent per event, and repeat payers still fund the buyback', async () => {
  const { d, p } = await newPost();
  svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'e1' });
  assert.equal(svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'e1' }).newUnlock, false); // handler retry
  assert.equal(svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'e2' }).newUnlock, false); // paid again
  const owed = d.db.prepare('SELECT usd FROM pending_buyback WHERE post_id = ?').get(p.id) as { usd: number };
  assert.equal(owed.usd, 2);
  assert.equal(svc.listPosts(d.db, 'new', [])[0].unlocks, 1);
  assert.throws(() => svc.recordUnlock(d.db, { postId: p.id, payer: 'nope', eventId: 'e3' }));
  assert.throws(() => svc.recordUnlock(d.db, { postId: 'missing', payer: BOB.wallet, eventId: 'e4' }), /not found/);
});

test('swaps become vouches: ranking, unique buyers, price and market-cap ordering', async () => {
  const d = testDeps();
  const a = (await svc.createPost(d, ALICE, { title: 'A post', text: 'a', feeUsd: 1 }));
  const b = (await svc.createPost(d, ALICE, { title: 'B post', text: 'b', feeUsd: 1 }));
  const poolOf = (id: string) => (d.db.prepare('SELECT pool_id FROM posts WHERE id = ?').get(id) as { pool_id: string }).pool_id;

  const s1 = swap({ poolId: poolOf(a.id), wallet: BOB.wallet, usd: 50, priceUsd: 0.001, block: 101 });
  assert.equal(svc.applySwaps(d.db, [s1, s1]), 1); // same swap twice records once
  svc.applySwaps(d.db, [
    swap({ poolId: poolOf(a.id), wallet: ALICE.wallet, usd: 5, priceUsd: 0.0011, block: 102 }),
    swap({ poolId: poolOf(a.id), wallet: BOB.wallet, side: 'sell', usd: 1, priceUsd: 0.00105, block: 100 }), // older block: must not move the price back
  ]);

  const detail = await svc.getPost(d, a.id, [BOB.wallet]);
  assert.equal(detail.vouchers, 2);
  assert.deepEqual(detail.topVouchers.map((v) => v.usd), [50, 5]);
  assert.equal(detail.myVouchUsd, 50);
  assert.equal(detail.priceUsd, 0.0011);
  assert.equal(detail.myTokens, 12.5);
  assert.ok(detail.curve.length > 10 && detail.supplySold > 0);
  assert.deepEqual(svc.listPosts(d.db, 'trending', []).map((p) => p.id), [a.id, b.id]);

  // profile: by X username (case-insensitive, optional @) or by wallet; lists created + vouched posts
  svc.upsertUser(d.db, ALICE);
  const alice = svc.getProfile(d.db, '@Alice', []);
  assert.equal(alice.profile.x?.name, 'Alice');
  assert.equal(alice.created.length, 2);
  assert.equal(alice.vouched[0].usd, 5);
  const bob = svc.getProfile(d.db, BOB.wallet, []);
  assert.equal(bob.profile.x, undefined);
  assert.equal(bob.vouched[0].usd, 50);
  assert.throws(() => svc.getProfile(d.db, 'nobody', []), /not found/);
});

test('trades: wallet must be linked, slippage is encoded into minOut', async () => {
  const { d, p } = await newPost();
  const ok = await svc.buildTrade(d, BOB, p.id, 'buy', { usd: 10, slippageBps: 500, wallet: BOB.wallet });
  const [amountIn, minOut] = ok.transactions[0].data.split(BOB.wallet.slice(2))[1].split('_').map((x) => BigInt('0x' + x));
  assert.equal(amountIn, 10_000_000n);
  assert.equal(minOut, (10_000_000n * 1_000_000_000_000n * 100n * 9500n) / 10_000n); // quote * (1 - 5%)
  await assert.rejects(svc.buildTrade(d, BOB, p.id, 'buy', { usd: 10, wallet: ALICE.wallet }), /not linked/);
  await assert.rejects(svc.buildTrade(d, BOB, p.id, 'buy', { usd: -1, wallet: BOB.wallet }), /valid/);
  await assert.rejects(svc.buildTrade(d, BOB, p.id, 'sell', { tokens: 5, slippageBps: 99999, wallet: BOB.wallet }), /slippage/);
  const q = await svc.quoteBuy(d, p.id, '10');
  assert.equal(q.feeUsd, 0.25);
  assert.ok(q.priceAfterUsd > p.priceUsd);
  const sq = await svc.quoteSell(d, p.id, '1000');
  assert.ok(sq.usdOut > 0 && sq.feeUsd > 0);
});

test('indexer: scans from the cursor and records what it finds', async () => {
  const { d, p } = await newPost();
  const poolId = (d.db.prepare('SELECT pool_id FROM posts WHERE id = ?').get(p.id) as { pool_id: string }).pool_id;
  const seen: [bigint, bigint][] = [];
  d.chain.swapsInRange = async (from, to) => { seen.push([from, to]); return from === 1n ? [swap({ poolId, wallet: BOB.wallet })] : []; };
  d.chain.blockNumber = async () => 3000n;
  await svc.indexerTick(d, 0n, 1500n);
  assert.deepEqual(seen, [[1n, 1500n], [1501n, 3000n]]);
  assert.equal(svc.listPosts(d.db, 'new', [])[0].vouchers, 1);
  await svc.indexerTick(d, 0n, 1500n); // nothing new: cursor persisted
  assert.equal(seen.length, 2);
});

test('handler is handler-snippet.ts with placeholders filled, and text cannot break out of the literal', () => {
  const nasty = 'a "quote" $& `tick` \\ ${x}\nnewline';
  const src = handlerSource({ postId: 'abc', text: nasty });
  assert.ok(src.includes(JSON.stringify(nasty)));
  assert.ok(src.includes(JSON.stringify('https://api.example.test/hooks/unlock')));
  assert.ok(src.includes(hookSecret('abc')));
  assert.ok(!/__[A-Z_]+__/.test(src.replace(/`__PLACEHOLDERS__`|__PLACEHOLDERS__/g, '')));
  assert.ok(verifyHookSecret('abc', hookSecret('abc')));
  assert.ok(!verifyHookSecret('abd', hookSecret('abc'))); // one post's secret is useless for another
  assert.ok(!verifyHookSecret('abc', undefined));
});

test('keeper: swaps owed fees, burns, and never counts its own swap as a vouch', async () => {
  const { d, p } = await newPost(testDeps(), { title: 'K', text: 'k', feeUsd: 0.1 });
  const poolId = (d.db.prepare('SELECT pool_id FROM posts WHERE id = ?').get(p.id) as { pool_id: string }).pool_id;
  const calls: string[] = [];
  const wallet = {
    swap: async (_token: string, usdc: string) => { calls.push(`swap ${usdc}`); return { hash: '0xSWAP', success: true, amountReceived: '500', amountReceivedRaw: '500000000000000000000' }; },
    burn: async (_t: string, amount: string) => { calls.push(`burn ${amount}`); return { txHash: '0xburn' }; },
  };
  const quiet = { log() {}, error() {} } as unknown as Console;

  svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'a' });
  await svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'b' });
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet });
  assert.deepEqual(calls, []); // $0.20 owed is under the batching threshold
  svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'c' });
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet });
  assert.deepEqual(calls, ['swap 0.300000', 'burn 500']);
  const post = svc.listPosts(d.db, 'new', [])[0];
  assert.equal(post.buybackUsd, 0.3);
  const detail = await svc.getPost(d, p.id, []);
  assert.equal(detail.burned, 500);

  // the indexer later sees the same swap tx: must stay a buyback
  svc.applySwaps(d.db, [swap({ poolId, wallet: addr(0xdead1), txHash: '0xswap' })]);
  assert.equal((await svc.getPost(d, p.id, [])).vouchers, 0);
});

test('keeper: a failed burn is retried without swapping twice', async () => {
  const { d, p } = await newPost(testDeps(), { title: 'K', text: 'k', feeUsd: 1 });
  let burnFails = true;
  let swaps = 0;
  const wallet = {
    swap: async () => { swaps++; return { hash: '0xS' + swaps, success: true, amountReceived: '1', amountReceivedRaw: '1000000000000000000' }; },
    burn: async () => { if (burnFails) throw new Error('rpc down'); return { txHash: '0xb' }; },
  };
  const quiet = { log() {}, error() {} } as unknown as Console;
  svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'a' });
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet });
  assert.equal(swaps, 1);
  svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'b' });
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet }); // burn still failing: must not swap the new fee on top
  assert.equal(swaps, 1);
  burnFails = false;
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet }); // finishes the stuck burn, then swaps + burns the second fee
  assert.equal(swaps, 2);
  assert.equal((await svc.getPost(d, p.id, [])).burned, 2);
});

test('keeper: a failing post backs off instead of retrying every tick', async () => {
  const { d, p } = await newPost(testDeps(), { title: 'K', text: 'k', feeUsd: 1 });
  let swaps = 0;
  const wallet = {
    swap: async () => { swaps++; throw new Error('403 liquidity too low'); },
    burn: async () => ({ txHash: '0xb' }),
  };
  const quiet = { log() {}, error() {} } as unknown as Console;
  const backoff = new Map();
  let t = 1_000_000;
  const now = () => t;
  svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'a' });

  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet, backoff, now });
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet, backoff, now }); // same instant: skipped
  assert.equal(swaps, 1);
  t += 30_000;
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet, backoff, now });
  assert.equal(swaps, 2);
  t += 30_000; // 2nd failure doubled the wait to 60s
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet, backoff, now });
  assert.equal(swaps, 2);
  t += 30_000;
  await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet, backoff, now });
  assert.equal(swaps, 3);
  assert.equal(svc.listPosts(d.db, 'new', [])[0].buybackUsd, 0); // nothing was ever credited
});

test('a database is tied to one network', async () => {
  const fresh = testDeps().db;
  checkNetworkStamp(fresh, 'base');
  checkNetworkStamp(fresh, 'base'); // same network again is fine
  assert.throws(() => checkNetworkStamp(fresh, 'baseSepolia'), /belongs to base but NETWORK is baseSepolia/);

  // a DB from before stamping that already has posts was a testnet DB
  const { d } = await newPost();
  assert.throws(() => checkNetworkStamp(d.db, 'base'), /belongs to baseSepolia/);
  checkNetworkStamp(d.db, 'baseSepolia');
});
