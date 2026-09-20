// Fixed-window rate limiter, in memory. One server process owns all state (SQLite already forces a single instance),
// so no shared store is needed. Counters reset on restart, which is fine for abuse protection.
import type { Context, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { tooMany } from '../errors.ts';

export type Limiter = { hit(key: string, now?: number): { ok: boolean; retryAfter: number } };

export function createLimiter({ windowMs, max }: { windowMs: number; max: number }): Limiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key, now = Date.now()) {
      if (windows.size > 10_000) for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k); // bound memory
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return { ok: w.count <= max, retryAfter: Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)) };
    },
  };
}

/** The caller's address: behind our own proxy the first X-Forwarded-For entry, otherwise the socket. Never trust the header without a proxy. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // in-process test requests have no socket
  }
}

export const limit = (limiter: Limiter, trustProxy: boolean) => async (c: Context, next: Next) => {
  const r = limiter.hit(clientIp(c, trustProxy));
  if (!r.ok) throw tooMany('Too many requests. Slow down and try again shortly.', r.retryAfter);
  await next();
};
