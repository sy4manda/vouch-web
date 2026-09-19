# vouch — frontend

Vite + React + TypeScript. Pay-to-unlock 280-character posts, each with a token on a bonding curve; the feed is ranked by that token's market cap.

```
npm install
npm run dev        # http://localhost:5173
npm run build
```

With no env vars the app runs in **demo mode**: sample data in the browser (`src/lib/mockApi.ts`) and a fake signed-in user, so every flow is clickable. Set the vars in `.env.example` to go live:

| Var | Effect |
|---|---|
| `VITE_PRIVY_APP_ID` | Real auth: Privy, X login only, embedded wallet on Base (`src/lib/privyAuth.tsx`) |
| `VITE_API_URL` | Real data: the REST backend below (`src/lib/httpApi.ts`) |
| `VITE_BASE_RPC_URL` | Optional Base RPC for balance reads and receipts |

In the Privy dashboard: enable Twitter/X login, enable embedded wallets, add your domain to allowed origins.

## Routes

`/` feed (Trending = market cap, New) · `/post` composer · `/p/:id` vouch/token page · `/u/:usernameOrWallet` profile

## How unlock works for humans

Bankr x402 Cloud has no browser paywall; its endpoints only speak the x402 HTTP flow. The connector is client-side: `httpApi.unlock()` wraps `fetch` with `x402-fetch` and the user's Privy wallet. The endpoint answers `402`, the wallet signs a USDC authorization capped at the post's fee, the request retries, and the endpoint returns `{ "text": "..." }`. Agents hit the same URL with their own x402 client.

Two things the backend has to cover:

1. **Access forever.** Paying the x402 endpoint again would charge again. The Bankr handler should record the payer (`x-402-payer` header) per post, and the backend should serve already-unlocked text through `GET /posts` / `GET /posts/:id` (the `text` field) when the `viewer` has paid.
2. **x402 version.** `x402-fetch` 1.x sends the `X-PAYMENT` header (protocol v1). Confirm Bankr's router accepts it; if it expects v2 headers, swap the client package in `httpApi.ts` — nothing else changes.

## REST contract (`VITE_API_URL`)

Types are in `src/lib/types.ts`. Authenticated calls send `Authorization: Bearer <Privy access token>`; verify it server-side and take the wallet from the token, not the body. `viewer` is a lowercased wallet address used only to fill `unlocked` and `text`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/posts?sort=trending\|new&viewer=0x…` | | `Post[]` |
| GET | `/posts/:id?viewer=0x…` | | `PostDetail` (adds `curve`, `supplySold`, `totalSupply`, `burned`, `topVouchers`, `myVouchUsd`, `myTokens`) |
| POST | `/posts` (auth) | `{ title, text, feeUsd }` | `Post`. Backend deploys the x402 endpoint, launches the token, stores the creator's X profile |
| GET | `/posts/:id/quote?usd=10` | | `Quote` |
| POST | `/posts/:id/buy` (auth) | `{ usd, slippageBps, wallet }` | `{ transactions: [{ to, data, value? }] }` — sent in order by the user's wallet (USDC approve, then buy). Encode the slippage limit so the trade reverts rather than filling worse |
| GET | `/posts/:id/sell-quote?tokens=1000` | | `SellQuote` |
| POST | `/posts/:id/sell` (auth) | `{ tokens, slippageBps, wallet }` | `{ transactions: [...] }`, same shape |
| POST | `/posts/:id/buy/confirm`, `/posts/:id/sell/confirm` (auth) | `{ hash }` | anything; lets the backend index the trade immediately |
| GET | `/profiles/:usernameOrWallet?viewer=0x…` | | `ProfilePage` |

Rules the UI relies on:

- Never include `text` unless `unlocked` is true for that viewer (or the viewer is the creator). The blurred text on screen is filler, sized by `chars`.
- `curve` is a sampled list of `{ supply, priceUsd }` from zero upward; `supplySold` is the current position. Any curve shape works.
- `feeUsd` is any amount from 0.01 to 1000 with at most two decimals (the composer offers 0.1, 1, 10, 100 and a custom field). Validate it server-side. Text is at most 280 characters.
- Errors: non-2xx with `{ "error": "message" }`; the message is shown in a toast.

## Not built

Editing or deleting posts, notifications, search, and wallet-only login (v1 is X only).
