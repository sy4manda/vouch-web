// Operator alerts: always logged with an [ALERT] tag, and posted to ALERT_WEBHOOK_URL (Slack or Discord) if set.
// Each key is throttled so a persistent problem pages you once every 10 minutes, not once per keeper tick.
import { config } from '../config.ts';

export type Alerter = (key: string, message: string) => void;

const THROTTLE_MS = 10 * 60_000;
const lastSent = new Map<string, number>();

export const alert: Alerter = (key, message) => {
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return;
  lastSent.set(key, now);
  console.error(`[ALERT] ${message}`);
  const url = config.alertWebhookUrl();
  if (!url) return;
  const text = `vouch: ${message}`;
  // `text` is Slack's field, `content` is Discord's
  void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
};
