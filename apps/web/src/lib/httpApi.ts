// Real backend adapter. Reads and writes go to VITE_API_URL; unlocks pay the post's
// Bankr x402 endpoint straight from the user's wallet. REST contract: see README.
import { wrapFetchWithPayment } from 'x402-fetch';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import type { Api, Post, PostDetail, ProfilePage, Quote, SellQuote, Session } from '@vouch/shared';

const BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const publicClient = createPublicClient({ chain: base, transport: http(import.meta.env.VITE_BASE_RPC_URL) });

// Reads (feed, post, profile) also carry the token when signed in: the backend only serves unlocked text
// to a verified wallet, not to whatever address the `viewer` query param names.
let readToken: (() => Promise<string | null>) | null = null;
export const setReadTokenGetter = (fn: (() => Promise<string | null>) | null) => { readToken = fn; };

async function call<T>(path: string, init: RequestInit = {}, s?: Session): Promise<T> {
  const token = s ? await s.getAccessToken() : await readToken?.().catch(() => null) ?? null;
  const res = await fetch(BASE_URL + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`);
  return res.json();
}
const q = (viewer?: string) => (viewer ? `viewer=${viewer}` : '');

async function trade(id: string, side: 'buy' | 'sell', body: object, s: Session) {
  const wallet = (await s.getWalletClient()) as { sendTransaction: (tx: object) => Promise<`0x${string}`> } | undefined;
  if (!wallet) throw new Error('No wallet connected');
  const { transactions } = await call<{ transactions: { to: `0x${string}`; data: `0x${string}`; value?: string }[] }>(
    `/posts/${id}/${side}`, { method: 'POST', body: JSON.stringify({ ...body, wallet: s.profile.wallet }) }, s);
  let hash: `0x${string}` | undefined;
  for (const tx of transactions) {
    hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined, chain: base });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  await call(`/posts/${id}/${side}/confirm`, { method: 'POST', body: JSON.stringify({ hash }) }, s);
}

export const httpApi: Api = {
  listPosts: (sort, viewer) => call<Post[]>(`/posts?sort=${sort}&${q(viewer)}`),
  getPost: (id, viewer) => call<PostDetail>(`/posts/${id}?${q(viewer)}`),
  createPost: (input, s) => call<Post>('/posts', { method: 'POST', body: JSON.stringify(input) }, s),

  // The human "connector" for x402: Bankr's endpoint answers 402 with the price, x402-fetch has the
  // user's wallet sign a USDC authorization, retries, and the endpoint returns the text. The Bankr
  // handler sees the payer in the `x-402-payer` header and records the unlock for that wallet.
  async unlock(post, s) {
    const wallet = await s.getWalletClient();
    if (!wallet) throw new Error('No wallet connected');
    const maxAtomic = BigInt(Math.round(post.feeUsd * 1e6)); // never sign for more than the listed fee
    const pay = wrapFetchWithPayment(fetch, wallet as Parameters<typeof wrapFetchWithPayment>[1], maxAtomic);
    const res = await pay(post.endpointUrl, { method: 'GET' });
    if (!res.ok) throw new Error(`Unlock failed (${res.status})`);
    const body = await res.json();
    return body.text as string;
  },

  quoteBuy: (id, usd) => call<Quote>(`/posts/${id}/quote?usd=${usd}`),

  // The backend owns the curve integration: it returns the transactions to send (approval, then the
  // trade, with the slippage limit encoded), so this file doesn't care which curve is underneath.
  buy: (id, usd, slippagePct, s) => trade(id, 'buy', { usd, slippageBps: Math.round(slippagePct * 100) }, s),
  quoteSell: (id, tokens) => call<SellQuote>(`/posts/${id}/sell-quote?tokens=${tokens}`),
  sell: (id, tokens, slippagePct, s) => trade(id, 'sell', { tokens, slippageBps: Math.round(slippagePct * 100) }, s),

  getProfile: (key, viewer) => call<ProfilePage>(`/profiles/${key}?${q(viewer)}`),

  async getUsdcBalance(s) {
    const raw = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [s.profile.wallet as `0x${string}`] });
    return Number(formatUnits(raw, 6));
  },
};
