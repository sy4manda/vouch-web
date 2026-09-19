// Bankr integration: (1) deploy one x402 Cloud endpoint per post, (2) Wallet API calls for the buyback.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from './config.ts';

const run = promisify(execFile);

/** Per-post webhook secret. The handler source (which holds it) lives on Bankr, so scope it to one post. */
export const hookSecret = (postId: string) => createHmac('sha256', config.webhookSecret()).update(postId).digest('hex');
export function verifyHookSecret(postId: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(hookSecret(postId));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const endpointUrl = (serviceName: string) => `https://x402.bankr.bot/${config.bankrWallet()}/${serviceName}`;

const TEMPLATE_PATH = fileURLToPath(new URL('./handler-snippet.ts', import.meta.url));

/** The deployed handler is handler-snippet.ts with its four placeholders filled in for this post. */
export function handlerSource(o: { postId: string; text: string }, template = readFileSync(TEMPLATE_PATH, 'utf8')): string {
  const fill: Record<string, string> = {
    __HOOK_URL__: config.publicUrl() + '/hooks/unlock',
    __SECRET__: hookSecret(o.postId),
    __POST_ID__: o.postId,
    __TEXT__: o.text,
  };
  let out = template;
  for (const [k, v] of Object.entries(fill)) {
    // function replacer: `$` in the user's text must not be read as a replacement pattern
    out = out.replace(`"${k}"`, () => JSON.stringify(v));
  }
  return out;
}

export function endpointConfig(serviceName: string, feeUsd: number, postId: string) {
  return {
    network: 'base',
    currency: 'USDC',
    services: {
      [serviceName]: {
        description: `Gated vouch post ${postId}`,
        price: feeUsd.toFixed(2),
        methods: ['GET'],
        category: 'content',
        tags: ['vouch'],
        ...(config.buybackMode === 'agent' ? { agentAccess: { enabled: true } } : {}),
      },
    },
  };
}

export interface EndpointDeployer {
  deploy(o: { postId: string; serviceName: string; text: string; feeUsd: number }): Promise<string>;
}

/** Deploys through the `bankr` CLI (Bankr has no REST deploy API). Needs the CLI installed and logged in. */
export const cliDeployer: EndpointDeployer = {
  async deploy({ postId, serviceName, text, feeUsd }) {
    const dir = join(config.x402Dir, serviceName);
    await mkdir(join(dir, 'x402', serviceName), { recursive: true });
    await writeFile(join(dir, 'x402', serviceName, 'index.ts'), handlerSource({ postId, text }));
    await writeFile(join(dir, 'bankr.x402.json'), JSON.stringify(endpointConfig(serviceName, feeUsd, postId), null, 2));
    try {
      await run('bankr', ['x402', 'deploy', serviceName], { cwd: dir, timeout: 120_000, env: process.env });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`bankr deploy failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
    } finally {
      await rm(dir, { recursive: true, force: true }); // the handler source contains the text; don't leave it on disk
    }
    return endpointUrl(serviceName);
  },
};
