import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRequirement } from '../../scripts/pay-test.ts';

const PAY_TO = '0x00000000000000000000000000000000000b4a4c';
const good = { scheme: 'exact', network: 'base', maxAmountRequired: '1000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO };

test('accepts a 402 for exactly $0.001 USDC on Base paid to the Bankr wallet (v1 body)', () => {
  assert.equal(checkRequirement({ x402Version: 1, accepts: [good] }, null, { payTo: PAY_TO.toUpperCase().replace('0X', '0x') }).ok, true);
});

test('reads the v2 PAYMENT-REQUIRED header when the body is empty', () => {
  const header = Buffer.from(JSON.stringify({ accepts: [{ ...good, amount: '1000', maxAmountRequired: undefined }] })).toString('base64');
  assert.equal(checkRequirement(null, header, { payTo: PAY_TO }).ok, true);
});

test('reports every mismatch: price, network, payee, asset, scheme', () => {
  const p = checkRequirement({ accepts: [{ scheme: 'upto', network: 'base-sepolia', maxAmountRequired: '10000', asset: '0xabc', payTo: '0xdef' }] }, null, { payTo: PAY_TO });
  assert.equal(p.ok, false);
  assert.equal(p.problems.length, 5);
});

test('no requirements at all is a failure, not a crash', () => {
  assert.equal(checkRequirement({ error: 'nope' }, null, { payTo: PAY_TO }).ok, false);
});
