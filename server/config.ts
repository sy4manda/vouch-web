// All runtime configuration comes from env vars. See .env.example.
import type { Address } from 'viem';

// A blank line in .env (copied from .env.example) is an unset variable, not an empty-string value,
// so `env.X ?? default` falls back as intended. Read live, so tests can change process.env.
const env = new Proxy({} as Record<string, string | undefined>, { get: (_t, k: string) => process.env[k]?.trim() || undefined });
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
  if (env.BUYBACK_MODE !== 'agent') required.push('BANKR_API_KEY');
  const problems = required.filter((k) => !env[k]).map((k) => `${k} is not set`);
  const shape = (k: string, re: RegExp, what: string) => {
    if (env[k] && !re.test(env[k]!)) problems.push(`${k} is not a valid ${what}`);
  };
  shape('DEPLOYER_PRIVATE_KEY', PRIVATE_KEY, 'private key (0x + 64 hex characters)');
  shape('BANKR_WALLET', ADDRESS, 'address (0x + 40 hex characters)');
  shape('PROTOCOL_ADDRESS', ADDRESS, 'address (0x + 40 hex characters)');
  return problems;
}

export const config = {
  port: Number(env.PORT ?? 8787),
  corsOrigin: env.CORS_ORIGIN ?? '*',
  dbPath: env.DB_PATH ?? 'vouch.db',
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
  x402Dir: env.X402_WORKDIR ?? '.x402-build',

  /** keeper: server/buyback.ts swaps+burns from the DB (default). agent: the x402 handler asks the Bankr agent instead. */
  buybackMode: (env.BUYBACK_MODE === 'agent' ? 'agent' : 'keeper') as 'keeper' | 'agent',
  agentBuybackEvery: Number(env.AGENT_BUYBACK_EVERY ?? 5),
  keeperIntervalMs: Number(env.KEEPER_INTERVAL_MS ?? 30_000),
  keeperMinUsdc: Number(env.KEEPER_MIN_USDC ?? 0.25),
  indexerIntervalMs: Number(env.INDEXER_INTERVAL_MS ?? 8_000),
  /** First block to scan for a fresh DB. Defaults to "now" so we never scan history. */
  indexerStartBlock: env.INDEXER_START_BLOCK ? BigInt(env.INDEXER_START_BLOCK) : undefined,
};
