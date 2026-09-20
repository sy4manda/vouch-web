// Pay a real Bankr x402 endpoint on Base mainnet for $0.001, to check what Bankr promises without our token or
// backend in the way: payment verification, facilitator settlement and handler execution.
//
//   npm run pay-test                        # deploy a $0.001 endpoint, pay it, report
//   npm run pay-test -- --endpoint <url>    # pay an endpoint you already deployed (skips the deploy)
//
// First run generates a throwaway payer key and prints it. Put it in .env.mainnet as PAYER_PRIVATE_KEY, send its
// address about $0.02 of USDC on Base (no ETH needed: x402 payments are signed, and Bankr's facilitator settles them).
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, publicActions, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { decodeXPaymentResponse, wrapFetchWithPayment } from 'x402-fetch';
import { deployService, endpointUrl } from '../src/bankr/deploy.ts';
import { config } from '../src/config.ts';

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRICE_ATOMIC = 1000n; // $0.001 in USDC's 6 decimals: Bankr's platform minimum

// what the endpoint's unpaid 402 asks for; v1 puts it in the body, v2 in a header
export type Requirement = { scheme?: string; network?: string; maxAmountRequired?: string; amount?: string; payTo?: string; asset?: string };
export type Probe = { ok: boolean; problems: string[]; requirement?: Requirement };

