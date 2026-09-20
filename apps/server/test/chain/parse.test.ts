import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hex } from 'viem';
import { parseSwaps, priceFromSqrt } from '../../src/chain/chain.ts';
import { addr } from '../helpers.ts';

const PM = addr(0x9999);
const TOKEN = addr(0x7001);
const POOL = ('0x' + '11'.repeat(32)) as Hex;
const pool = { tokenAddress: TOKEN, poolId: POOL, tokenIsCurrency0: true };

// logs are pre-decoded here: `topics[0]` carries the event name so the fake decoder can just read it
const log = (name: 'Swap' | 'Transfer', address: string, args: object, i: number) =>
  ({ address, topics: [name], data: '0x' as Hex, logIndex: i, transactionHash: '0xAbC', blockNumber: 500n, args }) as any;
const decode = (l: any) => ({ name: l.topics[0], args: l.args });

const Q96 = 2n ** 96n;

test('buy: tokens leave the PoolManager to the trader', () => {
  const swaps = parseSwaps([
    log('Transfer', addr(0xc), { from: addr(0xb0b), to: PM, value: 10_000_000n }, 0), // USDC in: another token's log, must be ignored
    log('Swap', PM, { id: POOL, amount0: -5_000n * 10n ** 18n, amount1: 10_000_000n, sqrtPriceX96: Q96 }, 1),
    log('Transfer', TOKEN, { from: PM, to: addr(0xb0b), value: 5_000n * 10n ** 18n }, 2),
  ], [pool], PM, decode);
  assert.equal(swaps.length, 1);
  assert.deepEqual({ side: swaps[0].side, wallet: swaps[0].wallet, usd: swaps[0].usd, tokens: swaps[0].tokens, tx: swaps[0].txHash }, { side: 'buy', wallet: addr(0xb0b), usd: 10, tokens: 5000, tx: '0xabc' });
});

test('sell: the trader sends tokens to the PoolManager; the sign of the Swap amounts does not matter', () => {
  for (const sign of [1n, -1n]) {
    const [s] = parseSwaps([
      log('Swap', PM, { id: POOL, amount0: sign * 2_000n * 10n ** 18n, amount1: -sign * 3_900_000n, sqrtPriceX96: Q96 }, 0),
      log('Transfer', TOKEN, { from: addr(0xa11ce), to: PM, value: 2_000n * 10n ** 18n }, 1),
    ], [pool], PM, decode);
    assert.equal(s.side, 'sell');
    assert.equal(s.wallet, addr(0xa11ce));
    assert.equal(s.usd, 3.9);
    assert.equal(s.tokens, 2000);
  }
});

test('ignores pools we do not track, and swaps with no token transfer', () => {
  assert.equal(parseSwaps([log('Swap', PM, { id: ('0x' + '22'.repeat(32)) as Hex, amount0: 1n, amount1: -1n, sqrtPriceX96: Q96 }, 0)], [pool], PM, decode).length, 0);
  assert.equal(parseSwaps([log('Swap', PM, { id: POOL, amount0: 1n, amount1: -1n, sqrtPriceX96: Q96 }, 0)], [pool], PM, decode).length, 0);
});

test('two swaps on one pool in one tx are summed and the later price wins', () => {
  const [s] = parseSwaps([
    log('Swap', PM, { id: POOL, amount0: -100n * 10n ** 18n, amount1: 1_000_000n, sqrtPriceX96: Q96 }, 0),
    log('Swap', PM, { id: POOL, amount0: -100n * 10n ** 18n, amount1: 2_000_000n, sqrtPriceX96: 2n * Q96 }, 1),
    log('Transfer', TOKEN, { from: PM, to: addr(0xb0b), value: 200n * 10n ** 18n }, 2),
  ], [pool], PM, decode);
  assert.equal(s.usd, 3);
  assert.equal(s.tokens, 200);
  assert.equal(s.priceUsd, 4e12); // (2^1)^2 * 1e12
});

test('price from sqrtPriceX96 handles both token orderings', () => {
  assert.equal(priceFromSqrt(Q96, true), 1e12);
  assert.equal(priceFromSqrt(Q96, false), 1e12);
  assert.equal(priceFromSqrt(2n * Q96, false), 1e12 / 4);
});
