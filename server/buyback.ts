// Buyback-and-burn, driven by the database instead of pending.json: every x402 unlock adds the fee to
// pending_buyback (see service.recordUnlock); this loop swaps batches into the post's token and burns them.
// The Bankr Wallet API calls are the ones in server/keeper.ts, split into swap and burn so a failed burn can be
// retried without swapping twice.
import { BURN, burnTokens, rawToAmount, swapToToken, type SwapDone } from './keeper.ts';
import { tx, type DB } from './db.ts';

export type Wallet = {
  swap(token: string, usdc: string): Promise<SwapDone>;
  burn(token: string, amount: string): Promise<{ txHash: string }>;
};
export const bankrWallet: Wallet = { swap: (token, usdc) => swapToToken(token, usdc), burn: burnTokens };

type Row = { post_id: string; usd: number; token_address: string };

export async function keeperTick(db: DB, wallet: Wallet, minUsdc: number, log = console): Promise<void> {
  // 1. finish burns whose swap already happened
  const burns = db.prepare(`SELECT b.post_id, b.amount, p.token_address FROM pending_burn b JOIN posts p ON p.id = b.post_id`).all() as { post_id: string; amount: string; token_address: string }[];
  for (const b of burns) {
    try {
      await wallet.burn(b.token_address, b.amount);
      tx(db, () => {
        db.prepare('DELETE FROM pending_burn WHERE post_id = ?').run(b.post_id);
        db.prepare('UPDATE posts SET burned = burned + ? WHERE id = ?').run(Number(b.amount), b.post_id);
      });
    } catch (e) {
      log.error(`burn ${b.post_id}:`, (e as Error).message);
    }
  }

  // 2. swap what's owed. Skip posts with a burn outstanding so the wallet's token balance stays unambiguous.
  const owed = db.prepare(
    `SELECT q.post_id, q.usd, p.token_address FROM pending_buyback q JOIN posts p ON p.id = q.post_id
     WHERE q.usd >= ? AND p.status = 'live' AND q.post_id NOT IN (SELECT post_id FROM pending_burn)`,
  ).all(minUsdc) as Row[];

  for (const r of owed) {
    const usdc = Math.floor(r.usd * 1e6) / 1e6;
    try {
      const done = await wallet.swap(r.token_address, usdc.toFixed(6));
      const amount = rawToAmount(done.amountReceivedRaw);
      tx(db, () => {
        db.prepare('UPDATE pending_buyback SET usd = usd - ? WHERE post_id = ?').run(usdc, r.post_id);
        db.prepare('UPDATE posts SET buyback_usd = buyback_usd + ? WHERE id = ?').run(usdc, r.post_id);
        // 'buyback' overrides whatever the indexer guessed for this tx, so it never counts as a vouch
        db.prepare(
          `INSERT INTO trades(tx_hash, post_id, wallet, side, usd, tokens, kind, created_at) VALUES(?,?,?,?,?,?, 'buyback', ?)
           ON CONFLICT(tx_hash, post_id) DO UPDATE SET kind = 'buyback'`,
        ).run(done.hash.toLowerCase(), r.post_id, 'bankr', 'buy', usdc, Number(amount), Date.now());
        db.prepare('INSERT INTO pending_burn(post_id, amount) VALUES(?,?)').run(r.post_id, amount);
      });
      const burn = await wallet.burn(r.token_address, amount);
      tx(db, () => {
        db.prepare('DELETE FROM pending_burn WHERE post_id = ?').run(r.post_id);
        db.prepare('UPDATE posts SET burned = burned + ? WHERE id = ?').run(Number(amount), r.post_id);
      });
      log.log(`${r.token_address}: $${usdc} -> ${amount} tokens (swap ${done.hash}) burned to ${BURN} (${burn.txHash})`);
    } catch (e) {
      log.error(`buyback ${r.post_id}:`, (e as Error).message); // balance stays owed; retried next tick
    }
  }
}

export function startKeeper(db: DB, wallet: Wallet, intervalMs: number, minUsdc: number) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await keeperTick(db, wallet, minUsdc); } finally { busy = false; }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
