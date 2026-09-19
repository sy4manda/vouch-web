// Launch one vouch token per x402 endpoint on Doppler (multicurve, USDC-quoted, locked liquidity).
//
//   PRIVATE_KEY=0x... OWNER=0x... NAME="Good Data" SYMBOL=GDATA ENDPOINT=https://x402.bankr.bot/<wallet>/<name> \
//     npx tsx launch.ts            # simulate only
//   ... EXECUTE=1 npx tsx launch.ts # broadcast
//
// NETWORK=base (default) or baseSepolia. DRY=1 builds the params offline with no RPC calls.
import { DopplerSDK, WAD, getAddresses } from '@whetstone-research/doppler-sdk/evm';
import { createPublicClient, createWalletClient, http, parseEther, type Address } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const USDC: Record<number, Address> = {
  [base.id]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  [baseSepolia.id]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

// ---- the standard template: identical for every endpoint ----
const TEMPLATE = {
  supply: parseEther('1000000'), // 1M: keeps the token price legible at tiny market caps
  forSale: parseEther('950000'), // 95% on the curve, 5% to the endpoint owner (vested)
  ownerVestingSeconds: 180 * 24 * 60 * 60,
  fee: 25_000, // 2.5% swap fee (v4 units: 1e6 = 100%)
  tickSpacing: 200,
  // Each band is 10x the market cap of the one before and holds fewer tokens, so
  // clearing a band costs roughly: $120, $950, $6k, then the tail.
  curves: [
    { marketCap: { start: 100, end: 1_000 }, numPositions: 10, shares: parseEther('0.4') },
    { marketCap: { start: 1_000, end: 10_000 }, numPositions: 10, shares: parseEther('0.3') },
    { marketCap: { start: 10_000, end: 100_000 }, numPositions: 10, shares: parseEther('0.2') },
    { marketCap: { start: 100_000, end: 'max' as const }, numPositions: 1, shares: parseEther('0.1') },
  ],
  // swap-fee split: Doppler takes a mandatory >= 5%
  ownerShare: parseEther('0.80'),
  protocolShare: parseEther('0.15'), // us
  dopplerShare: parseEther('0.05'),
};

async function main() {
  const dry = !!process.env.DRY;
  const chain = process.env.NETWORK === 'baseSepolia' ? baseSepolia : base;
  const account = privateKeyToAccount((process.env.PRIVATE_KEY ?? generatePrivateKey()) as `0x${string}`);
  const owner = (process.env.OWNER ?? account.address) as Address;
  const protocol = (process.env.PROTOCOL ?? account.address) as Address;

  const transport = http(process.env.RPC_URL);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: chain.id });

  const doppler = dry
    ? { beneficiary: '0x0000000000000000000000000000000000000001' as Address, shares: TEMPLATE.dopplerShare }
    : await sdk.getAirlockBeneficiary(TEMPLATE.dopplerShare);

  // Shares must sum to exactly 1e18. If owner and protocol are the same address, merge them.
  const beneficiaries =
    owner.toLowerCase() === protocol.toLowerCase()
      ? [doppler, { beneficiary: owner, shares: WAD - doppler.shares }]
      : [doppler, { beneficiary: owner, shares: TEMPLATE.ownerShare }, { beneficiary: protocol, shares: TEMPLATE.protocolShare }];

  const params = sdk
    .buildMulticurveAuction()
    .tokenConfig({
      type: 'standard',
      name: process.env.NAME ?? 'Vouch Test',
      symbol: process.env.SYMBOL ?? 'VOUCH',
      tokenURI: process.env.ENDPOINT ?? 'https://example.com', // point the token at the endpoint it vouches for
    })
    .saleConfig({ initialSupply: TEMPLATE.supply, numTokensToSell: TEMPLATE.forSale, numeraire: USDC[chain.id] })
    .withCurves({
      numerairePrice: 1,
      numeraireDecimals: 6,
      fee: TEMPLATE.fee,
      tickSpacing: TEMPLATE.tickSpacing,
      curves: TEMPLATE.curves,
      beneficiaries,
    })
    .withVesting({ duration: BigInt(TEMPLATE.ownerVestingSeconds), cliffDuration: 0, recipients: [owner], amounts: [TEMPLATE.supply - TEMPLATE.forSale] })
    .withGovernance({ type: 'noOp' })
    .withMigration({ type: 'noOp' }) // liquidity stays locked in the v4 pool forever
    .withUserAddress(account.address)
    .build();

  console.log('chain:', chain.name, '| owner:', owner, '| protocol:', protocol);
  console.log('curves (ticks):', params.pool.curves.map((c: any) => `${c.tickLower}..${c.tickUpper} x${c.numPositions}`).join('  '));
  if (dry) return console.log('DRY: params built OK, nothing sent.');

  const sim = await sdk.factory.simulateCreateMulticurve(params);
  console.log('simulated token address:', (sim as any).tokenAddress ?? sim);
  if (!process.env.EXECUTE) return console.log('Simulation only. Set EXECUTE=1 to broadcast.');

  const result = await sdk.factory.createMulticurve(params);
  console.log('token:', result.tokenAddress, '\npoolId:', result.poolId, '\ntx:', result.transactionHash);
}

main().catch((e) => { console.error(e); process.exit(1); });
