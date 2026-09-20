// Business logic. Everything the REST layer and the background loops share lives here.
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import type { CurvePoint, Post, PostDetail, Profile, ProfilePage, Quote, SellQuote, Sort, Voucher } from '@vouch/shared';
import { MAX_CHARS, MAX_FEE, MIN_FEE, TRADE_FEE } from '@vouch/shared';
import type { AuthUser } from '../auth/privy.ts';
import { rawToTokens, rawToUsd, tokensToRaw, usdToRaw, type Chain, type ParsedSwap, type PoolRef, type Tx } from '../chain/chain.ts';
import type { EndpointDeployer } from '../bankr/deploy.ts';
import { config } from '../config.ts';
import { alert as realAlert, type Alerter } from '../ops/alert.ts';
import { getMeta, setMeta, tx, type DB } from '../db/db.ts';
import { bad, notFound, tooMany, unavailable } from '../errors.ts';
import { marketCap, priceAtSold, sampleCurve, soldAtPrice, START_PRICE, TOTAL_SUPPLY } from './curve.ts';
import { isDemoPost } from './demoSeed.ts';

type PostRow = {
  id: string; title: string; text: string; creator: string; fee_usd: number; created_at: number; status: string;
  service_name: string; endpoint_url: string; symbol: string; token_address: string | null; pool_id: string | null;
  price_usd: number | null; burned: number; buyback_usd: number;
};

export type Deps = { db: DB; chain: Chain; deployer: EndpointDeployer; /** operator alerts; defaults to the throttled logger/webhook */ alert?: Alerter };

const CURVE = sampleCurve();
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---- profiles ---------------------------------------------------------------------------------------

export function upsertUser(db: DB, u: AuthUser) {
  db.prepare(
    `INSERT INTO users(wallet, privy_id, x_username, x_name, x_avatar, created_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(wallet) DO UPDATE SET privy_id = excluded.privy_id,
       x_username = excluded.x_username, x_name = excluded.x_name, x_avatar = excluded.x_avatar`,
  ).run(u.wallet, u.privyId, u.x?.username ?? null, u.x?.name ?? null, u.x?.avatarUrl ?? null, Date.now());
}

type UserRow = { wallet: string; x_username: string | null; x_name: string | null; x_avatar: string | null };
function toProfile(wallet: string, u?: UserRow): Profile {
  return {
    id: wallet,
    wallet,
    x: u?.x_username ? { username: u.x_username, name: u.x_name ?? u.x_username, avatarUrl: u.x_avatar ?? undefined } : undefined,
  };
}
const profileOf = (db: DB, wallet: string) =>
  toProfile(wallet, db.prepare('SELECT wallet, x_username, x_name, x_avatar FROM users WHERE wallet = ?').get(wallet) as UserRow | undefined);

// ---- post views -------------------------------------------------------------------------------------

type Stats = { unlocks: number; vouchers: number };
function statsFor(db: DB, id: string): Stats {
  const unlocks = (db.prepare('SELECT COUNT(*) c FROM unlocks WHERE post_id = ?').get(id) as { c: number }).c;
  const vouchers = (db.prepare(`SELECT COUNT(DISTINCT wallet) c FROM trades WHERE post_id = ? AND kind = 'vouch' AND side = 'buy'`).get(id) as { c: number }).c;
  return { unlocks, vouchers };
}

function canRead(db: DB, row: PostRow, viewer: string[]): boolean {
  if (viewer.includes(row.creator)) return true;
  if (!viewer.length) return false;
  const q = viewer.map(() => '?').join(',');
  return !!db.prepare(`SELECT 1 FROM unlocks WHERE post_id = ? AND wallet IN (${q})`).get(row.id, ...viewer);
}

function toPost(db: DB, row: PostRow, viewer: string[]): Post {
  const price = row.price_usd ?? START_PRICE;
  const readable = canRead(db, row, viewer);
  const { unlocks, vouchers } = statsFor(db, row.id);
  return {
    id: row.id,
    title: row.title,
    creator: profileOf(db, row.creator),
    feeUsd: row.fee_usd,
    createdAt: row.created_at,
    chars: row.text.length,
    unlocks,
    buybackUsd: row.buyback_usd,
    vouchers,
    marketCapUsd: marketCap(price, row.burned),
    priceUsd: price,
    tokenSymbol: row.symbol,
    tokenAddress: row.token_address ?? '',
    endpointUrl: row.endpoint_url,
    unlocked: readable,
    ...(readable ? { text: row.text } : {}),
    ...(isDemoPost(row) ? { demo: true } : {}),
  };
}

