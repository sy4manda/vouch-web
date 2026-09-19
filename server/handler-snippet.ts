// The x402 Cloud handler deployed for every post. server/bankr.ts replaces the four quoted __PLACEHOLDERS__
// below (with JSON string literals) and runs `bankr x402 deploy`; it is not imported anywhere.
//
// Bankr runs this only after it has verified the x402 payment. The handler
//   1. tells the backend who paid, so the unlock is remembered forever and the fee is queued for buyback, and
//   2. only then returns the text. If the backend can't be reached it returns an error, which is not settled,
//      so the payer is not charged for an unlock we couldn't record.
//
// BUYBACK_MODE=agent (backend env) adds the no-infrastructure buyback: every few paid calls the backend's
// webhook reply carries { buyback: { token, usdc } } and the handler asks the deploying wallet's Bankr agent
// to swap and burn. That needs `agentAccess: { enabled: true }` in bankr.x402.json (server/bankr.ts adds it).
// Default mode is the keeper (server/buyback.ts, built on server/keeper.ts), which needs no LLM and reports results back to the database.
const HOOK = "__HOOK_URL__";   // backend POST /hooks/unlock
const SECRET = "__SECRET__";   // per-post secret: HMAC(WEBHOOK_SECRET, postId)
const POST_ID = "__POST_ID__";
const TEXT = "__TEXT__";       // the gated 280 characters

export default async function handler(req: Request, ctx: any) {
  const payer = req.headers.get('x-402-payer'); // lowercase wallet address, set by Bankr after payment is verified
  if (!payer) return new Response(JSON.stringify({ error: 'missing payer' }), { status: 400 });

  const eventId = crypto.randomUUID(); // reused across retries, so the backend counts one payment once
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(HOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vouch-secret': SECRET },
        body: JSON.stringify({ postId: POST_ID, payer, eventId }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const { buyback } = (await res.json().catch(() => ({}))) as { buyback?: { token: string; usdc: string } };
      if (buyback && ctx?.askAgent) {
        // Do NOT await: agent runs take 30-90s and the handler would time out.
        void ctx.askAgent(
          `On Base, swap exactly ${buyback.usdc} USDC for the token at ${buyback.token}, ` +
          `with max 3% slippage. Then transfer the full amount of ${buyback.token} received from that swap ` +
          `to 0x000000000000000000000000000000000000dEaD. Do not swap any other asset, do not ask ` +
          `for confirmation, and if the swap fails do nothing else. Reply with both transaction hashes.`,
        ).catch((err: unknown) => console.error(err));
      }
      return { text: TEXT };
    } catch { /* retry */ }
  }
  return new Response(JSON.stringify({ error: 'could not record unlock, you were not charged' }), { status: 502 });
}
