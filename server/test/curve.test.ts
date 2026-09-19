import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costBetween, FOR_SALE, marketCap, priceAtSold, sampleCurve, soldAtPrice, START_PRICE, tokensForUsd } from '../curve.ts';

test('starts at the $100 market cap on a 1M supply', () => {
  assert.equal(marketCap(START_PRICE, 0), 100);
  assert.equal(priceAtSold(0), START_PRICE);
});

test('price and sold are inverses', () => {
  for (const s of [1, 5_000, 100_000, 380_000, 400_000, 600_000, 800_000]) {
    const back = soldAtPrice(priceAtSold(s));
    assert.ok(Math.abs(back - s) / s < 1e-6, `${s} -> ${back}`);
  }
});

test('price rises with supply sold and each band ends 10x higher', () => {
  const c = sampleCurve();
  for (let i = 1; i < c.length; i++) assert.ok(c[i].priceUsd > c[i - 1].priceUsd);
  // end of band 1 (40% of the curve) is a $1k market cap
  assert.ok(Math.abs(marketCap(priceAtSold(FOR_SALE * 0.4), 0) - 1000) / 1000 < 1e-6);
  assert.ok(Math.abs(marketCap(priceAtSold(FOR_SALE * 0.7), 0) - 10_000) / 10_000 < 1e-6);
});

test('cost to clear each band, under the equal-tokens-per-position model', () => {
  // The launch notes estimated ~$120 / ~$950 / ~$6k by hand. This model (equal token slice per position,
  // constant-liquidity within a position) gives ~$148 / ~$1.1k / ~$7.4k. Trades are quoted on-chain; this
  // only drives the chart, so pin the model here and re-check against the simulated launch.
  const b1 = costBetween(0, FOR_SALE * 0.4);
  const b2 = costBetween(FOR_SALE * 0.4, FOR_SALE * 0.7);
  const b3 = costBetween(FOR_SALE * 0.7, FOR_SALE * 0.9);
  assert.ok(b1 > 140 && b1 < 155, `band1 ${b1}`);
  assert.ok(b2 > 1_050 && b2 < 1_170, `band2 ${b2}`);
  assert.ok(b3 > 7_000 && b3 < 7_800, `band3 ${b3}`);
});

test('tokensForUsd inverts costBetween', () => {
  const t = tokensForUsd(50_000, 25);
  assert.ok(Math.abs(costBetween(50_000, 50_000 + t) - 25) < 1e-3);
});