const liveRow = (db: DB, id: string) => {
  const row = db.prepare(`SELECT * FROM posts WHERE id = ? AND status = 'live'`).get(id) as PostRow | undefined;
  if (!row) throw notFound('Post not found');
  return row;
};

export function listPosts(db: DB, sort: Sort, viewer: string[]): Post[] {
  const rows = db.prepare(`SELECT * FROM posts WHERE status = 'live'`).all() as PostRow[];
  const posts = rows.map((r) => toPost(db, r, viewer));
  return sort === 'new' ? posts.sort((a, b) => b.createdAt - a.createdAt) : posts.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
}

export async function getPost({ db, chain }: Deps, id: string, viewer: string[]): Promise<PostDetail> {
  const row = liveRow(db, id);
  const post = toPost(db, row, viewer);
  const rows = db.prepare(
    `SELECT wallet, SUM(usd) usd, SUM(tokens) tokens FROM trades WHERE post_id = ? AND kind = 'vouch' AND side = 'buy'
     GROUP BY wallet ORDER BY usd DESC LIMIT 25`,
  ).all(id) as { wallet: string; usd: number; tokens: number }[];
  const topVouchers: Voucher[] = rows.map((r) => ({ profile: profileOf(db, r.wallet), usd: r.usd, tokens: r.tokens }));

  let myVouchUsd = 0;
  let myTokens = 0;
  if (viewer.length) {
    const q = viewer.map(() => '?').join(',');
    myVouchUsd = (db.prepare(`SELECT COALESCE(SUM(usd),0) u FROM trades WHERE post_id = ? AND kind='vouch' AND side='buy' AND wallet IN (${q})`).get(id, ...viewer) as { u: number }).u;
    if (row.token_address && !isDemoPost(row)) {
      const balances = await Promise.all(viewer.map((w) => chain.tokenBalance(row.token_address as Address, w as Address).catch(() => 0)));
      myTokens = balances.reduce((a, b) => a + b, 0);
    }
  }
  const curve: CurvePoint[] = CURVE;
  return { ...post, curve, supplySold: soldAtPrice(post.priceUsd), totalSupply: TOTAL_SUPPLY, burned: row.burned, topVouchers, myVouchUsd, myTokens };
}

export function getProfile(db: DB, key: string, viewer: string[]): ProfilePage {
  const k = key.toLowerCase().replace(/^@/, '');
  const user = (/^0x[0-9a-f]{40}$/.test(k)
    ? db.prepare('SELECT wallet, x_username, x_name, x_avatar FROM users WHERE wallet = ?').get(k)
    : db.prepare('SELECT wallet, x_username, x_name, x_avatar FROM users WHERE lower(x_username) = ?').get(k)) as UserRow | undefined;
  if (!user && !/^0x[0-9a-f]{40}$/.test(k)) throw notFound('Profile not found');
  const wallet = user?.wallet ?? k;

  const created = (db.prepare(`SELECT * FROM posts WHERE creator = ? AND status = 'live' ORDER BY created_at DESC`).all(wallet) as PostRow[]).map((r) => toPost(db, r, viewer));
  const vouchedRows = db.prepare(
    `SELECT post_id, SUM(usd) usd FROM trades WHERE wallet = ? AND kind = 'vouch' AND side = 'buy' GROUP BY post_id ORDER BY usd DESC`,
  ).all(wallet) as { post_id: string; usd: number }[];
  const vouched = vouchedRows.flatMap((v) => {
    const row = db.prepare(`SELECT * FROM posts WHERE id = ? AND status = 'live'`).get(v.post_id) as PostRow | undefined;
    return row ? [{ post: toPost(db, row, viewer), usd: v.usd }] : [];
  });
  return { profile: toProfile(wallet, user), created, vouched };
}

// ---- creating a post --------------------------------------------------------------------------------

export function validateNewPost(input: { title?: unknown; text?: unknown; feeUsd?: unknown }) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const fee = Number(input.feeUsd);
  if (!title || title.length > 80) throw bad('Title is required and must be 80 characters or fewer');
  if (!text || [...text].length > MAX_CHARS) throw bad(`Text is required and must be ${MAX_CHARS} characters or fewer`);
  if (!Number.isFinite(fee) || fee < MIN_FEE || fee > MAX_FEE || Math.abs(fee * 1000 - Math.round(fee * 1000)) > 1e-6) {
    throw bad(`Fee must be between $${MIN_FEE} and $${MAX_FEE} with at most three decimals`);
  }
  return { title, text, feeUsd: round3(fee) };
}

const symbolFor = (title: string) => title.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'VOUCH';

