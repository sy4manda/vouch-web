export const usd = (n: number) => {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 100) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return '$0';
  return `$${n.toPrecision(3)}`;
};
export const fee = (n: number) => (n < 0.01 ? `$${Number(n.toFixed(3))}` : n < 1 ? `${Math.round(n * 100)}¢` : `$${Number(n.toFixed(2))}`);
export const num = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
export const displayName = (p: { wallet: string; x?: { name: string } }) => p.x?.name ?? short(p.wallet);
export const handle = (p: { wallet: string; x?: { username: string } }) => (p.x ? `@${p.x.username}` : short(p.wallet));
export const profilePath = (p: { id: string; x?: { username: string } }) => `/u/${p.x?.username ?? p.id}`;
