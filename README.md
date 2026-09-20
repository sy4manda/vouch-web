# vouch

Pay-to-unlock 280-character posts. Each post has a token on a Doppler bonding curve; the feed is ranked by that token’s market cap (**vouch**).

## Premise

Useful writing should be gated, priced, and ranked by a market—not by an opaque feed algorithm.

A creator **gates** up to 280 characters behind a fixed USDC fee. Unlocking pays that fee once (access is forever). 100% of unlock fees buy the post’s token on its curve and burn it. **Vouch** is buying that token with USDC: a public bet that others will unlock too. A 2.5% fee on curve trades splits 80% to the creator, 15% to the platform, 5% to Doppler.

Humans and agents hit the same Bankr x402 Cloud endpoint. Privy is login and the embedded Base wallet.

## What this hopes to achieve

- A feed where market cap is the ranking signal.
- Creators earn from unlock demand (buyback/burn) and from vouches (curve fees).
- One wallet identity (Privy) for X or email, used for unlock, vouch, and gating.

## Project structure

```
vouch-web/
├── apps/web/          Vite + React + TypeScript SPA (Vercel)
├── apps/server/       Hono + SQLite API (locally, via ngrok)
│   ├── src/http       REST
│   ├── src/domain     posts, unlocks, quotes, indexer
│   ├── src/chain      Doppler launch + Universal Router trades
│   ├── src/bankr      x402 handler deploy + buyback keeper
│   ├── src/auth       Privy token → wallet + X profile
│   └── data/          SQLite (gitignored)
├── packages/shared/   types/constants (`@vouch/shared`)
├── scripts/           `npm run hackathon` (API + ngrok)
└── vercel.json        
```

```
browser  →  Vercel (SPA)  →  ngrok  →  API :8787  →  SQLite
                 │                         ├── Privy (auth, embedded wallet)
                 │                         ├── Bankr (x402 endpoints, optional keeper)
                 └── Privy login           └── Base (Doppler launch; deployer pays gas)
```

## Production demo

**https://vouch-web-app.vercel.app** is a demo, not a full mainnet product.

| Works now | Does not |
|---|---|
| Sign in with **X** or **email** (Privy). Embedded Base wallets when Privy creates one. | **Vouch** / buy / sell — sample posts have no live pool. No on-chain USDC trades. |
| Browse the seeded **demo feed** . Sign in to **unlock** a sample post (no USDC; recorded on this API). | Real Bankr x402 payment on those sample posts. |
| **Gate content** as a creator (`+ POST`): title, 280 chars, unlock fee. The **deployer** sponsors gas (ETH on Base) to launch the token and deploy the x402 endpoint. | Gating if the deployer wallet is empty. |

Keep the laptop running `npm run hackathon` while the Vercel app is in use; the SPA calls the ngrok API.

```
npm run setup       # once
npm run hackathon   # API :8787 + ngrok tunnel
npm run dev         # local Vite only (http://localhost:5173)
```

## Not complete / running locally

**Not complete**

- On-chain vouch (buy/sell) against demo posts; real unlock USDC via x402 for the seeded feed.
- Buyback-and-burn from those demo unlocks (they do not queue the keeper).
- Edit/delete posts, notifications, search, wallet-only login without X or email.

