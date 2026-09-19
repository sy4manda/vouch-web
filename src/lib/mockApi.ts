// In-browser stand-in for the backend so the UI is fully clickable without one.
// State lives in memory and is mirrored to localStorage on a best-effort basis.
import { TRADE_FEE } from './types';
import type { Api, CurvePoint, FeeTier, Post, PostDetail, Profile, Quote, SellQuote, Session, Sort, Voucher } from './types';

// ---- curve: price = P0 * (1 + s/S0)^2, USDC-quoted, 1M supply ----
const TOTAL = 1_000_000;
const P0 = 0.0001;
const S0 = 50_000;
const price = (s: number) => P0 * (1 + s / S0) ** 2;
// USDC to move supply a -> b; tokensFor is its inverse.
const cost = (a: number, b: number) => ((P0 * S0) / 3) * ((1 + b / S0) ** 3 - (1 + a / S0) ** 3);
const tokensFor = (s: number, usd: number) => S0 * (Math.cbrt((1 + s / S0) ** 3 + (3 * usd) / (P0 * S0)) - 1) - s;
const curvePoints = (): CurvePoint[] => Array.from({ length: 61 }, (_, i) => ({ supply: (i / 60) * TOTAL * 0.6, priceUsd: price((i / 60) * TOTAL * 0.6) }));

type Row = {
  id: string; title: string; text: string; creator: string; feeUsd: FeeTier; createdAt: number;
  sold: number; burned: number; buybackUsd: number; unlockedBy: string[]; vouches: Record<string, { usd: number; tokens: number }>;
};
type State = { posts: Row[]; profiles: Record<string, Profile>; balances: Record<string, number> };

const addr = (n: number) => '0x' + n.toString(16).padStart(4, '0').repeat(10);
const person = (n: number, username?: string, name?: string): Profile => ({ id: addr(n), wallet: addr(n), x: username ? { username, name: name! } : undefined });

function seed(): State {
  const people = [
    person(0xa11c, 'mira_onchain', 'Mira'), person(0xb0b5, 'basedquant', 'based quant'), person(0xc4fe, 'ledgerlines', 'Ledger Lines'),
    person(0xd00d), person(0xe1e1, 'agent_smithy', 'Smithy (agent)'), person(0xf00f, 'nightdesk', 'night desk'), person(0x1234), person(0x5678, 'tobi_runs_nodes', 'Tobi'),
  ];
  const profiles = Object.fromEntries(people.map((p) => [p.id, p]));
  const H = 3600_000;
  const raw: [string, string, number, FeeTier, number, number, number[]][] = [
    ['Which L2 sequencer feeds lag, ranked', 'Measured 14 days of sequencer feed latency across six rollups. Two of them publish 400ms+ behind their own RPC under load, which is enough to pick off any quote-based market maker. Ranking, methodology and the raw numbers are in the linked sheet. Cheapest edge I have found this year.', 0, 1, 30, 212, [1, 2, 4, 5, 7]],
    ['The prompt that stopped my agent looping', 'If your agent retries the same failing tool call forever: stop describing the error to it. Give it a budget line instead. "You have 2 attempts left for this tool, then you must pick another approach." Loop rate on my evals went from 31% to 4%. Works across models.', 4, 0.1, 9, 640, [0, 1, 3, 5, 6, 7]],
    ['Where the East Village still has $1,900 studios', 'Three buildings, all walk-ups, all managed by the same family office that never lists on the big sites. They post a paper sign in the lobby on the 1st of the month and it is gone by the 3rd. Addresses and the super\'s number below. Be polite, he is 74.', 5, 10, 52, 41, [0, 2]],
    ['How I read a token unlock schedule in 90 seconds', 'Skip the pie chart. Find the cliff dates, divide each tranche by 30-day average volume, and ignore anything under 0.5 days of volume. What is left is the only supply that moves price. My sheet does it for any vesting contract address.', 1, 1, 75, 88, [0, 4, 6]],
    ['Small caps an x402 crawler actually pays for', 'Logged every 402 my crawler agreed to pay over a month. It paid most for boring things: port schedules, permit filings, and one man\'s hand-kept list of grain elevator outages. Full list of 23 endpoints with price and hit count.', 2, 1, 3, 17, [4]],
    ['A cold email that got 11 replies from 14 sends', 'Subject line was the recipient\'s own product name plus a number. Body was three sentences and one screenshot of their bug. No ask in the first mail. Template and the follow-up that closed four of them included.', 7, 0.1, 120, 305, [1, 3, 5]],
    ['The one Foundry flag that halves fuzz time', 'Most suites re-deploy every contract per run. Snapshot state once in setUp, then use the flag below to fork from the snapshot instead of genesis. 46s to 21s on our repo with zero test changes.', 3, 0.1, 20, 58, [7]],
    ['Private notes from a Tier-1 LP meeting', 'What three funds said off the record about how they size agent-infra bets this cycle, the revenue multiple they quietly anchor on, and the one metric that got a deal killed in partner meeting. No names. 270 characters of signal.', 5, 100, 140, 6, [1, 2]],
  ];
  const posts: Row[] = raw.map(([title, text, c, feeUsd, hoursAgo, unlocks, vs], i) => {
    const row: Row = { id: `p${i + 1}`, title, text, creator: people[c].id, feeUsd, createdAt: Date.now() - hoursAgo * H, sold: 0, burned: 0, buybackUsd: 0, unlockedBy: [], vouches: {} };
    vs.forEach((v, k) => applyBuy(row, people[v].id, [400, 150, 60, 25, 12, 8][k] * (1 + (i % 3))));
    for (let u = 0; u < unlocks; u++) applyUnlock(row, u < people.length ? people[u].id : addr(0x9000 + u));
    return row;
  });
  return { posts, profiles, balances: {} };
}

