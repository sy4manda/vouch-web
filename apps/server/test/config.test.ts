import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, envProblems } from '../src/config.ts';
import { addr } from './helpers.ts';

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
};

test('a blank variable (as copied from .env.example) falls back to the default', () => {
  withEnv({ PROTOCOL_ADDRESS: '' }, () => assert.equal(config.protocolAddress(addr(1)), addr(1)));
  withEnv({ PROTOCOL_ADDRESS: '   ' }, () => assert.equal(config.protocolAddress(addr(1)), addr(1)));
  withEnv({ PROTOCOL_ADDRESS: addr(2) }, () => assert.equal(config.protocolAddress(addr(1)), addr(2)));
});

test('startup lists every missing or malformed variable at once', () => {
  withEnv({ PRIVY_APP_ID: '', DEPLOYER_PRIVATE_KEY: '0x123', BANKR_WALLET: 'nope', PROTOCOL_ADDRESS: 'bad', BUYBACK_MODE: 'agent' }, () => {
    const p = envProblems();
    assert.ok(p.includes('PRIVY_APP_ID is not set'));
    assert.ok(p.some((x) => x.startsWith('DEPLOYER_PRIVATE_KEY is not a valid')));
    assert.ok(p.some((x) => x.startsWith('BANKR_WALLET is not a valid')));
    assert.ok(p.some((x) => x.startsWith('PROTOCOL_ADDRESS is not a valid')));
    assert.ok(!p.some((x) => x.startsWith('BANKR_API_KEY'))); // not needed in agent mode
  });
});

test('production refuses to start without an explicit CORS origin', () => {
  withEnv({ NODE_ENV: 'production', CORS_ORIGIN: '' }, () => assert.ok(envProblems().includes('CORS_ORIGIN is not set (required in production)')));
  withEnv({ NODE_ENV: 'production', CORS_ORIGIN: 'https://vouch.example' }, () => assert.ok(!envProblems().some((p) => p.startsWith('CORS_ORIGIN'))));
  withEnv({ NODE_ENV: 'test', CORS_ORIGIN: '' }, () => assert.ok(!envProblems().some((p) => p.startsWith('CORS_ORIGIN')))); // dev keeps the * default
});

test('CORS_ORIGIN is a comma-separated allowlist; trailing slashes are ignored', () => {
  withEnv({ CORS_ORIGIN: 'https://vouch.vercel.app/, http://localhost:5173' }, () => {
    assert.deepEqual(config.corsOrigins(), ['https://vouch.vercel.app', 'http://localhost:5173']);
  });
  withEnv({ CORS_ORIGIN: undefined }, () => assert.deepEqual(config.corsOrigins(), ['*']));
});

test('BUYBACK_MODE=off skips the Wallet API key the same way agent mode does', () => {
  withEnv({ BUYBACK_MODE: 'off', BANKR_API_KEY: '', NETWORK: 'base' }, () => {
    assert.equal(config.buybackMode(), 'off');
    assert.ok(!envProblems().some((p) => p.startsWith('BANKR_API_KEY')));
  });
});
