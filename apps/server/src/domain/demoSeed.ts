// Seed the mock feed into SQLite so a Vercel frontend talking to this API is not empty.
import { DEMO_PEOPLE, DEMO_POSTS, TRADE_FEE, demoVouchUsd } from '@vouch/shared';
import { priceAtSold, tokensForUsd } from './curve.ts';
import { getMeta, setMeta, type DB } from '../db/db.ts';

export const DEMO_ENDPOINT = 'demo';
export const isDemoPost = (row: { id: string; endpoint_url?: string | null }) =>
  row.id.startsWith('demo') || row.endpoint_url === DEMO_ENDPOINT;

const META = 'demo_feed';
const VERSION = 'v1';
const HOUR = 3600_000;

const walletOf = (n: number) => ('0x' + n.toString(16).padStart(40, '0')).toLowerCase();
const symbolFor = (title: string) => title.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'VOUCH';
const txHash = (postId: string, wallet: string) =>
  ('0x' + (postId + wallet.slice(2)).replace(/[^0-9a-f]/gi, '0').padEnd(64, '0').slice(0, 64)).toLowerCase();

export function seedDemoFeed(db: DB, now = Date.now()): number {
  if (getMeta(db, META) === VERSION) return 0;
  const people = DEMO_PEOPLE.map((p) => ({
    wallet: walletOf(p.n),
    username: p.username ?? null,
    name: p.name ?? null,
  }));

  const insertUser = db.prepare(
    `INSERT INTO users(wallet, privy_id, x_username, x_name, x_avatar, created_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(wallet) DO UPDATE SET x_username = excluded.x_username, x_name = excluded.x_name`,
  );
  for (const p of people) {
    insertUser.run(p.wallet, `did:privy:demo:${p.wallet.slice(2, 10)}`, p.username, p.name, null, now);
  }

  const insertPost = db.prepare(
    `INSERT OR IGNORE INTO posts(id, title, text, creator, fee_usd, created_at, status, service_name, endpoint_url, symbol, token_address, price_usd, burned, buyback_usd)
     VALUES(?,?,?,?,?,?, 'live', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertUnlock = db.prepare('INSERT OR IGNORE INTO unlocks(post_id, wallet, created_at) VALUES(?,?,?)');
  const insertTrade = db.prepare(
    `INSERT OR IGNORE INTO trades(tx_hash, post_id, wallet, side, usd, tokens, kind, block, created_at) VALUES(?,?,?,'buy',?,?,'vouch',0,?)`,
  );

  for (const [i, spec] of DEMO_POSTS.entries()) {
    const id = `demo${String(i + 1).padStart(2, '0')}`;
    const creator = people[spec.creator].wallet;
    const createdAt = now - spec.hoursAgo * HOUR;
    const buys: { wallet: string; usd: number; tokens: number }[] = [];
    const unlockedBy: string[] = [];
    let sold = 0;
    let burned = 0;

    for (const [k, vi] of spec.vouchers.entries()) {
      const usd = demoVouchUsd(i, k);
      const tokens = tokensForUsd(sold, usd * (1 - TRADE_FEE));
      sold += tokens;
      buys.push({ wallet: people[vi].wallet, usd, tokens });
    }
    for (let u = 0; u < spec.unlocks; u++) {
      unlockedBy.push(u < people.length ? people[u].wallet : walletOf(0x9000 + u));
      const tokens = tokensForUsd(sold, spec.feeUsd * (1 - TRADE_FEE));
      sold += tokens;
      burned += tokens;
    }

    insertPost.run(
      id, spec.title, spec.text, creator, spec.feeUsd, createdAt, `vouch-${id}`, DEMO_ENDPOINT,
      symbolFor(spec.title), walletOf(0x7000 + i + 1), priceAtSold(sold), burned, spec.feeUsd * spec.unlocks,
    );
    for (const b of buys) insertTrade.run(txHash(id, b.wallet), id, b.wallet, b.usd, b.tokens, createdAt);
    for (const who of unlockedBy) insertUnlock.run(id, who, createdAt);
  }

  setMeta(db, META, VERSION);
  return DEMO_POSTS.length;
}