/** Does the 402 ask for what we expect: exact scheme, Base, $0.001 of USDC, paid to our Bankr wallet? */
export function checkRequirement(body: unknown, header: string | null, expect: { payTo: string }): Probe {
  let parsed: any = body;
  if (!parsed?.accepts && header) {
    try { parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { /* fall through */ }
  }
  const req: Requirement | undefined = parsed?.accepts?.[0];
  if (!req) return { ok: false, problems: ['no payment requirements found in the 402 (body or PAYMENT-REQUIRED header)'] };
  const problems: string[] = [];
  const amount = req.maxAmountRequired ?? req.amount;
  if (req.scheme !== 'exact') problems.push(`scheme is ${req.scheme}, expected exact`);
  if (req.network !== 'base') problems.push(`network is ${req.network}, expected base`);
  if (amount !== PRICE_ATOMIC.toString()) problems.push(`price is ${amount} atomic USDC, expected ${PRICE_ATOMIC}`);
  if (req.asset?.toLowerCase() !== USDC.toLowerCase()) problems.push(`asset is ${req.asset}, expected USDC on Base`);
  if (req.payTo?.toLowerCase() !== expect.payTo.toLowerCase()) problems.push(`payTo is ${req.payTo}, expected BANKR_WALLET ${expect.payTo}`);
  return { ok: !problems.length, problems, requirement: req };
}

const handlerSource = `// pay-test endpoint: no token, no backend, just proves Bankr's payment layer
export default async function handler(req: Request) {
  return { ok: true, payer: req.headers.get('x-402-payer'), at: new Date().toISOString() };
}
`;

async function main() {
  const say = (m = '') => console.log(m);
  const ok = (m: string) => say(`  ✓ ${m}`);
  const fail = (m: string): never => { console.error(`  ✗ ${m}`); process.exit(1); };

  if (config.network !== 'base') fail(`NETWORK is ${config.network}. Bankr has no testnet: run this with the mainnet overlay (npm run pay-test).`);
  const bankrWallet = config.bankrWallet();

  const keyEnv = process.env.PAYER_PRIVATE_KEY?.trim();
  if (!keyEnv) {
    const key = generatePrivateKey();
    say('No PAYER_PRIVATE_KEY yet. Generated a throwaway payer:');
    say(`  key:     ${key}`);
    say(`  address: ${privateKeyToAccount(key).address}`);
    say('\nSave the key as PAYER_PRIVATE_KEY=... in .env.mainnet (never commit it), send the address ~$0.02 of USDC on Base, then run this again.');
    return;
  }
  const account = privateKeyToAccount(keyEnv as `0x${string}`);
  const pub = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
  const balance = async (a: Address) => Number(formatUnits(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] }), 6));

  say(`payer ${account.address}`);
  const payerBefore = await balance(account.address);
  const bankrBefore = await balance(bankrWallet);
  if (payerBefore < 0.002) fail(`payer has $${payerBefore} USDC on Base; send it ~$0.02 first`);
  ok(`payer holds $${payerBefore} USDC on Base`);

  const flag = process.argv.indexOf('--endpoint');
  let url = flag > -1 ? process.argv[flag + 1] : '';
  if (!url) {
    const name = `paytest-${randomBytes(3).toString('hex')}`;
    say(`\ndeploying ${name} at $0.001 (bankr CLI)...`);
    url = await deployService({ postId: name, serviceName: name, feeUsd: 0.001, source: handlerSource });
    ok(`deployed ${url}`);
    say('  (endpoints can take a few seconds to go live)');
    await new Promise((r) => setTimeout(r, 8000));
  }
  if (url !== endpointUrl(url.split('/').pop()!) && flag === -1) fail(`unexpected endpoint url ${url}`);

  say('\n1. unpaid request: should be refused with the price');
  const unpaid = await fetch(url);
  const body = await unpaid.json().catch(() => null);
  if (unpaid.status !== 402) fail(`expected 402, got ${unpaid.status}: ${JSON.stringify(body)}`);
  const probe = checkRequirement(body, unpaid.headers.get('payment-required'), { payTo: bankrWallet });
  if (probe.problems.length) probe.problems.forEach((p) => console.error(`  ✗ ${p}`));
  else ok('402 asks for exactly $0.001 USDC on Base, paid to your Bankr wallet');
  say(`  requirement: ${JSON.stringify(probe.requirement)}`);
  if (!probe.ok) fail('the endpoint is not asking for what we expect (see above)');

  say('\n2. paid request via x402-fetch: signs a USDC authorization, retries');
  const wallet = createWalletClient({ account, chain: base, transport: http(config.rpcUrl) }).extend(publicActions);
  // x402-fetch bundles its own viem, so the client types differ by a hair (same cast as the frontend's httpApi.ts)
  const pay = wrapFetchWithPayment(fetch, wallet as unknown as Parameters<typeof wrapFetchWithPayment>[1], PRICE_ATOMIC);
  const res = await pay(url);
  const out = await res.text();
  if (!res.ok) {
    fail(`paid request failed (${res.status}): ${out.slice(0, 300)}\n  If this is a 402/400 about payment headers, Bankr may expect x402 v2 headers; x402-fetch 1.x sends v1 (see README).`);
  }
  ok(`handler ran: ${out}`);
  const settled = res.headers.get('x-payment-response');
  if (settled) {
    const s = decodeXPaymentResponse(settled);
    ok(`settled on ${s.network}, tx ${s.transaction}`);
    say(`  https://basescan.org/tx/${s.transaction}`);
  } else {
    say('  (no X-PAYMENT-RESPONSE header: check the settlement on basescan for the payer address)');
  }

  say('\n3. balances (waiting up to 30s for settlement to show)');
  let payerAfter = payerBefore;
  for (let i = 0; i < 10 && payerAfter >= payerBefore; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    payerAfter = await balance(account.address);
  }
  const bankrAfter = await balance(bankrWallet);
  const spent = payerBefore - payerAfter;
  const received = bankrAfter - bankrBefore;
  say(`  payer spent      $${spent.toFixed(6)}`);
  say(`  Bankr wallet got $${received.toFixed(6)}${received > 0 ? `  (${((received / 0.001) * 100).toFixed(0)}% of the price)` : ''}`);
  if (Math.abs(spent - 0.001) < 1e-9) ok('exactly $0.001 left the payer');
  else say('  ? payer balance did not drop by exactly $0.001; check basescan');
  if (received > 0 && received < 0.001 - 1e-9) say('  ! Bankr wallet received less than the price, i.e. Bankr takes a cut: the keeper queues the full fee, so tell me and I will net it out.');
  say('\ndone. The test endpoint stays on your Bankr account; delete it from the dashboard if you like.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