// Launches and deploys are serialized: they share the deployer key's nonce and Bankr's deploy rate limit.
let creating: Promise<unknown> = Promise.resolve();
/** Resolves when no publish is in flight: shutdown waits on it so a launch isn't cut off between deploy and launch. */
export const publishing = () => creating.catch(() => undefined);

export function createPost(deps: Deps, user: AuthUser, input: { title?: unknown; text?: unknown; feeUsd?: unknown }): Promise<Post> {
  const run = creating.then(() => doCreate(deps, user, input));
  creating = run.catch(() => undefined);
  return run;
}

const DAY_MS = 86_400_000;

/**
 * Publishing is sponsored (the deployer pays gas per token), so it is the expensive thing to abuse. Limits per
 * wallet: a cooldown and a daily cap; and one daily cap for the whole app. Posts that failed before any token was
 * launched cost no gas, so they don't count against the daily caps (they still trigger the cooldown).
 */
export function enforcePostLimits(db: DB, wallet: string, notify: Alerter = realAlert, now = Date.now()) {
  const counted = `(status != 'failed' OR token_address IS NOT NULL) AND created_at > ?`;
  const total = (db.prepare(`SELECT COUNT(*) c FROM posts WHERE ${counted}`).get(now - DAY_MS) as { c: number }).c;
  if (total >= config.postsPerDayTotal()) {
    notify('posts-daily-cap', `daily post cap reached (${config.postsPerDayTotal()}): new posts are refused until the window rolls over`);
    throw unavailable('Posting is at capacity today. Please try again later.', 3600);
  }
  const mine = db.prepare(`SELECT COUNT(*) c, MIN(created_at) oldest FROM posts WHERE creator = ? AND ${counted}`).get(wallet, now - DAY_MS) as { c: number; oldest: number | null };
  if (mine.c >= config.postsPerUserPerDay()) {
    throw tooMany(`You can publish ${config.postsPerUserPerDay()} posts per day. Try again later.`, Math.max(60, Math.ceil(((mine.oldest ?? now) + DAY_MS - now) / 1000)));
  }
  const last = (db.prepare('SELECT MAX(created_at) t FROM posts WHERE creator = ?').get(wallet) as { t: number | null }).t;
  const wait = last ? Math.ceil((last + config.postCooldownSec() * 1000 - now) / 1000) : 0;
  if (wait > 0) throw tooMany(`Wait ${wait}s before publishing again.`, wait);
}

/** Limits, then the deployer's gas balance: refuse cleanly instead of failing halfway through a launch. */
async function guardPosting({ db, chain, alert: notify = realAlert }: Deps, wallet: string) {
  enforcePostLimits(db, wallet, notify);
  const min = BigInt(Math.round(config.minDeployerEth() * 1e18));
  if ((await chain.deployerBalance()) < min) {
    notify('deployer-low', `deployer balance is below ${config.minDeployerEth()} ETH: new posts are refused until it is topped up`);
    throw unavailable('Posting is temporarily unavailable. Please try again later.', 300);
  }
}

async function doCreate(deps: Deps, user: AuthUser, input: { title?: unknown; text?: unknown; feeUsd?: unknown }): Promise<Post> {
  const { db, chain, deployer, alert: notify = realAlert } = deps;
  const { title, text, feeUsd } = validateNewPost(input);
  await guardPosting(deps, user.wallet);
  upsertUser(db, user);
  const id = randomBytes(5).toString('hex');
  const serviceName = `vouch-${id}`;
  const symbol = symbolFor(title);

  db.prepare(
    `INSERT INTO posts(id, title, text, creator, fee_usd, created_at, status, service_name, endpoint_url, symbol) VALUES(?,?,?,?,?,?, 'launching', ?, '', ?)`,
  ).run(id, title, text, user.wallet, feeUsd, Date.now(), serviceName, symbol);

  let launched: { tokenAddress: string; poolId: string } | undefined;
  try {
    // Endpoint first: it is free and invisible until the post goes live, whereas a launched token with no endpoint is not.
    const endpointUrl = await deployer.deploy({ postId: id, serviceName, text, feeUsd });
    db.prepare('UPDATE posts SET endpoint_url = ? WHERE id = ?').run(endpointUrl, id);
    launched = await chain.launch({ name: title.slice(0, 32), symbol, tokenURI: endpointUrl, owner: user.wallet as Address });
    db.prepare(`UPDATE posts SET token_address = ?, pool_id = ?, price_usd = ?, status = 'live' WHERE id = ?`)
      .run(launched.tokenAddress.toLowerCase(), launched.poolId.toLowerCase(), START_PRICE, id);
  } catch (e) {
    // A token that exists on-chain but never went live can't be found again by the app: tell the operator where it is.
    if (launched) notify(`orphan-${id}`, `post ${id}: token ${launched.tokenAddress} (pool ${launched.poolId}) was launched but the post could not go live (${(e as Error).message}). Repair by hand.`);
    db.prepare(`UPDATE posts SET status = 'failed', error = ? WHERE id = ?`).run((e as Error).message.slice(0, 500), id);
    throw new Error(`Could not publish your post: ${(e as Error).message}`);
  }
  return toPost(db, liveRow(db, id), [user.wallet]);
}

