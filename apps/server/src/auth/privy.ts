// Privy auth: @privy-io/node verifies the access token (ES256 JWT, keys fetched from Privy's JWKS) and loads
// the user's linked X account and wallets. The wallet comes from Privy, never from the request body.
import { PrivyClient } from '@privy-io/node';
import { config } from '../config.ts';
import { unauthorized } from '../errors.ts';

export type AuthUser = {
  privyId: string;
  /** Wallet used as the user's identity (the Privy embedded wallet when there is one). */
  wallet: string;
  /** Every linked EVM wallet, lowercased. A trade may be sent from any of them. */
  wallets: string[];
  x?: { username: string; name: string; avatarUrl?: string };
};

/** Resolves a bearer token to a user. Swapped for a fake in tests. */
export type Authenticator = (token: string) => Promise<AuthUser>;

/** The subset of Privy's LinkedAccount union we read. */
type LinkedAccount = {
  type: string;
  address?: string;
  chain_type?: string;
  wallet_client_type?: string;
  username?: string | null;
  name?: string | null;
  profile_picture_url?: string | null;
};

export function userFromLinkedAccounts(privyId: string, accounts: LinkedAccount[]): AuthUser {
  const evm = accounts.filter((a) => (a.type === 'wallet' || a.type === 'smart_wallet') && a.address && (!a.chain_type || a.chain_type === 'ethereum'));
  if (!evm.length) throw unauthorized('No wallet linked to this account yet');
  const primary = evm.find((a) => a.wallet_client_type === 'privy') ?? evm[0];
  const tw = accounts.find((a) => a.type === 'twitter_oauth');
  return {
    privyId,
    wallet: primary.address!.toLowerCase(),
    wallets: [...new Set(evm.map((a) => a.address!.toLowerCase()))],
    x: tw?.username ? { username: tw.username, name: tw.name ?? tw.username, avatarUrl: tw.profile_picture_url ?? undefined } : undefined,
  };
}

export function privyAuthenticator(): Authenticator {
  const privy = new PrivyClient({ appId: config.privyAppId(), appSecret: config.privyAppSecret() });
  const cache = new Map<string, { at: number; user: AuthUser }>();
  const TTL = 5 * 60_000;

  return async (token) => {
    let userId: string;
    try {
      ({ user_id: userId } = await privy.utils().auth().verifyAccessToken(token));
    } catch {
      throw unauthorized('Invalid or expired session');
    }
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL) return hit.user;

    let accounts: LinkedAccount[];
    try {
      accounts = (await privy.users()._get(userId)).linked_accounts as LinkedAccount[];
    } catch {
      throw unauthorized('Could not load your account');
    }
    const user = userFromLinkedAccounts(userId, accounts);
    cache.set(userId, { at: Date.now(), user });
    return user;
  };
}
