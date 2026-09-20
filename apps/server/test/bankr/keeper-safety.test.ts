import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keeperTick, type Wallet } from '../../src/bankr/buyback.ts';
import * as svc from '../../src/domain/service.ts';
import { ALICE, BOB, alertSpy, testDeps, withEnv } from '../helpers.ts';

const quiet = { log() {}, error() {} } as unknown as Console;
const DAY = 86_400_000;

/** A live post with `usd` owed for its buyback. */
async function owing(usd: number) {
  const d = testDeps();
  const p = await svc.createPost(d, ALICE, { title: 'K', text: 'k', feeUsd: 1 });
  d.db.prepare('INSERT INTO pending_buyback(post_id, usd) VALUES(?,?)').run(p.id, usd);
  return { d, p };
}
const owed = (d: svc.Deps, id: string) => (d.db.prepare('SELECT usd FROM pending_buyback WHERE post_id = ?').get(id) as { usd: number }).usd;

/** A wallet that records every swap and returns unique tx hashes. */
function recorder() {
  const swaps: string[] = [];
  const wallet: Wallet = {
    swap: async (_t, usdc) => { swaps.push(usdc); return { hash: `0xswap${swaps.length}`, success: true, amountReceived: '10', amountReceivedRaw: '10000000000000000000' }; },
    burn: async () => ({ txHash: '0xburn' }),
  };
  return { wallet, swaps };
}

test('one swap is capped; the rest stays owed and goes out on later ticks', async () => {
  const { d, p } = await owing(10);
  const { wallet, swaps } = recorder();
  const opts = { minUsdc: 0.25, maxSwapUsdc: 4, log: quiet };
  await keeperTick(d.db, wallet, opts);
  assert.deepEqual(swaps, ['4.000000']);
  assert.equal(owed(d, p.id), 6);
  await keeperTick(d.db, wallet, opts);
  await keeperTick(d.db, wallet, opts);
  assert.deepEqual(swaps, ['4.000000', '4.000000', '2.000000']);
  assert.equal(owed(d, p.id), 0);
});

test('a rolling 24h cap stops the keeper, alerts once, and resumes when the window rolls over', async () => {
  const { d, p } = await owing(10);
  const { wallet, swaps } = recorder();
  const spy = alertSpy();
  let t = Date.now();
  const opts = { minUsdc: 0.25, maxDailyUsdc: 5, log: quiet, alert: spy, now: () => t };
  await keeperTick(d.db, wallet, opts);
  assert.deepEqual(swaps, ['5.000000']);
  await keeperTick(d.db, wallet, opts); // cap reached: nothing goes out
  assert.deepEqual(swaps, ['5.000000']);
  assert.deepEqual(spy.keys(), ['keeper-daily-cap']);
  t += DAY + 1000;
  await keeperTick(d.db, wallet, opts);
  assert.deepEqual(swaps, ['5.000000', '5.000000']);
  assert.equal(owed(d, p.id), 0);
});

test('it never spends more than the Bankr wallet actually holds', async () => {
  const { d, p } = await owing(10);
  const { wallet, swaps } = recorder();
  const spy = alertSpy();
  await keeperTick(d.db, wallet, { minUsdc: 0.25, balance: async () => 2, log: quiet, alert: spy });
  assert.deepEqual(swaps, ['2.000000']); // owed $10, holds $2
  assert.equal(owed(d, p.id), 8);
  await keeperTick(d.db, wallet, { minUsdc: 0.25, balance: async () => 0.1, log: quiet, alert: spy });
  assert.deepEqual(swaps, ['2.000000']); // nothing spendable left
  assert.deepEqual(spy.keys(), ['keeper-balance']);
});

test('the reserve is never touched', async () => {
  const { d } = await owing(10);
  const { wallet, swaps } = recorder();
  await keeperTick(d.db, wallet, { minUsdc: 0.25, balance: async () => 5, reserveUsdc: 4, log: quiet });
  assert.deepEqual(swaps, ['1.000000']);
});

test('spending in one tick is tracked across posts, so two posts cannot both spend the same dollars', async () => {
  const d = testDeps();
  const a = await svc.createPost(d, ALICE, { title: 'A', text: 'a', feeUsd: 1 });
  const b = await svc.createPost(d, BOB, { title: 'B', text: 'b', feeUsd: 1 });
  for (const p of [a, b]) d.db.prepare('INSERT INTO pending_buyback(post_id, usd) VALUES(?,?)').run(p.id, 3);
  const { wallet, swaps } = recorder();
  await keeperTick(d.db, wallet, { minUsdc: 0.25, balance: async () => 4, log: quiet });
  assert.equal(swaps.reduce((s, x) => s + Number(x), 0), 4); // $6 owed, $4 held
});

test('if the wallet balance cannot be read, nothing is swapped and the operator is told', async () => {
  const { d, p } = await owing(10);
  const { wallet, swaps } = recorder();
  const spy = alertSpy();
  await keeperTick(d.db, wallet, { minUsdc: 0.25, balance: async () => { throw new Error('rpc down'); }, log: quiet, alert: spy });
  assert.deepEqual(swaps, []);
  assert.equal(owed(d, p.id), 10);
  assert.deepEqual(spy.keys(), ['keeper-balance-unreadable']);
});

test('a post that keeps failing alerts once it has failed five times in a row, not before', async () => {
  const { d, p } = await owing(10);
  const wallet: Wallet = { swap: async () => { throw new Error('403 liquidity too low'); }, burn: async () => ({ txHash: '0x' }) };
  const spy = alertSpy();
  const backoff = new Map();
  let t = 1_000_000;
  const tick = async () => {
    await keeperTick(d.db, wallet, { minUsdc: 0.25, log: quiet, alert: spy, backoff, now: () => t });
    t += 16 * 60_000; // past the longest backoff, so every tick really retries
  };
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(spy.keys(), []); // four failures: logged, not paged
  await tick();
  assert.deepEqual(spy.keys(), [`keeper-swap:${p.id}`]);
  assert.match(spy.sent[0].message, /failed 5 times in a row: 403 liquidity too low/);
});

test('unlock fees are queued net of Bankr\'s cut, so the keeper only plans to spend money that arrived', async () => {
  await withEnv({ BANKR_FEE_BPS: '500' }, async () => {
    const d = testDeps();
    const p = await svc.createPost(d, ALICE, { title: 'K', text: 'k', feeUsd: 1 });
    svc.recordUnlock(d.db, { postId: p.id, payer: BOB.wallet, eventId: 'e1' });
    assert.equal(owed(d, p.id), 0.95);
  });
});
