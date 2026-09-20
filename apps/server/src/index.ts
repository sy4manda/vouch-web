// Backend entrypoint:  npm run server | server:testnet | server:mainnet   (env: see .env.example)
import { serve } from '@hono/node-server';
import { createApp } from './http/app.ts';
import { privyAuthenticator } from './auth/privy.ts';
import { cliDeployer } from './bankr/deploy.ts';
import { baseChain } from './chain/chain.ts';
import { config, envProblems } from './config.ts';
import { checkNetworkStamp, openDb } from './db/db.ts';
import { bankrWallet, startKeeper, type KeeperHandle } from './bankr/buyback.ts';
import { recoverStuckPosts } from './domain/recovery.ts';
import { seedDemoFeed } from './domain/demoSeed.ts';
import { indexerTick, publishing } from './domain/service.ts';
import { alert } from './ops/alert.ts';
import { startBackups } from './ops/backup.ts';

const problems = envProblems();
if (problems.length) {
  console.error(`Fix .env (repo root; see .env.example):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const db = openDb(config.dbPath);
try { checkNetworkStamp(db, config.network); } catch (e) { console.error((e as Error).message); process.exit(1); }
console.log(`network: ${config.network} | db: ${config.dbPath}`);
const seeded = seedDemoFeed(db);
if (seeded) console.log(`seeded ${seeded} sample post(s)`);
const chain = baseChain();
const deps = { db, chain, deployer: cliDeployer, alert };

// ---- data safety
// A fresh process has no publish in flight, so anything still 'launching' was cut off by the last crash or restart.
const interrupted = recoverStuckPosts(db, 0, alert);
if (interrupted) console.log(`recovered ${interrupted} interrupted post(s), marked failed`);
const stopBackups = startBackups(db, config.dbPath, config.backupIntervalHours(), config.backupKeep(), alert);
const recoveryTimer = setInterval(() => recoverStuckPosts(db, 15 * 60_000, alert), 10 * 60_000); // old rows only: a live publish is younger

const app = createApp(deps, privyAuthenticator());
const server = serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`vouch api on :${i.port}`));

let indexing: Promise<void> | null = null;
const indexTimer = setInterval(() => {
  if (indexing) return;
  indexing = indexerTick(deps, config.indexerStartBlock)
    .catch((e) => console.error('indexer:', (e as Error).message))
    .finally(() => { indexing = null; });
}, config.indexerIntervalMs);

let keeper: KeeperHandle | undefined;
if (config.buybackMode() === 'off') {
  console.log('buyback: off (fees are recorded, nothing is swapped)');
} else if (config.buybackMode() !== 'keeper') {
  console.log('buyback: agent mode, the x402 handler triggers buybacks');
} else if (config.network !== 'base') {
  // Bankr's Wallet API only swaps real Base tokens; a testnet token would just fail every tick
  console.log(`buyback: keeper disabled on ${config.network} (Bankr Wallet API is Base mainnet only)`);
} else {
  keeper = startKeeper(db, bankrWallet, config.keeperIntervalMs, {
    minUsdc: config.keeperMinUsdc,
    maxSwapUsdc: config.keeperMaxSwapUsdc(),
    maxDailyUsdc: config.keeperMaxDailyUsdc(),
    reserveUsdc: config.keeperReserveUsdc(),
    balance: () => chain.usdcBalance(config.bankrWallet()), // never plan to spend more than the wallet holds
  });
}

// ---- graceful shutdown: stop taking work, let a swap or a publish in flight finish, then close the database
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  clearInterval(indexTimer);
  clearInterval(recoveryTimer);
  stopBackups();
  server.close();
  const deadline = setTimeout(() => { console.error('shutdown timed out, exiting anyway'); process.exit(1); }, 120_000);
  deadline.unref();
  await Promise.allSettled([indexing, keeper?.stop(), publishing()]);
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
