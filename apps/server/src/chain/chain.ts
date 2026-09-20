// Everything that touches Base: launching a token, quoting, building the user's swap transactions,
// and turning receipts/logs into trades. Vouch tokens live in Uniswap v4 pools created by Doppler,
// so trades go through the Universal Router (V4_SWAP) with USDC/tokens pulled via Permit2.
import { DopplerSDK, computePoolId, getAddresses, type V4PoolKey } from '@whetstone-research/doppler-sdk/evm';
import {
  createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http,
  decodeEventLog, parseAbi, parseAbiItem, parseUnits, formatUnits, type Address, type Hex, type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { buildLaunchParams, USDC } from './launch.ts';
import { config } from '../config.ts';
import { bad } from '../errors.ts';

export type Tx = { to: Address; data: Hex; value?: string };
export type Side = 'buy' | 'sell';

/** One user-visible swap on a vouch pool, reconstructed from a receipt. */
export type ParsedSwap = {
  txHash: string;
  poolId: string;
  side: Side;
  wallet: string; // who received the tokens (buy) or the USDC (sell)
  usd: number;
  tokens: number;
  priceUsd: number; // pool price after the swap
  block: number;
};

export type PoolRef = { tokenAddress: Address; poolId: Hex };

export interface Chain {
  launch(input: { name: string; symbol: string; tokenURI: string; owner: Address }): Promise<PoolRef & { txHash: string }>;
  /** exact-input quote in raw units: USDC (6 dec) in -> tokens (18 dec) out for a buy, the reverse for a sell */
  quote(pool: PoolRef, side: Side, amountIn: bigint): Promise<bigint>;
  buildTrade(pool: PoolRef, side: Side, wallet: Address, amountIn: bigint, minOut: bigint): Promise<Tx[]>;
  /** swaps against any of `pools` found in this transaction */
  swapsInTx(hash: Hex, pools: PoolRef[]): Promise<ParsedSwap[]>;
  swapsInRange(from: bigint, to: bigint, pools: PoolRef[]): Promise<ParsedSwap[]>;
  blockNumber(): Promise<bigint>;
  /** ETH (wei) held by the deployer key, which pays gas for every launch */
  deployerBalance(): Promise<bigint>;
  /** USDC held by any address, in whole dollars */
  usdcBalance(owner: Address): Promise<number>;
  tokenBalance(token: Address, wallet: Address): Promise<number>;
}

const SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);

// Universal Router command + v4 router actions (Uniswap v4 periphery `Actions.sol`)
const CMD_V4_SWAP = '0x10';
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;

const poolKeyTuple = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Pool price in USD per token from sqrtPriceX96; the pool price is currency1/currency0 in raw units. */
export function priceFromSqrt(sqrtPriceX96: bigint, tokenIsCurrency0: boolean): number {
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return tokenIsCurrency0 ? raw * 1e12 : 1e12 / raw; // 1e12 = 10^(18 token decimals - 6 USDC decimals)
}

/**
 * Turn the Swap + Transfer logs of one tx into user-facing swaps. Direction and wallet come from the
 * token's Transfer logs against the PoolManager (PM -> X is a buy by X, X -> PM is a sell by X), which
 * doesn't depend on the sign convention of the Swap event; amounts come from the Swap event.
 */
export function parseSwaps(
  logs: { address: string; topics: readonly string[]; data: Hex; logIndex: number | null; transactionHash: string | null; blockNumber: bigint | null }[],
  pools: (PoolRef & { tokenIsCurrency0: boolean })[],
  poolManager: Address,
  decode: (log: any) => { name: string; args: any } | null,
): ParsedSwap[] {
  const decoded = logs.map((l) => ({ l, d: decode(l) })).filter((x) => x.d);
  const out = new Map<string, ParsedSwap>();
  for (const { l, d } of decoded) {
    if (d!.name !== 'Swap') continue;
    const pool = pools.find((p) => same(p.poolId, d!.args.id));
    if (!pool) continue;
    const { amount0, amount1, sqrtPriceX96 } = d!.args as { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint };
    const abs = (x: bigint) => (x < 0n ? -x : x);
    const tokenRaw = abs(pool.tokenIsCurrency0 ? amount0 : amount1);
    const usdRaw = abs(pool.tokenIsCurrency0 ? amount1 : amount0);

    // who traded: look at this token's transfers to/from the PoolManager in the same tx
    let side: Side | undefined;
    let wallet: string | undefined;
    for (const t of decoded) {
      if (t.d!.name !== 'Transfer' || !same(t.l.address, pool.tokenAddress)) continue;
      const { from, to } = t.d!.args as { from: string; to: string };
      if (same(from, poolManager)) { side = 'buy'; wallet = to; break; }
      if (same(to, poolManager)) { side = 'sell'; wallet = from; break; }
    }
    if (!side || !wallet) continue;

    const key = `${l.transactionHash}:${pool.poolId}`;
    const prev = out.get(key);
    const swap: ParsedSwap = {
      txHash: l.transactionHash!.toLowerCase(),
      poolId: pool.poolId,
      side,
      wallet: wallet.toLowerCase(),
      usd: Number(formatUnits(usdRaw, 6)) + (prev?.usd ?? 0),
      tokens: Number(formatUnits(tokenRaw, 18)) + (prev?.tokens ?? 0),
      priceUsd: priceFromSqrt(sqrtPriceX96, pool.tokenIsCurrency0), // logs are in order: the last one wins
      block: Number(l.blockNumber ?? 0n),
    };
    out.set(key, swap);
  }
  return [...out.values()];
}