// ---- unlocks (called by the x402 handler) -----------------------------------------------------------

export type Buyback = { token: string; usdc: string };

/**
 * The handler saw a verified payment. Remember the payer forever and queue the fee for buyback. Idempotent
 * per eventId. In agent mode, once enough fees have piled up the reply asks the handler to fire the buyback.
 */
export function recordUnlock(db: DB, o: { postId: string; payer: string; eventId: string }): { newUnlock: boolean; buyback?: Buyback } {
  const payer = o.payer.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(payer)) throw bad('bad payer');
  if (!o.eventId) throw bad('missing eventId');
  return tx(db, () => {
    const row = db.prepare(`SELECT fee_usd, token_address FROM posts WHERE id = ? AND status = 'live'`).get(o.postId) as { fee_usd: number; token_address: string } | undefined;
    if (!row) throw notFound('Post not found');
    if (db.prepare('INSERT OR IGNORE INTO unlock_events(event_id) VALUES(?)').run(o.eventId).changes === 0) return { newUnlock: false };
    const inserted = db.prepare('INSERT OR IGNORE INTO unlocks(post_id, wallet, created_at) VALUES(?,?,?)').run(o.postId, payer, Date.now()).changes > 0;
    // every payment is real USDC in the Bankr wallet, even a repeat payer's, so it always funds a buyback.
    // Queue what actually arrived: the fee minus Bankr's cut, so the keeper never plans to spend money it wasn't paid.
    const net = row.fee_usd * (1 - config.bankrFeeBps() / 10_000);
    db.prepare('INSERT INTO pending_buyback(post_id, usd) VALUES(?,?) ON CONFLICT(post_id) DO UPDATE SET usd = usd + excluded.usd').run(o.postId, net);

    if (config.buybackMode() === 'agent') {
      const { usd } = db.prepare('SELECT usd FROM pending_buyback WHERE post_id = ?').get(o.postId) as { usd: number };
      if (usd >= net * config.agentBuybackEvery - 1e-9) {
        db.prepare('UPDATE pending_buyback SET usd = 0 WHERE post_id = ?').run(o.postId);
        // the agent's result isn't reported back, so buyback_usd/burned don't move in this mode
        return { newUnlock: inserted, buyback: { token: row.token_address, usdc: Number(usd.toFixed(6)).toString() } };
      }
    }
    return { newUnlock: inserted };
  });
}

/** Signed-in unlock for seeded sample posts. No USDC moves and the keeper is not queued. */
export function recordDemoUnlock(db: DB, user: AuthUser, id: string): { text: string } {
  const row = liveRow(db, id);
  if (!isDemoPost(row)) throw bad('Pay the unlock fee at the post endpoint');
  db.prepare('INSERT OR IGNORE INTO unlocks(post_id, wallet, created_at) VALUES(?,?,?)').run(id, user.wallet, Date.now());
  return { text: row.text };
}

// ---- trading ----------------------------------------------------------------------------------------

const poolRef = (r: PostRow): PoolRef => ({ tokenAddress: r.token_address as Address, poolId: r.pool_id as Hex });

function parseAmount(v: unknown, what: string, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw bad(`Enter a valid ${what}`);
  return n;
}

function requireOnchain(row: PostRow) {
  if (isDemoPost(row) || !row.pool_id || !row.token_address) {
    throw bad('This sample post is not on-chain. Unlock still works.');
  }
}

export async function quoteBuy({ db, chain }: Deps, id: string, usdIn: unknown): Promise<Quote> {
  const row = liveRow(db, id);
  requireOnchain(row);
  const usd = parseAmount(usdIn, 'dollar amount', 1_000_000);
  const out = rawToTokens(await chain.quote(poolRef(row), 'buy', usdToRaw(usd)));
  const sold = soldAtPrice(row.price_usd ?? START_PRICE);
  const priceAfter = priceAtSold(sold + out);
  return { usdIn: usd, feeUsd: usd * TRADE_FEE, tokensOut: out, priceAfterUsd: priceAfter, marketCapAfterUsd: marketCap(priceAfter, row.burned) };
}

