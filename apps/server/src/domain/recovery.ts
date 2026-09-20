// A post is 'launching' while its endpoint is deployed and its token launched. If the process dies in between, the
// row is stuck: it never goes live and never fails. Startup marks any such row failed (nothing else can be mid-flight
// in a fresh process); the periodic pass only touches old ones, so it can't hit a publish that is still running.
import type { Alerter } from '../ops/alert.ts';
import type { DB } from '../db/db.ts';

export function recoverStuckPosts(db: DB, olderThanMs: number, alert: Alerter, now = Date.now()): number {
  const stuck = db.prepare(`SELECT id, token_address FROM posts WHERE status = 'launching' AND created_at < ?`).all(now - olderThanMs) as { id: string; token_address: string | null }[];
  for (const p of stuck) {
    db.prepare(`UPDATE posts SET status = 'failed', error = ? WHERE id = ?`).run('interrupted before it finished (the server restarted or crashed mid-publish)', p.id);
    alert(
      `stuck-${p.id}`,
      `post ${p.id} was interrupted mid-publish${p.token_address ? ` after its token launched (${p.token_address})` : ''}. ` +
        'A token may have been launched by the deployer, or a Bankr endpoint may exist with no live post: check the deployer\'s transactions and the Bankr dashboard.',
    );
  }
  return stuck.length;
}