function applyBuy(row: Row, who: string, usd: number) {
  const net = usd * (1 - TRADE_FEE);
  const tokens = tokensFor(row.sold, net);
  row.sold += tokens;
  const v = (row.vouches[who] ??= { usd: 0, tokens: 0 });
  v.usd += usd;
  v.tokens += tokens;
  return tokens;
}
function sellQuote(row: Row, tokens: number): SellQuote {
  const gross = cost(row.sold - tokens, row.sold);
  const feeUsd = gross * TRADE_FEE;
  const after = row.sold - tokens;
  return { tokensIn: tokens, feeUsd, usdOut: gross - feeUsd, priceAfterUsd: price(after), marketCapAfterUsd: price(after) * (TOTAL - row.burned) };
}
function applyUnlock(row: Row, who: string) {
  if (row.unlockedBy.includes(who)) return;
  row.unlockedBy.push(who);
  // 100% of the fixed fee buys the token on the curve; those tokens are burned.
  const tokens = tokensFor(row.sold, row.feeUsd * (1 - TRADE_FEE));
  row.sold += tokens;
  row.burned += tokens;
  row.buybackUsd += row.feeUsd;
}

const KEY = 'vouch.mock.v1';
let state: State = (() => {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return JSON.parse(s) as State;
  } catch { /* storage unavailable */ }
  return seed();
})();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };
export const resetMock = () => { state = seed(); save(); };

const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));

function toPost(r: Row, viewer?: string): Post {
  const v = viewer?.toLowerCase();
  const unlocked = !!v && (r.unlockedBy.includes(v) || r.creator === v);
  return {
    id: r.id, title: r.title, creator: state.profiles[r.creator], feeUsd: r.feeUsd, createdAt: r.createdAt, chars: r.text.length,
    unlocks: r.unlockedBy.length, buybackUsd: r.buybackUsd, vouchers: Object.keys(r.vouches).length,
    priceUsd: price(r.sold), marketCapUsd: price(r.sold) * (TOTAL - r.burned),
    tokenSymbol: 'V' + r.id.toUpperCase(), tokenAddress: addr(0x7000 + Number(r.id.slice(1))), endpointUrl: `https://x402.bankr.bot/demo/${r.id}`,
    unlocked, text: unlocked ? r.text : undefined,
  };
}
const find = (id: string) => {
  const r = state.posts.find((p) => p.id === id);
  if (!r) throw new Error('Post not found');
  return r;
};
const balanceOf = (id: string) => (state.balances[id] ??= 250);
function remember(p: Profile) { state.profiles[p.id] = { ...state.profiles[p.id], ...p }; }

