import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userFromLinkedAccounts } from '../../src/auth/privy.ts';
import { addr } from '../helpers.ts';

const embedded = { type: 'wallet', address: '0xABCDEF0000000000000000000000000000000001', chain_type: 'ethereum', wallet_client_type: 'privy' };
const external = { type: 'wallet', address: addr(0xe), chain_type: 'ethereum', wallet_client_type: 'metamask' };
const solana = { type: 'wallet', address: 'So1anaAddr', chain_type: 'solana', wallet_client_type: 'privy' };
const x = { type: 'twitter_oauth', username: 'mira', name: 'Mira', profile_picture_url: 'https://img/m.png' };

test('picks the embedded wallet as identity, lowercases, ignores non-EVM wallets', () => {
  const u = userFromLinkedAccounts('did:privy:1', [external, solana, embedded, x]);
  assert.equal(u.wallet, '0xabcdef0000000000000000000000000000000001');
  assert.deepEqual(u.wallets, [addr(0xe), u.wallet]);
  assert.deepEqual(u.x, { username: 'mira', name: 'Mira', avatarUrl: 'https://img/m.png' });
});

test('X profile is optional; a user with no EVM wallet is rejected', () => {
  assert.equal(userFromLinkedAccounts('did:privy:1', [embedded]).x, undefined);
  assert.throws(() => userFromLinkedAccounts('did:privy:1', [solana, x]), /No wallet/);
});
