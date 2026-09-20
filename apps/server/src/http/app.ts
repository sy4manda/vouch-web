// REST layer. Contract: README.md ("REST contract"); shapes: packages/shared/src/index.ts.
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { Hex } from 'viem';
import type { Sort } from '@vouch/shared';
import type { Authenticator, AuthUser } from '../auth/privy.ts';
import { verifyHookSecret } from '../bankr/deploy.ts';
import { config } from '../config.ts';
import { HttpError, bad, unauthorized } from '../errors.ts';
import * as svc from '../domain/service.ts';
import { createLimiter, limit } from './rateLimit.ts';

export function createApp(deps: svc.Deps, authenticate: Authenticator) {
  const app = new Hono();
  app.use('*', cors({
    origin: (origin) => {
      const allowed = config.corsOrigins();
      if (allowed.includes('*')) return origin || '*';
      return allowed.includes(origin) ? origin : '';
    },
    allowHeaders: ['authorization', 'content-type', 'ngrok-skip-browser-warning'],
  }));
  app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) })); // posts are 280 chars

  // Abuse limits, per client IP. Read once per app so each app (and each test) has its own counters.
  const proxy = config.trustProxy();
  const general = limit(createLimiter({ windowMs: 60_000, max: config.rateLimitPerMin() }), proxy);
  const quotes = limit(createLimiter({ windowMs: 60_000, max: 30 }), proxy);      // each quote is an RPC call
  const writes = limit(createLimiter({ windowMs: 3_600_000, max: 20 }), proxy);   // publishing, per IP (wallet limits are in the service)
  app.use('*', async (c, next) => (c.req.path === '/health' || c.req.path === '/hooks/unlock' ? next() : general(c, next))); // Bankr's handlers share IPs
  app.use('/posts/:id/quote', quotes);
  app.use('/posts/:id/sell-quote', quotes);

  const bearer = (c: Context) => c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  const requireUser = async (c: Context): Promise<AuthUser> => {
    const t = bearer(c);
    if (!t) throw unauthorized();
    const user = await authenticate(t);
    svc.upsertUser(deps.db, user);
    return user;
  };
  /**
   * Who is looking. Only a verified token counts: the `viewer` query param is accepted by the contract but
   * never trusted, otherwise anyone could read another wallet's unlocked text by passing its address.
   */
  const viewer = async (c: Context): Promise<string[]> => {
    const t = bearer(c);
    if (!t) return [];
    try { return (await authenticate(t)).wallets; } catch { return []; }
  };
  const body = async (c: Context) => {
    try { return (await c.req.json()) as Record<string, unknown>; } catch { throw bad('Invalid JSON body'); }
  };
  const hash = (v: unknown): Hex => {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw bad('Invalid transaction hash');
    return v as Hex;
  };

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/posts', async (c) => {
    const sort: Sort = c.req.query('sort') === 'new' ? 'new' : 'trending';
    return c.json(svc.listPosts(deps.db, sort, await viewer(c)));
  });
  app.get('/posts/:id', async (c) => c.json(await svc.getPost(deps, c.req.param('id'), await viewer(c))));
  app.post('/posts', writes, async (c) => {
    const user = await requireUser(c);
    return c.json(await svc.createPost(deps, user, await body(c)), 201);
  });
  app.post('/posts/:id/unlock', writes, async (c) => {
    const user = await requireUser(c);
    return c.json(svc.recordDemoUnlock(deps.db, user, c.req.param('id') ?? ''));
  });

  app.get('/posts/:id/quote', async (c) => c.json(await svc.quoteBuy(deps, c.req.param('id'), c.req.query('usd'))));
  app.get('/posts/:id/sell-quote', async (c) => c.json(await svc.quoteSell(deps, c.req.param('id'), c.req.query('tokens'))));

  for (const side of ['buy', 'sell'] as const) {
    app.post(`/posts/:id/${side}`, async (c) => {
      const user = await requireUser(c);
      return c.json(await svc.buildTrade(deps, user, c.req.param('id'), side, await body(c)));
    });
    app.post(`/posts/:id/${side}/confirm`, async (c) => {
      await requireUser(c);
      const recorded = await svc.indexTx(deps, hash((await body(c)).hash));
      return c.json({ ok: true, recorded });
    });
  }

  app.get('/profiles/:key', async (c) => c.json(svc.getProfile(deps.db, c.req.param('key'), await viewer(c))));

  // Called by each post's Bankr x402 handler after a verified payment.
  app.post('/hooks/unlock', async (c) => {
    const b = await body(c);
    const postId = String(b.postId ?? '');
    if (!verifyHookSecret(postId, c.req.header('x-vouch-secret'))) throw unauthorized('bad secret');
    return c.json(svc.recordUnlock(deps.db, { postId, payer: String(b.payer ?? ''), eventId: String(b.eventId ?? '') }));
  });

  app.onError((e, c) => {
    if (e instanceof HttpError) {
      if (e.retryAfter) c.header('Retry-After', String(e.retryAfter));
      return c.json({ error: e.message }, e.status as 400);
    }
    console.error(e);
    return c.json({ error: e instanceof Error ? e.message : 'Internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  return app;
}