export async function quoteSell({ db, chain }: Deps, id: string, tokensIn: unknown): Promise<SellQuote> {
  const row = liveRow(db, id);
  requireOnchain(row);
  const tokens = parseAmount(tokensIn, 'token amount', TOTAL_SUPPLY);
  const usdOut = rawToUsd(await chain.quote(poolRef(row), 'sell', tokensToRaw(tokens)));
  const sold = soldAtPrice(row.price_usd ?? START_PRICE);
  const priceAfter = priceAtSold(Math.max(0, sold - tokens));
  return { tokensIn: tokens, feeUsd: (usdOut / (1 - TRADE_FEE)) * TRADE_FEE, usdOut, priceAfterUsd: priceAfter, marketCapAfterUsd: marketCap(priceAfter, row.burned) };
}

export async function buildTrade(
  { db, chain }: Deps, user: AuthUser, id: string, side: 'buy' | 'sell',
  body: { usd?: unknown; tokens?: unknown; slippageBps?: unknown; wallet?: unknown },
): Promise<{ transactions: Tx[] }> {
  const row = liveRow(db, id);
  requireOnchain(row);
  const wallet = String(body.wallet ?? '').toLowerCase();
  if (!user.wallets.includes(wallet)) throw bad('That wallet is not linked to your account');
  const bps = body.slippageBps === undefined ? 300 : Number(body.slippageBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw bad('Invalid slippage');

  const amountIn = side === 'buy' ? usdToRaw(parseAmount(body.usd, 'dollar amount', 1_000_000)) : tokensToRaw(parseAmount(body.tokens, 'token amount', TOTAL_SUPPLY));
  const quoted = await chain.quote(poolRef(row), side, amountIn);
  const minOut = (quoted * BigInt(10_000 - bps)) / 10_000n; // the swap reverts on-chain rather than fill worse than this
  return { transactions: await chain.buildTrade(poolRef(row), side, wallet as Address, amountIn, minOut) };
}

// ---- indexing swaps ---------------------------------------------------------------------------------

const bankrWalletLower = () => (process.env.BANKR_WALLET ?? '').toLowerCase();

const livePools = (db: DB) =>
  (db.prepare(`SELECT token_address, pool_id FROM posts WHERE status = 'live' AND pool_id IS NOT NULL`).all() as { token_address: string; pool_id: string }[])
    .map((p) => ({ tokenAddress: p.token_address as Address, poolId: p.pool_id as Hex }));

/** Store swaps as vouches and refresh each pool's price. Idempotent: safe to run on the same tx twice. */
export function applySwaps(db: DB, swaps: ParsedSwap[]): number {
  let recorded = 0;
  tx(db, () => {
    for (const s of swaps) {
      const post = db.prepare('SELECT id FROM posts WHERE pool_id = ?').get(s.poolId) as { id: string } | undefined;
      if (!post) continue;
      const kind = s.wallet === bankrWalletLower() ? 'buyback' : 'vouch';
      const r = db.prepare(
        `INSERT OR IGNORE INTO trades(tx_hash, post_id, wallet, side, usd, tokens, kind, block, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(s.txHash, post.id, s.wallet, s.side, s.usd, s.tokens, kind, s.block, Date.now());
      recorded += Number(r.changes);
      // the newest block's price wins
      db.prepare('UPDATE posts SET price_usd = ?, price_block = ? WHERE id = ? AND price_block <= ?').run(s.priceUsd, s.block, post.id, s.block);
    }
  });
  return recorded;
}

export async function indexTx({ db, chain }: Deps, hash: Hex): Promise<number> {
  return applySwaps(db, await chain.swapsInTx(hash, livePools(db)));
}

/** One indexer pass: everything since the last cursor, in chunks the RPC will accept. */
export async function indexerTick({ db, chain }: Deps, startBlock: bigint | undefined, chunk = 1500n): Promise<void> {
  const head = await chain.blockNumber();
  let cursor = getMeta(db, 'indexer_block') ? BigInt(getMeta(db, 'indexer_block')!) : (startBlock ?? head);
  while (cursor < head) {
    const to = cursor + chunk < head ? cursor + chunk : head;
    applySwaps(db, await chain.swapsInRange(cursor + 1n, to, livePools(db)));
    setMeta(db, 'indexer_block', to.toString());
    cursor = to;
  }
  if (!getMeta(db, 'indexer_block')) setMeta(db, 'indexer_block', head.toString());
}
