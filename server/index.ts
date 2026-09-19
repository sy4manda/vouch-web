// Backend entrypoint:  npx tsx server/index.ts   (env: see .env.example)
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { privyAuthenticator } from './auth.ts';
import { cliDeployer } from './bankr.ts';
import { baseChain } from './chain.ts';
import { config, envProblems } from './config.ts';
import { openDb } from './db.ts';
import { bankrWallet, startKeeper } from './buyback.ts';
import { indexerTick } from './service.ts';

const problems = envProblems();
if (problems.length) {
  console.error(`Fix .env (repo root; see .env.example):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const db = openDb(config.dbPath);
const chain = baseChain();
const deps = { db, chain, deployer: cliDeployer };

const app = createApp(deps, privyAuthenticator());
serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`vouch api on :${i.port}`));

let indexing = false;
setInterval(async () => {
  if (indexing) return;
  indexing = true;
  try { await indexerTick(deps, config.indexerStartBlock); } catch (e) { console.error('indexer:', (e as Error).message); } finally { indexing = false; }
}, config.indexerIntervalMs);

if (config.buybackMode === 'keeper') {
  startKeeper(db, bankrWallet, config.keeperIntervalMs, config.keeperMinUsdc);
}
