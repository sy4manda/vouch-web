import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { useMemo, type ReactNode } from 'react';
import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import { AuthContext, type Auth } from './auth';

function Bridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();

  const value = useMemo<Auth>(() => {
    // Prefer the Privy embedded wallet: it is the one tied to the X login.
    const wallet = wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0];
    const address = wallet?.address ?? user?.wallet?.address;
    const session = authenticated && user && address
      ? {
          profile: {
            id: address.toLowerCase(),
            wallet: address,
            x: user.twitter?.username
              ? { username: user.twitter.username, name: user.twitter.name ?? user.twitter.username, avatarUrl: user.twitter.profilePictureUrl ?? undefined }
              : undefined,
          },
          getAccessToken,
          getWalletClient: async () => {
            if (!wallet) return undefined;
            await wallet.switchChain(base.id);
            const provider = await wallet.getEthereumProvider();
            return createWalletClient({ account: wallet.address as `0x${string}`, chain: base, transport: custom(provider) });
          },
        }
      : null;
    return { ready, session, login, logout, demo: false };
  }, [ready, authenticated, user, wallets, login, logout, getAccessToken]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default function PrivyAuthProvider({ appId, children }: { appId: string; children: ReactNode }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['twitter'], // v1: X only
        defaultChain: base,
        supportedChains: [base],
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        appearance: { theme: 'dark', accentColor: '#00ba7c', showWalletLoginFirst: false },
      }}
    >
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}
