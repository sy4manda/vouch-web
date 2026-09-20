import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type App = { version: number; bump: () => void; toast: (msg: string, error?: boolean) => void };
const Ctx = createContext<App>({ version: 0, bump() {}, toast() {} });
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<{ msg: string; error?: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const toast = useCallback((msg: string, error?: boolean) => {
    setNote({ msg, error });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), 3200);
  }, []);
  const value = useMemo(() => ({ version, bump: () => setVersion((v) => v + 1), toast }), [version, toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {note && <div role="status" className={`toast${note.error ? ' error' : ''}`}>{note.msg}</div>}
    </Ctx.Provider>
  );
}

/** Load data, and reload whenever deps or the global mutation counter change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    fn().then((d) => live && setData(d), (e) => live && setError((e as Error).message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return { data, error };
}
