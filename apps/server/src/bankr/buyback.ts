// Buyback-and-burn, driven by the database instead of pending.json: every x402 unlock adds the fee to
// pending_buyback (see service.recordUnlock); this loop swaps batches into the post's token and burns them.
// The Bankr Wallet API calls are the ones in src/bankr/keeper.ts, split into swap and burn so a failed burn can be
// retried without swapping twice.
//
// This is the code that spends real money from the Bankr wallet, so it is deliberately conservative:
//  - it never swaps more than the wallet actually holds (minus a reserve you can set aside),
//  - one swap is capped, and so is a day's total,
//  - a failing post backs off instead of retrying every tick,
//  - anything unusual raises an alert instead of being retried silently.
import { BURN, burnTokens, rawToAmount, swapToToken, type SwapDone } from './keeper.ts';
import { tx, type DB } from '../db/db.ts';
import { alert as realAlert, type Alerter } from '../ops/alert.ts';

export type Wallet = {
  swap(token: string, usdc: string): Promise<SwapDone>;
  burn(token: string, amount: string): Promise<{ txHash: string }>;
};
export const bankrWallet: Wallet = { swap: (token, usdc) => swapToToken(token, usdc), burn: burnTokens };

type Row = { post_id: string; usd: number; token_address: string };

/** Failed posts are retried with exponential backoff (30s, 60s, ... capped at 15 min) instead of every tick. */
export type Backoff = Map<string, { fails: number; next: number }>;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const ALERT_AFTER_FAILS = 5;
const DAY_MS = 86_400_000;
const floor6 = (n: number) => Math.floor(n * 1e6) / 1e6;

export type KeeperOptions = {
  /** don't swap dust: batch fees until at least this much is owed */
  minUsdc: number;
  /** cap on a single swap; the rest stays owed for the next tick */
  maxSwapUsdc?: number;
  /** cap on everything swapped in any rolling 24h */
  maxDailyUsdc?: number;
  /** USDC in the wallet the keeper must never touch */
  reserveUsdc?: number;
  /** the wallet's real USDC balance. When given, swaps are limited to it; if it can't be read, nothing is swapped. */
  balance?: () => Promise<number>;
  log?: Console;
  alert?: Alerter;
  backoff?: Backoff;
  now?: () => number;
};

