process.env.WEBHOOK_SECRET ??= 'test-master-secret';
process.env.PUBLIC_API_URL ??= 'https://api.example.test';
process.env.BANKR_WALLET ??= '0x00000000000000000000000000000000000b4a4c';
// the existing suites publish many posts back to back: relax the abuse limits (limit tests set their own)
process.env.POST_COOLDOWN_SEC ??= '0';
process.env.POSTS_PER_USER_PER_DAY ??= '1000';
process.env.POSTS_PER_DAY_TOTAL ??= '100000';

import type { Address, Hex } from 'viem';
import type { AuthUser, Authenticator } from '../src/auth/privy.ts';
import { unauthorized } from '../src/errors.ts';
import type { Chain, ParsedSwap } from '../src/chain/chain.ts';
import { openDb } from '../src/db/db.ts';
import type { EndpointDeployer } from '../src/bankr/deploy.ts';
import type { Deps } from '../src/domain/service.ts';

export const addr = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Address;
export const ALICE: AuthUser = { privyId: 'did:privy:alice', wallet: addr(0xa11ce), wallets: [addr(0xa11ce), addr(0xa11cf)], x: { username: 'alice', name: 'Alice', avatarUrl: 'https://img/a.png' } };
export const BOB: AuthUser = { privyId: 'did:privy:bob', wallet: addr(0xb0b), wallets: [addr(0xb0b)] };

export const testAuth: Authenticator = async (token) => {
  const u = { alice: ALICE, bob: BOB }[token as 'alice' | 'bob'];
  if (!u) throw unauthorized('Invalid or expired session');
  return u;
};

export function fakeChain(over: Partial<Chain> = {}): Chain & { launched: number } {
  let n = 0;
  const c: Chain & { launched: number } = {
    launched: 0,
    async launch() {
      n++;
      c.launched = n;
      return { tokenAddress: addr(0x7000 + n), poolId: ('0x' + n.toString(16).padStart(64, '0')) as Hex, txHash: '0xabc' };
    },
    async quote(_p, side, amountIn) { return side === 'buy' ? amountIn * 1_000_000_000_000n * 100n : amountIn / 100n / 1_000_000_000_000n; },
    async buildTrade(_p, side, wallet, amountIn, minOut) {
      return [{ to: addr(1), data: ('0x' + side + wallet.slice(2) + amountIn.toString(16) + '_' + minOut.toString(16)) as Hex }];
    },
    async swapsInTx() { return []; },
    async swapsInRange() { return []; },
    async blockNumber() { return 100n; },
    async deployerBalance() { return 10n ** 18n; }, // 1 ETH
    async usdcBalance() { return 1_000; },
    async tokenBalance() { return 12.5; },
    ...over,
  };
  return c;
}

export const fakeDeployer = (fail = false): EndpointDeployer & { deployed: { postId: string; text: string }[] } => {
  const deployed: { postId: string; text: string }[] = [];
  return {
    deployed,
    async deploy(o) {
      if (fail) throw new Error('bankr deploy failed: nope');
      deployed.push({ postId: o.postId, text: o.text });
      return `https://x402.bankr.bot/${process.env.BANKR_WALLET}/${o.serviceName}`;
    },
  };
};

export function testDeps(over: { chain?: Chain; deployer?: EndpointDeployer } = {}): Deps {
  return { db: openDb(':memory:'), chain: over.chain ?? fakeChain(), deployer: over.deployer ?? fakeDeployer() };
}

export const swap = (o: Partial<ParsedSwap> & { poolId: string; wallet: string }): ParsedSwap => ({
  txHash: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'), side: 'buy', usd: 10, tokens: 1000, priceUsd: 0.0002, block: 101, ...o,
});

/** Set env vars for the duration of fn (undefined deletes), then restore. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => { for (const [k, x] of Object.entries(v)) x === undefined ? delete process.env[k] : (process.env[k] = x); };
  apply(vars);
  try { return await fn(); } finally { apply(saved); }
}

/** An alerter that records what it was asked to send. */
export const alertSpy = () => {
  const sent: { key: string; message: string }[] = [];
  const fn = (key: string, message: string) => { sent.push({ key, message }); };
  return Object.assign(fn, { sent, keys: () => sent.map((s) => s.key) });
};
