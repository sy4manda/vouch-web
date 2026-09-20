// Shapes shared by the UI, the mock API and the real backend. See README for the REST contract.

/** Unlock fee in USD. The composer offers presets plus a custom amount within these bounds. */
export type FeeTier = number;
export const FEE_TIERS: FeeTier[] = [0.1, 1, 10, 100];
export const MIN_FEE = 0.001; // Bankr's platform minimum price; keep at most 3 decimals (server, composer and Bankr price all assume it)
export const MAX_FEE = 1000;
export const MAX_CHARS = 280;
export const TRADE_FEE = 0.025; // 2.5% on every buy and sell on the curve
export const CREATOR_FEE_SHARE = 0.8; // share of that fee paid to the post's creator
export const SLIPPAGE_PRESETS = [1, 3, 5, 10]; // percent
export const DEFAULT_SLIPPAGE = 3;

export type Profile = {
  id: string; // lowercased wallet address: the unique identifier for unlocks and vouches
  wallet: string;
  x?: { username: string; name: string; avatarUrl?: string };
};

export type Post = {
  id: string;
  title: string;
  creator: Profile;
  feeUsd: FeeTier;
  createdAt: number; // ms
  chars: number; // length of the gated text, so the blur placeholder has the right size
  unlocks: number; // unique addresses that paid to unlock
  buybackUsd: number; // total fees routed into the curve and burned
  vouchers: number; // unique addresses that bought the token
  marketCapUsd: number;
  priceUsd: number;
  tokenSymbol: string;
  tokenAddress: string;
  endpointUrl: string; // Bankr x402 Cloud endpoint that serves the text
  unlocked: boolean; // for the current viewer
  text?: string; // only present when unlocked (or the viewer is the creator)
  /** Seeded sample post: unlock is signed-in, not an on-chain x402 payment. */
  demo?: boolean;
};

export type CurvePoint = { supply: number; priceUsd: number };
export type Voucher = { profile: Profile; usd: number; tokens: number };

export type PostDetail = Post & {
  curve: CurvePoint[]; // the whole curve, sampled
  supplySold: number; // current position on the curve
  totalSupply: number;
  burned: number;
  topVouchers: Voucher[]; // ranked by usd
  myVouchUsd: number;
  myTokens: number; // viewer's sellable balance of this post's token
};

export type Quote = { usdIn: number; feeUsd: number; tokensOut: number; priceAfterUsd: number; marketCapAfterUsd: number };

export type SellQuote = { tokensIn: number; feeUsd: number; usdOut: number; priceAfterUsd: number; marketCapAfterUsd: number };

export type ProfilePage = { profile: Profile; created: Post[]; vouched: { post: Post; usd: number }[] };

export type Sort = 'trending' | 'new';

/** What the auth layer hands to API calls that need the user. */
export type Session = {
  profile: Profile;
  getAccessToken: () => Promise<string | null>;
  /** viem WalletClient for the user's wallet; undefined in demo mode. */
  getWalletClient: () => Promise<unknown | undefined>;
};

export interface Api {
  listPosts(sort: Sort, viewer?: string): Promise<Post[]>;
  getPost(id: string, viewer?: string): Promise<PostDetail>;
  createPost(input: { title: string; text: string; feeUsd: FeeTier }, s: Session): Promise<Post>;
  unlock(post: Post, s: Session): Promise<string>;
  quoteBuy(id: string, usd: number): Promise<Quote>;
  /** slippagePct: the trade must revert rather than fill worse than the quote by more than this. */
  buy(id: string, usd: number, slippagePct: number, s: Session): Promise<void>;
  quoteSell(id: string, tokens: number): Promise<SellQuote>;
  sell(id: string, tokens: number, slippagePct: number, s: Session): Promise<void>;
  getProfile(idOrUsername: string, viewer?: string): Promise<ProfilePage>;
  getUsdcBalance(s: Session): Promise<number>;
}

export { DEMO_PEOPLE, DEMO_POSTS, demoVouchUsd } from './demoFeed.ts';
export type { DemoPerson, DemoPostSpec } from './demoFeed.ts';
