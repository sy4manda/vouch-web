// The bonding curve, computed analytically from the launch template (launch.ts TEMPLATE.curves).
//
// Each band splits into `numPositions` equal-tick ranges, i.e. geometrically spaced prices, and each
// position holds an equal slice of the band's tokens as concentrated liquidity: selling tokens moves the
// price up along  sold(p) = n * (1/sqrt(pLo) - 1/sqrt(p)) / (1/sqrt(pLo) - 1/sqrt(pHi)).
// That lets us draw the curve and turn a pool price into "supply sold" with no RPC. Real trade quotes
// still come from the on-chain quoter (chain.ts); this is for display, and for tests.
import { formatEther } from 'viem';
import { TEMPLATE } from '../chain/launch.ts';
import type { CurvePoint } from '@vouch/shared';

export const TOTAL_SUPPLY = Number(formatEther(TEMPLATE.supply)); // 1,000,000: what market cap is measured against
export const FOR_SALE = Number(formatEther(TEMPLATE.forSale)); // tokens on the curve

type Position = { pLo: number; pHi: number; tokens: number; sLo: number };

function buildPositions(): Position[] {
  const out: Position[] = [];
  let sold = 0;
  for (const c of TEMPLATE.curves) {
    const pS = c.marketCap.start / TOTAL_SUPPLY;
    const bandTokens = FOR_SALE * Number(formatEther(c.shares));
    const pE = c.marketCap.end === 'max' ? Infinity : c.marketCap.end / TOTAL_SUPPLY;
    for (let j = 0; j < c.numPositions; j++) {
      const pLo = pE === Infinity ? pS : pS * (pE / pS) ** (j / c.numPositions);
      const pHi = pE === Infinity ? Infinity : pS * (pE / pS) ** ((j + 1) / c.numPositions);
      const tokens = bandTokens / c.numPositions;
      out.push({ pLo, pHi, tokens, sLo: sold });
      sold += tokens;
    }
  }
  return out;
}
const POSITIONS = buildPositions();
export const START_PRICE = POSITIONS[0].pLo;

/** Tokens sold from the curve when the pool price is p (USD per token). */
export function soldAtPrice(p: number): number {
  let s = 0;
  for (const q of POSITIONS) {
    if (p <= q.pLo) break;
    const inv = (x: number) => 1 / Math.sqrt(x);
    const frac = q.pHi === Infinity ? 1 - Math.sqrt(q.pLo / p) : (inv(q.pLo) - inv(Math.min(p, q.pHi))) / (inv(q.pLo) - inv(q.pHi));
    s += q.tokens * frac;
  }
  return s;
}

/** Pool price (USD per token) once `sold` tokens have left the curve. Inverse of soldAtPrice. */
export function priceAtSold(sold: number): number {
  if (sold <= 0) return START_PRICE;
  for (const q of POSITIONS) {
    if (sold > q.sLo + q.tokens) continue;
    const f = (sold - q.sLo) / q.tokens; // 0..1 through this position
    if (q.pHi === Infinity) return q.pLo / (1 - Math.min(f, 0.999999)) ** 2;
    const a = 1 / Math.sqrt(q.pLo);
    const b = 1 / Math.sqrt(q.pHi);
    return 1 / (a - f * (a - b)) ** 2;
  }
  // past the last position: extrapolate along the tail so callers get a finite, huge price
  const tail = POSITIONS[POSITIONS.length - 1];
  return priceAtSold(tail.sLo + tail.tokens * 0.999999);
}

/** USDC needed to move the price from pA to pB (pA < pB), before swap fees. */
function costBetweenPrices(pA: number, pB: number): number {
  let usd = 0;
  for (const q of POSITIONS) {
    const lo = Math.max(pA, q.pLo);
    const hi = Math.min(pB, q.pHi);
    if (hi <= lo) continue;
    const inv = (x: number) => 1 / Math.sqrt(x);
    const D = q.pHi === Infinity ? inv(q.pLo) : inv(q.pLo) - inv(q.pHi);
    usd += (q.tokens / D) * (Math.sqrt(hi) - Math.sqrt(lo));
  }
  return usd;
}

/** USDC to move supply sold from a to b (a < b), before fees. */
export const costBetween = (a: number, b: number) => costBetweenPrices(priceAtSold(a), priceAtSold(b));

/** Tokens bought by spending `usd` (net of fee) from position `sold`. */
export function tokensForUsd(sold: number, usd: number): number {
  let lo = sold;
  let hi = FOR_SALE;
  if (costBetween(sold, hi) <= usd) return hi - sold;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (costBetween(sold, mid) < usd) lo = mid;
    else hi = mid;
  }
  return lo - sold;
}

export const marketCap = (price: number, burned: number) => price * (TOTAL_SUPPLY - burned);

/** Sampled curve from zero supply sold up to 90% of the curve's tokens (the last band is an open-ended tail). */
export function sampleCurve(points = 80): CurvePoint[] {
  const end = FOR_SALE * 0.9;
  const out: CurvePoint[] = [];
  for (let i = 0; i <= points; i++) {
    const s = (i / points) * end;
    out.push({ supply: s, priceUsd: priceAtSold(s) });
  }
  return out;
}