export const mockApi: Api = {
  async listPosts(sort: Sort, viewer) {
    await wait(200);
    const posts = state.posts.map((r) => toPost(r, viewer));
    return posts.sort((a, b) => (sort === 'new' ? b.createdAt - a.createdAt : b.marketCapUsd - a.marketCapUsd));
  },
  async getPost(id, viewer): Promise<PostDetail> {
    await wait(200);
    const r = find(id);
    const topVouchers: Voucher[] = Object.entries(r.vouches)
      .map(([who, v]) => ({ profile: state.profiles[who] ?? { id: who, wallet: who }, ...v }))
      .sort((a, b) => b.usd - a.usd);
    return { ...toPost(r, viewer), curve: curvePoints(), supplySold: r.sold, totalSupply: TOTAL, burned: r.burned, topVouchers, myVouchUsd: (viewer && r.vouches[viewer.toLowerCase()]?.usd) || 0, myTokens: (viewer && r.vouches[viewer.toLowerCase()]?.tokens) || 0 };
  },
  async createPost(input, s: Session) {
    await wait(900);
    remember(s.profile);
    const n = Math.max(0, ...state.posts.map((p) => Number(p.id.slice(1)))) + 1;
    const row: Row = { id: `p${n}`, ...input, creator: s.profile.id, createdAt: Date.now(), sold: 0, burned: 0, buybackUsd: 0, unlockedBy: [], vouches: {} };
    state.posts.push(row);
    save();
    return toPost(row, s.profile.id);
  },
  async unlock(post, s) {
    await wait(900);
    const r = find(post.id);
    if (balanceOf(s.profile.id) < r.feeUsd) throw new Error('Not enough USDC. Fund your wallet first.');
    remember(s.profile);
    state.balances[s.profile.id] -= r.feeUsd;
    applyUnlock(r, s.profile.id);
    save();
    return r.text;
  },
  async quoteBuy(id, usdIn): Promise<Quote> {
    const r = find(id);
    const feeUsd = usdIn * TRADE_FEE;
    const tokensOut = tokensFor(r.sold, usdIn - feeUsd);
    const after = r.sold + tokensOut;
    return { usdIn, feeUsd, tokensOut, priceAfterUsd: price(after), marketCapAfterUsd: price(after) * (TOTAL - r.burned) };
  },
  async buy(id, usdIn, _slippagePct, s) {
    await wait(900);
    if (balanceOf(s.profile.id) < usdIn) throw new Error('Not enough USDC. Fund your wallet first.');
    remember(s.profile);
    state.balances[s.profile.id] -= usdIn;
    applyBuy(find(id), s.profile.id, usdIn);
    save();
  },
  async quoteSell(id, tokens) {
    return sellQuote(find(id), tokens);
  },
  async sell(id, tokens, _slippagePct, s) {
    await wait(900);
    const r = find(id);
    const v = r.vouches[s.profile.id];
    if (!v || tokens > v.tokens * 1.000001) throw new Error("You don't hold that many tokens.");
    const amount = Math.min(tokens, v.tokens);
    const q = sellQuote(r, amount);
    r.sold -= amount;
    v.usd *= 1 - amount / v.tokens; // the leaderboard ranks what is still vouched
    v.tokens -= amount;
    if (v.tokens < 1e-6) delete r.vouches[s.profile.id];
    state.balances[s.profile.id] = balanceOf(s.profile.id) + q.usdOut;
    save();
  },
  async getProfile(key, viewer) {
    await wait(200);
    const k = key.toLowerCase();
    const profile = Object.values(state.profiles).find((p) => p.id === k || p.x?.username.toLowerCase() === k) ?? { id: k, wallet: k };
    return {
      profile,
      created: state.posts.filter((r) => r.creator === profile.id).map((r) => toPost(r, viewer)),
      vouched: state.posts.filter((r) => r.vouches[profile.id]).map((r) => ({ post: toPost(r, viewer), usd: r.vouches[profile.id].usd })).sort((a, b) => b.usd - a.usd),
    };
  },
  async getUsdcBalance(s) { return balanceOf(s.profile.id); },
};

