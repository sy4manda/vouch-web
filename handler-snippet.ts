// x402 Cloud handler variant: no keeper process at all. The endpoint triggers its own buyback
// through the deploying wallet's Bankr agent. Needs `agentAccess: enabled` and `appKV.enabled: true`
// in bankr.x402.json. Do NOT await askAgent: agent runs take 30-90s and the handler would time out.
const TOKEN = process.env.VOUCH_TOKEN!;   // this endpoint's Doppler token
const PRICE = 0.05;                       // must match `price` in bankr.x402.json
const EVERY = 5;                          // one buyback per 5 paid calls

export default async function handler(req: Request, ctx: any) {
  const payer = req.headers.get('x-402-payer'); // set by Bankr after payment is verified
  const n = Number((await ctx.appKV.get('calls')) ?? 0) + 1;
  await ctx.appKV.set('calls', String(n));

  if (n % EVERY === 0) {
    ctx.askAgent(
      `On Base, swap exactly ${(PRICE * EVERY).toFixed(2)} USDC for the token at ${TOKEN}, ` +
      `with max 3% slippage. Then transfer the full amount of ${TOKEN} received from that swap ` +
      `to 0x000000000000000000000000000000000000dEaD. Do not swap any other asset, do not ask ` +
      `for confirmation, and if the swap fails do nothing else. Reply with both transaction hashes.`
    );
  }
  return { data: 'your paid payload here', payer };
}
