// Buyback-and-burn keeper using Bankr's Wallet API. No LLM in the loop.
//
// Setup: the endpoints' x402 `payTo` is your Bankr wallet (the default). Create an API key at
// bankr.bot/api-keys with Wallet API write access, add this machine's IP to the key's allowlist,
// and either leave "allowed recipients" empty or add the burn address to it.
//
//   BANKR_API_KEY=... npx tsx server/keeper.ts
//
// pending.json maps token address -> USDC owed to that token's buyback, e.g. {"0xabc...": 0.35}.
// Run standalone, you fill that file. Inside the backend, server/buyback.ts drives the same swap/burn calls from the database.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { formatUnits } from 'viem';

const API = 'https://api.bankr.bot';
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const BURN = '0x000000000000000000000000000000000000dEaD';
const MIN_USDC = Number(process.env.MIN_USDC ?? 0.25); // batch small fees; don't swap dust
const FILE = process.env.PENDING_FILE ?? 'pending.json';

async function bankr(path: string, body: unknown) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'X-API-Key': process.env.BANKR_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export type SwapDone = { hash: string; success: boolean; amountReceived: string; amountReceivedRaw: string };

/** Swap `usdc` (decimal string) from the Bankr wallet into `token`. Throws if the swap reverted. */
export async function swapToToken(token: string, usdc: string, usdcAddress = USDC_BASE): Promise<SwapDone> {
  const swap = { fromChain: 'base', toChain: 'base', fromToken: usdcAddress, toToken: token, amount: usdc, slippageBps: 300 };
  const quote = await bankr('/wallet/swap-quote', swap);
  const done: SwapDone = await bankr('/wallet/swap', { ...swap, minBuyAmount: quote.minBuyAmount, quoteId: quote.quoteId, idempotencyKey: randomUUID() });
  if (!done.success) throw new Error(`swap reverted: ${done.hash}`); // Bankr returns 200 with success:false on revert
  return done;
}

/** Send tokens to the burn address. `amount` is a whole-token decimal string (see rawToAmount). */
export async function burnTokens(token: string, amount: string): Promise<{ txHash: string }> {
  return bankr('/wallet/transfer', { tokenAddress: token, recipientAddress: BURN, amount, isNativeToken: false, chain: 'base' });
}

/** exact raw amount -> decimal string, so float rounding can't ask for more than the wallet holds */
export const rawToAmount = (raw: string) => formatUnits(BigInt(raw), 18);

export async function buybackAndBurn(token: string, usdc: number) {
  const done = await swapToToken(token, usdc.toFixed(6));
  const burn = await burnTokens(token, rawToAmount(done.amountReceivedRaw));
  console.log(`${token}: $${usdc} -> ${done.amountReceived} tokens (swap ${done.hash}) burned (${burn.txHash})`);
}

async function tick() {
  if (!existsSync(FILE)) return;
  const pending: Record<string, number> = JSON.parse(readFileSync(FILE, 'utf8'));
  for (const [token, owed] of Object.entries(pending)) {
    if (owed < MIN_USDC) continue;
    try {
      await buybackAndBurn(token, owed);
      pending[token] = 0;
      writeFileSync(FILE, JSON.stringify(pending, null, 2));
    } catch (e) {
      console.error(token, (e as Error).message); // leave the balance owed, retry next tick
    }
  }
}

// Standalone mode (pending.json). The backend (server/buyback.ts) imports the functions above instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.BANKR_API_KEY) throw new Error('BANKR_API_KEY is not set');
  await tick();
  setInterval(tick, Number(process.env.INTERVAL_MS ?? 30_000));
}