export function baseChain(): Chain {
  const chain = config.network === 'baseSepolia' ? baseSepolia : base;
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const account = privateKeyToAccount(config.deployerKey());
  const walletClient = createWalletClient({ chain, transport, account });
  const sdk = new DopplerSDK({ publicClient, walletClient, chainId: chain.id });
  const addr = getAddresses(chain.id);
  const usdc = USDC[chain.id];

  const poolKeys = new Map<string, V4PoolKey>();
  async function poolKey(p: PoolRef) {
    const k = p.poolId.toLowerCase();
    let pk = poolKeys.get(k);
    if (!pk) {
      pk = (await (await sdk.getMulticurvePool(p.tokenAddress)).getState()).poolKey;
      if (!same(computePoolId(pk), p.poolId)) throw new Error(`pool key mismatch for ${p.tokenAddress}`);
      poolKeys.set(k, pk);
    }
    return pk;
  }
  const tokenIsCurrency0 = (token: Address) => token.toLowerCase() < usdc.toLowerCase();
  const decode = (log: any) => {
    for (const ev of [SWAP_EVENT, TRANSFER_EVENT]) {
      try {
        const d = decodeEventLog({ abi: [ev], data: log.data, topics: log.topics });
        return { name: d.eventName as string, args: d.args };
      } catch { /* not this event */ }
    }
    return null;
  };
  const withOrientation = (pools: PoolRef[]) => pools.map((p) => ({ ...p, tokenIsCurrency0: tokenIsCurrency0(p.tokenAddress) }));

  return {
    async launch({ name, symbol, tokenURI, owner }) {
      const protocol = config.protocolAddress(account.address);
      const params = await buildLaunchParams(sdk, chain.id, { name, symbol, tokenURI, owner, protocol, user: account.address });
      const r = await sdk.factory.createMulticurve(params);
      return { tokenAddress: r.tokenAddress, poolId: r.poolId, txHash: r.transactionHash };
    },

    async quote(pool, side, amountIn) {
      const pk = await poolKey(pool);
      const inputAddr = side === 'buy' ? usdc : pool.tokenAddress;
      const zeroForOne = same(inputAddr, pk.currency0);
      try {
        const q = await sdk.quoter.quoteExactInputV4({ poolKey: pk, zeroForOne, exactAmount: amountIn, hookData: '0x' });
        return q.amountOut;
      } catch {
        throw bad('That trade is larger than the curve can fill right now');
      }
    },

    async buildTrade(pool, side, wallet, amountIn, minOut) {
      const pk = await poolKey(pool);
      const inToken = side === 'buy' ? usdc : pool.tokenAddress;
      const outToken = side === 'buy' ? pool.tokenAddress : usdc;
      const zeroForOne = same(inToken, pk.currency0);
      const txs: Tx[] = [];

      // 1. the token must be approved to Permit2 (the router pulls funds through it)
      const erc20Allowance = await publicClient.readContract({ address: inToken, abi: erc20Abi, functionName: 'allowance', args: [wallet, addr.permit2] });
      if (erc20Allowance < amountIn) {
        txs.push({ to: inToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addr.permit2, amountIn] }) });
      }
      // 2. Permit2 must allow the Universal Router to spend it
      const [p2Amount, p2Expiry] = await publicClient.readContract({ address: addr.permit2, abi: permit2Abi, functionName: 'allowance', args: [wallet, inToken, addr.universalRouter] });
      const now = Math.floor(Date.now() / 1000);
      if (p2Amount < amountIn || p2Expiry <= now + 60) {
        txs.push({ to: addr.permit2, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [inToken, addr.universalRouter, amountIn, now + 30 * 60] }) });
      }
      // 3. the swap: exact-in single hop, settle what we spend, take at least minOut
      const actions = ('0x' + [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL].map((a) => a.toString(16).padStart(2, '0')).join('')) as Hex;
      const swapParams = encodeAbiParameters(
        [{ type: 'tuple', components: [{ name: 'poolKey', ...poolKeyTuple }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
        [{ poolKey: pk, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }],
      );
      const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [inToken, amountIn]);
      const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [outToken, minOut]);
      const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settle, take]]);
      txs.push({
        to: addr.universalRouter,
        data: encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [CMD_V4_SWAP, [v4Input], BigInt(now + 20 * 60)] }),
      });
      return txs;
    },

    async swapsInTx(hash, pools) {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== 'success') return [];
      return parseSwaps(receipt.logs as any, withOrientation(pools), addr.poolManager, decode);
    },

    async swapsInRange(from, to, pools) {
      if (!pools.length) return [];
      const swaps = await publicClient.getLogs({ address: addr.poolManager, event: SWAP_EVENT, args: { id: pools.map((p) => p.poolId) }, fromBlock: from, toBlock: to });
      const hashes = [...new Set(swaps.map((l) => l.transactionHash))];
      const out: ParsedSwap[] = [];
      for (const h of hashes) out.push(...(await this.swapsInTx(h, pools)));
      return out;
    },

    blockNumber: () => publicClient.getBlockNumber(),

    deployerBalance: () => publicClient.getBalance({ address: account.address }),

    async usdcBalance(owner) {
      const raw = await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
      return Number(formatUnits(raw, 6));
    },

    async tokenBalance(token, wallet) {
      const raw = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] });
      return Number(formatUnits(raw, 18));
    },
  };
}

export const usdToRaw = (usd: number) => parseUnits(usd.toFixed(6), 6);
export const tokensToRaw = (t: number) => parseUnits(t.toFixed(18), 18);
export const rawToUsd = (r: bigint) => Number(formatUnits(r, 6));
export const rawToTokens = (r: bigint) => Number(formatUnits(r, 18));
