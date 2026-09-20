// One auth surface for the whole app. With VITE_PRIVY_APP_ID set it is Privy (login with X,
// embedded wallet). Without it, a local demo user so every flow stays clickable.
import { createContext, lazy, Suspense, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Profile, Session } from '@vouch/shared';

export type Auth = {
  ready: boolean;
  session: Session | null;
  login: () => void;
  logout: () => void;
  demo: boolean;
};

export const AuthContext = createContext<Auth>({ ready: false, session: null, login() {}, logout() {}, demo: true });
export const useAuth = () => useContext(AuthContext);

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const PrivyAuthProvider = lazy(() => import('./privyAuth'));

const DEMO_PROFILE: Profile = {
  id: '0xde7000000000000000000000000000000000beef',
  wallet: '0xde7000000000000000000000000000000000beef',
  x: { username: 'you', name: 'You (demo)' },
};

function DemoAuthProvider({ children }: { children: ReactNode }) {
  const [inside, setInside] = useState(() => {
    try { return localStorage.getItem('vouch.demo.auth') === '1'; } catch { return false; }
  });
  const set = (v: boolean) => {
    setInside(v);
    try { localStorage.setItem('vouch.demo.auth', v ? '1' : '0'); } catch { /* ignore */ }
  };
  const value = useMemo<Auth>(() => ({
    ready: true,
    demo: true,
    session: inside ? { profile: DEMO_PROFILE, getAccessToken: async () => null, getWalletClient: async () => undefined } : null,
    login: () => set(true),
    logout: () => set(false),
  }), [inside]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <DemoAuthProvider>{children}</DemoAuthProvider>;
  return (
    <Suspense fallback={null}>
      <PrivyAuthProvider appId={PRIVY_APP_ID}>{children}</PrivyAuthProvider>
    </Suspense>
  );
}
