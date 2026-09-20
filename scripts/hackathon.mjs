#!/usr/bin/env node
// Laptop API + ngrok tunnel for a Vercel frontend. Bankr's x402 handlers call PUBLIC_API_URL;
// the browser on *.vercel.app calls the same URL. See README "Hackathon".
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k) out[k] = v;
  }
  return out;
}

function hostOf(urlOrHost) {
  return (urlOrHost ?? '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const fileEnv = loadEnv(envPath);
const env = { ...process.env, ...fileEnv };
const port = env.PORT?.trim() || '8787';
const ngrokHost = hostOf(env.NGROK_DOMAIN || env.PUBLIC_API_URL);
const publicUrl = (env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
const cors = (env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const viteApi = (env.VITE_API_URL ?? '').replace(/\/$/, '');

const problems = [];
if (!existsSync(envPath)) problems.push(`create ${envPath} from .env.example`);
if (!ngrokHost) problems.push('set NGROK_DOMAIN (your assigned *.ngrok-free.app hostname) or PUBLIC_API_URL');
if (!publicUrl.startsWith('https://')) problems.push('set PUBLIC_API_URL to https://<your-ngrok-domain> (Bankr must reach /hooks/unlock)');
if (publicUrl && ngrokHost && hostOf(publicUrl) !== ngrokHost) {
  problems.push(`PUBLIC_API_URL (${publicUrl}) must be https://${ngrokHost} so already-deployed x402 handlers match the tunnel`);
}
if (!cors.some((o) => o.includes('vercel.app'))) {
  problems.push('set CORS_ORIGIN to your https://<app>.vercel.app origin (comma-separate localhost if you also run Vite)');
}
if (viteApi && /localhost|127\.0\.0\.1/.test(viteApi)) {
  problems.push('VITE_API_URL in .env is localhost; the Vercel build must use the ngrok URL (set it in the Vercel dashboard, then redeploy)');
}

if (problems.length) {
  console.error('Hackathon (Vercel frontend + ngrok API):\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

if (env.TRUST_PROXY !== '1') {
  console.warn('warning: TRUST_PROXY is not 1. Vercel traffic arrives through ngrok; without it every browser shares one rate-limit bucket.');
}

const ngrok = spawnSync('ngrok', ['version'], { encoding: 'utf8' });
if (ngrok.error || ngrok.status !== 0) {
  console.error('ngrok is not on PATH. Install it, run `ngrok config add-authtoken …`, then claim the free static domain in the ngrok dashboard.');
  process.exit(1);
}

const expectedPublic = `https://${ngrokHost}`;
console.log(`frontend: ${cors.join(', ')}`);
console.log(`api tunnel: ${expectedPublic}  ->  localhost:${port}`);
console.log('Privy: allowlist the Vercel origin. Keep this laptop awake while judges are on the site.');

const children = [];
let stopping = false;

function run(name, command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${name} exited (${signal || code || 0})`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', 'npm', ['run', 'server']);
run('ngrok', 'ngrok', ['http', '--domain', ngrokHost, port]);