export async function keeperTick(db: DB, wallet: Wallet, opts: KeeperOptions): Promise<void> {
  const { minUsdc, maxSwapUsdc = Infinity, maxDailyUsdc = Infinity, reserveUsdc = 0, log = console, alert = realAlert, backoff = new Map(), now = Date.now } = opts;
  const waiting = (key: string) => (backoff.get(key)?.next ?? 0) > now();
  const failed = (key: string, what: string, e: Error) => {
    const fails = (backoff.get(key)?.fails ?? 0) + 1;
    backoff.set(key, { fails, next: now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (fails - 1)) });
    log.error(`${what}:`, e.message);
    if (fails >= ALERT_AFTER_FAILS) alert(`keeper-${key}`, `${what} has failed ${fails} times in a row: ${e.message}`);
  };

  // 1. finish burns whose swap already happened
  const burns = db.prepare(`SELECT b.post_id, b.amount, p.token_address FROM pending_burn b JOIN posts p ON p.id = b.post_id`).all() as { post_id: string; amount: string; token_address: string }[];
  for (const b of burns) {
    if (waiting(`burn:${b.post_id}`)) continue;
    try {
      await wallet.burn(b.token_address, b.amount);
      tx(db, () => {
        db.prepare('DELETE FROM pending_burn WHERE post_id = ?').run(b.post_id);
        db.prepare('UPDATE posts SET burned = burned + ? WHERE id = ?').run(Number(b.amount), b.post_id);
      });
      backoff.delete(`burn:${b.post_id}`);
    } catch (e) {
      failed(`burn:${b.post_id}`, `burn ${b.post_id}`, e as Error);
    }
  }

  // 2. swap what's owed. Skip posts with a burn outstanding so the wallet's token balance stays unambiguous.
  const owed = db.prepare(
    `SELECT q.post_id, q.usd, p.token_address FROM pending_buyback q JOIN posts p ON p.id = q.post_id
     WHERE q.usd >= ? AND p.status = 'live' AND q.post_id NOT IN (SELECT post_id FROM pending_burn)`,
  ).all(minUsdc) as Row[];
  if (!owed.length) return;

  // What the wallet really holds bounds every swap this tick, however much the database thinks is owed.
  let available = Infinity;
  if (opts.balance) {
    try {
      available = (await opts.balance()) - reserveUsdc;
    } catch (e) {
      alert('keeper-balance-unreadable', `keeper could not read the Bankr wallet's USDC balance, so it swapped nothing: ${(e as Error).message}`);
      return;
    }
  }
  const spentToday = () => (db.prepare(`SELECT COALESCE(SUM(usd), 0) s FROM trades WHERE kind = 'buyback' AND created_at > ?`).get(now() - DAY_MS) as { s: number }).s;

  for (const r of owed) {
    if (waiting(`swap:${r.post_id}`)) continue;
    const dailyLeft = maxDailyUsdc - spentToday();
    const usdc = floor6(Math.min(r.usd, maxSwapUsdc, dailyLeft, available));
    if (usdc < minUsdc) {
      // owed >= minUsdc, so a limit is what stopped it: say which one
      if (dailyLeft < minUsdc) alert('keeper-daily-cap', `keeper daily cap reached ($${maxDailyUsdc} in 24h): buybacks are paused until the window rolls over`);
      else if (available < minUsdc) alert('keeper-balance', `Bankr wallet has $${Math.max(0, available).toFixed(2)} spendable USDC but $${r.usd.toFixed(2)} is owed for ${r.post_id}: fees may not be arriving, or Bankr's cut is higher than BANKR_FEE_BPS`);
      continue;
    }
    try {
      const done = await wallet.swap(r.token_address, usdc.toFixed(6));
      available -= usdc;
      const amount = rawToAmount(done.amountReceivedRaw);
      tx(db, () => {
        db.prepare('UPDATE pending_buyback SET usd = usd - ? WHERE post_id = ?').run(usdc, r.post_id);
        db.prepare('UPDATE posts SET buyback_usd = buyback_usd + ? WHERE id = ?').run(usdc, r.post_id);
        // 'buyback' overrides whatever the indexer guessed for this tx, so it never counts as a vouch
        db.prepare(
          `INSERT INTO trades(tx_hash, post_id, wallet, side, usd, tokens, kind, created_at) VALUES(?,?,?,?,?,?, 'buyback', ?)
           ON CONFLICT(tx_hash, post_id) DO UPDATE SET kind = 'buyback'`,
        ).run(done.hash.toLowerCase(), r.post_id, 'bankr', 'buy', usdc, Number(amount), now());
        db.prepare('INSERT INTO pending_burn(post_id, amount) VALUES(?,?)').run(r.post_id, amount);
      });
      const burn = await wallet.burn(r.token_address, amount);
      tx(db, () => {
        db.prepare('DELETE FROM pending_burn WHERE post_id = ?').run(r.post_id);
        db.prepare('UPDATE posts SET burned = burned + ? WHERE id = ?').run(Number(amount), r.post_id);
      });
      backoff.delete(`swap:${r.post_id}`);
      log.log(`${r.token_address}: $${usdc} -> ${amount} tokens (swap ${done.hash}) burned to ${BURN} (${burn.txHash})`);
    } catch (e) {
      failed(`swap:${r.post_id}`, `buyback ${r.post_id}`, e as Error); // balance stays owed; retried with backoff
    }
  }
}

export type KeeperHandle = { stop(): Promise<void> };

export function startKeeper(db: DB, wallet: Wallet, intervalMs: number, opts: KeeperOptions): KeeperHandle {
  const backoff: Backoff = new Map();
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = keeperTick(db, wallet, { ...opts, backoff }).catch((e) => console.error('keeper:', (e as Error).message)).finally(() => { running = null; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  // stop() waits for a swap in flight: never kill the process between a swap and its burn record
  return { async stop() { clearInterval(timer); await running; } };
}
