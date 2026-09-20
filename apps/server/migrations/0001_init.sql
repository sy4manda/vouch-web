-- Initial schema. Every statement is IF NOT EXISTS so databases created before migrations existed adopt it as-is.
CREATE TABLE IF NOT EXISTS users (
  wallet TEXT PRIMARY KEY,            -- lowercased address: the unique identifier
  privy_id TEXT,
  x_username TEXT, x_name TEXT, x_avatar TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_x ON users(lower(x_username));

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  creator TEXT NOT NULL,
  fee_usd REAL NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,               -- launching | live | failed
  error TEXT,
  service_name TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  symbol TEXT NOT NULL,
  token_address TEXT,
  pool_id TEXT,
  price_usd REAL,                     -- last known pool price, kept fresh by the indexer
  price_block INTEGER NOT NULL DEFAULT 0,
  burned REAL NOT NULL DEFAULT 0,     -- tokens sent to the burn address by the keeper
  buyback_usd REAL NOT NULL DEFAULT 0 -- USDC swapped into the token by the keeper
);
CREATE INDEX IF NOT EXISTS posts_status ON posts(status, created_at);

CREATE TABLE IF NOT EXISTS unlocks (
  post_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, wallet)
);

-- 'vouch' = a user trade on the curve; 'buyback' = the keeper's fee swap (excluded from voucher stats)
CREATE TABLE IF NOT EXISTS trades (
  tx_hash TEXT NOT NULL,
  post_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  side TEXT NOT NULL,                 -- buy | sell
  usd REAL NOT NULL,
  tokens REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'vouch',
  block INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, post_id)
);
CREATE INDEX IF NOT EXISTS trades_post ON trades(post_id, kind);
CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet, kind);

-- USDC collected by x402 unlocks and not yet swapped into the token
CREATE TABLE IF NOT EXISTS pending_buyback (
  post_id TEXT PRIMARY KEY,
  usd REAL NOT NULL DEFAULT 0
);

-- handler webhook dedupe: the x402 handler retries, and a payment must only fund one buyback
CREATE TABLE IF NOT EXISTS unlock_events (event_id TEXT PRIMARY KEY);

-- tokens bought by the keeper that still need to be sent to the burn address (swap ok, burn failed)
CREATE TABLE IF NOT EXISTS pending_burn (
  post_id TEXT PRIMARY KEY,
  amount TEXT NOT NULL               -- decimal string in whole tokens
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
