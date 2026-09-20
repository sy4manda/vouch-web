// All runtime configuration comes from env vars. See .env.example.
import type { Address } from 'viem';

// A blank line in .env (copied from .env.example) is an unset variable, not an empty-string value,
// so `env.X ?? default` falls back as intended. Read live, so tests can change process.env.
const env = new Proxy({} as Record<string, string | undefined>, { get: (_t, k: string) => process.env[k]?.trim() || undefined });
const num = (k: string, fallback: number) => {
  const v = Number(env[k] ?? fallback);
  return Number.isFinite(v) ? v : fallback;
};
const req = (k: string) => {
  const v = env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** Everything wrong with the environment, as one list, so a fresh checkout gets all problems at once instead of one per run. */
export function envProblems(): string[] {
  const required = ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'DEPLOYER_PRIVATE_KEY', 'BANKR_WALLET', 'PUBLIC_API_URL', 'WEBHOOK_SECRET'];
  // keeper is the only mode that spends via the Wallet API; agent / off / testnet skip it
  if (env.BUYBACK_MODE !== 'agent' && env.BUYBACK_MODE !== 'off' && env.NETWORK !== 'baseSepolia') required.push('BANKR_API_KEY');
  const problems = required.filter((k) => !env[k]).map((k) => `${k} is not set`);
  const shape = (k: string, re: RegExp, what: string) => {
    if (env[k] && !re.test(env[k]!)) problems.push(`${k} is not a valid ${what}`);
  };
  shape('DEPLOYER_PRIVATE_KEY', PRIVATE_KEY, 'private key (0x + 64 hex characters)');
  shape('BANKR_WALLET', ADDRESS, 'address (0x + 40 hex characters)');
  shape('PROTOCOL_ADDRESS', ADDRESS, 'address (0x + 40 hex characters)');
  // Production must name its frontend: the dev default of `*` would let any site call the API from a user's browser.
  if (process.env.NODE_ENV === 'production' && !env.CORS_ORIGIN) problems.push('CORS_ORIGIN is not set (required in production)');
  return problems;
}

export const config = {
  port: Number(env.PORT ?? 8787),
  /** Comma-separated allowlist (Vercel origin + optional localhost). `*` is the dev default. */
  corsOrigins: () => (env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  dbPath: env.DB_PATH ?? 'data/vouch.db',
  network: (env.NETWORK === 'baseSepolia' ? 'baseSepolia' : 'base') as 'base' | 'baseSepolia',
  rpcUrl: env.RPC_URL,

  privyAppId: () => req('PRIVY_APP_ID'),
  privyAppSecret: () => req('PRIVY_APP_SECRET'),

  /** Platform key: pays gas for launches (we sponsor posting) and is the default protocol fee recipient. */
  deployerKey: () => req('DEPLOYER_PRIVATE_KEY') as `0x${string}`,
  protocolAddress: (fallback: Address) => (env.PROTOCOL_ADDRESS as Address | undefined) ?? fallback,

  /** Bankr wallet that x402 fees are paid to (`payTo`), and the API key that can spend from it. */
  bankrWallet: () => req('BANKR_WALLET') as Address,
  bankrApiKey: () => req('BANKR_API_KEY'),
  /** Where the deployed x402 handler can reach this backend (for unlock webhooks). */
  publicUrl: () => req('PUBLIC_API_URL').replace(/\/$/, ''),
  /** Master secret; each post's handler gets HMAC(master, postId) so one leaked handler can't forge others. */
  webhookSecret: () => req('WEBHOOK_SECRET'),
  x402Dir: env.X402_WORKDIR ?? 'data/x402-build',

  /** keeper: src/bankr/buyback.ts swaps+burns from the DB (default). agent: the x402 handler asks the Bankr agent. off: record fees, do not buy back (hackathon). */
  buybackMode: () => (env.BUYBACK_MODE === 'agent' ? 'agent' : env.BUYBACK_MODE === 'off' ? 'off' : 'keeper') as 'keeper' | 'agent' | 'off',
  agentBuybackEvery: Number(env.AGENT_BUYBACK_EVERY ?? 5),
  // ---- abuse protection (each is read live, so tests and ops can change them without a rebuild)
  /** true behind Caddy or ngrok: the client IP is then the first X-Forwarded-For entry instead of the socket address */
  trustProxy: () => env.TRUST_PROXY === '1',
  rateLimitPerMin: () => num('RATE_LIMIT_PER_MIN', 120),
  postsPerUserPerDay: () => num('POSTS_PER_USER_PER_DAY', 5),
  postsPerDayTotal: () => num('POSTS_PER_DAY_TOTAL', 200),
  postCooldownSec: () => num('POST_COOLDOWN_SEC', 30),
  /** posting sponsors gas: refuse new posts when the deployer holds less ETH than this */
  minDeployerEth: () => num('MIN_DEPLOYER_ETH', 0.002),

  // ---- keeper safety
  keeperMaxSwapUsdc: () => num('KEEPER_MAX_SWAP_USDC', 50),
  keeperMaxDailyUsdc: () => num('KEEPER_MAX_DAILY_USDC', 250),
  /** USDC in the Bankr wallet the keeper must never spend (your own funds if the wallet is shared) */
  keeperReserveUsdc: () => num('KEEPER_RESERVE_USDC', 0),
  /** Bankr's cut of each x402 payment in basis points (500 = 5%); the buyback is queued net of it. Measure with pay-test. */
  bankrFeeBps: () => num('BANKR_FEE_BPS', 0),

  // ---- data safety and alerts
  backupIntervalHours: () => num('BACKUP_INTERVAL_HOURS', 6),
  backupKeep: () => num('BACKUP_KEEP', 14),
  /** Slack- or Discord-compatible incoming webhook; alerts always go to the log too */
  alertWebhookUrl: () => env.ALERT_WEBHOOK_URL,

  keeperIntervalMs: Number(env.KEEPER_INTERVAL_MS ?? 30_000),
  keeperMinUsdc: Number(env.KEEPER_MIN_USDC ?? 0.25),
  indexerIntervalMs: Number(env.INDEXER_INTERVAL_MS ?? 8_000),
  /** First block to scan for a fresh DB. Defaults to "now" so we never scan history. */
  indexerStartBlock: env.INDEXER_START_BLOCK ? BigInt(env.INDEXER_START_BLOCK) : undefined,
};
