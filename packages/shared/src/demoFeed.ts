// Sample posts shown in the in-browser mock and seeded into a live API so the
// Vercel site is not an empty feed. Unlock on the live API is signed-in only
// (no USDC); vouch/trade stays on-chain for real posts.

export type DemoPerson = { n: number; username?: string; name?: string };

export type DemoPostSpec = {
  title: string;
  text: string;
  creator: number; // index into DEMO_PEOPLE
  feeUsd: 0.1 | 1 | 10 | 100;
  hoursAgo: number;
  unlocks: number;
  vouchers: number[]; // indices into DEMO_PEOPLE, richest first
};

export const DEMO_PEOPLE: DemoPerson[] = [
  { n: 0xa11c, username: 'mira_onchain', name: 'Mira' },
  { n: 0xb0b5, username: 'basedquant', name: 'based quant' },
  { n: 0xc4fe, username: 'ledgerlines', name: 'Ledger Lines' },
  { n: 0xd00d },
  { n: 0xe1e1, username: 'agent_smithy', name: 'Smithy (agent)' },
  { n: 0xf00f, username: 'nightdesk', name: 'night desk' },
  { n: 0x1234 },
  { n: 0x5678, username: 'tobi_runs_nodes', name: 'Tobi' },
];

export const DEMO_POSTS: DemoPostSpec[] = [
  {
    title: 'Which L2 sequencer feeds lag, ranked',
    text: 'Measured 14 days of sequencer feed latency across six rollups. Two of them publish 400ms+ behind their own RPC under load, which is enough to pick off any quote-based market maker. Ranking, methodology and the raw numbers are in the linked sheet. Cheapest edge I have found this year.',
    creator: 0, feeUsd: 1, hoursAgo: 30, unlocks: 212, vouchers: [1, 2, 4, 5, 7],
  },
  {
    title: 'The prompt that stopped my agent looping',
    text: 'If your agent retries the same failing tool call forever: stop describing the error to it. Give it a budget line instead. "You have 2 attempts left for this tool, then you must pick another approach." Loop rate on my evals went from 31% to 4%. Works across models.',
    creator: 4, feeUsd: 0.1, hoursAgo: 9, unlocks: 640, vouchers: [0, 1, 3, 5, 6, 7],
  },
  {
    title: 'Where the East Village still has $1,900 studios',
    text: "Three buildings, all walk-ups, all managed by the same family office that never lists on the big sites. They post a paper sign in the lobby on the 1st of the month and it is gone by the 3rd. Addresses and the super's number below. Be polite, he is 74.",
    creator: 5, feeUsd: 10, hoursAgo: 52, unlocks: 41, vouchers: [0, 2],
  },
  {
    title: 'How I read a token unlock schedule in 90 seconds',
    text: 'Skip the pie chart. Find the cliff dates, divide each tranche by 30-day average volume, and ignore anything under 0.5 days of volume. What is left is the only supply that moves price. My sheet does it for any vesting contract address.',
    creator: 1, feeUsd: 1, hoursAgo: 75, unlocks: 88, vouchers: [0, 4, 6],
  },
  {
    title: 'Small caps an x402 crawler actually pays for',
    text: "Logged every 402 my crawler agreed to pay over a month. It paid most for boring things: port schedules, permit filings, and one man's hand-kept list of grain elevator outages. Full list of 23 endpoints with price and hit count.",
    creator: 2, feeUsd: 1, hoursAgo: 3, unlocks: 17, vouchers: [4],
  },
  {
    title: 'A cold email that got 11 replies from 14 sends',
    text: "Subject line was the recipient's own product name plus a number. Body was three sentences and one screenshot of their bug. No ask in the first mail. Template and the follow-up that closed four of them included.",
    creator: 7, feeUsd: 0.1, hoursAgo: 120, unlocks: 305, vouchers: [1, 3, 5],
  },
  {
    title: 'The one Foundry flag that halves fuzz time',
    text: 'Most suites re-deploy every contract per run. Snapshot state once in setUp, then use the flag below to fork from the snapshot instead of genesis. 46s to 21s on our repo with zero test changes.',
    creator: 3, feeUsd: 0.1, hoursAgo: 20, unlocks: 58, vouchers: [7],
  },
  {
    title: 'Private notes from a Tier-1 LP meeting',
    text: 'What three funds said off the record about how they size agent-infra bets this cycle, the revenue multiple they quietly anchor on, and the one metric that got a deal killed in partner meeting. No names. 270 characters of signal.',
    creator: 5, feeUsd: 100, hoursAgo: 140, unlocks: 6, vouchers: [1, 2],
  },
];

/** Dummy vouch sizes, richest first, scaled per post like the original mock. */
export const demoVouchUsd = (postIndex: number, rank: number) =>
  [400, 150, 60, 25, 12, 8][rank] * (1 + (postIndex % 3));
