import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useAuth } from '../lib/auth';
import { ago, displayName, fee, handle, num, profilePath, usd } from '../lib/format';
import type { Post } from '../lib/types';
import { Avatar } from './Avatar';
import { ArrowUpAction, LockAction, LockIcon, UnlockedAction } from './icons';

// Stand-in text for the blur. The real text never reaches the browser until it is unlocked.
const FILLER = 'signal lorem market quietly ranked nobody checks the ledger before noon and three of them moved early while the rest waited for a number that was already public if you knew which filing to open and how to read the second table ';
const placeholder = (chars: number) => FILLER.repeat(3).slice(0, Math.max(40, chars));

export function useUnlock(post: Post) {
  const { session, login } = useAuth();
  const { bump, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const unlock = async () => {
    if (!session) return login();
    setBusy(true);
    try {
      await api.unlock(post, session);
      toast(`Unlocked. ${fee(post.feeUsd)} bought and burned ${post.tokenSymbol}.`);
      bump();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return { unlock, busy };
}

export function PostText({ post, onUnlock, busy }: { post: Post; onUnlock?: () => void; busy?: boolean }) {
  if (post.unlocked && post.text) return <p className="post-text">{post.text}</p>;
  return (
    <div className="locked">
      <p aria-hidden>{placeholder(post.chars)}</p>
      <div className="locked-badge">
        {onUnlock
          ? <button onClick={onUnlock} disabled={busy}>{busy ? <i className="spin" /> : <LockIcon />} {post.chars} characters · {fee(post.feeUsd)} to unlock</button>
          : <span><LockIcon /> {post.chars} characters · {fee(post.feeUsd)} to unlock</span>}
      </div>
    </div>
  );
}

export function PostCard({ post, kicker }: { post: Post; kicker?: string }) {
  const nav = useNavigate();
  const { unlock, busy } = useUnlock(post);
  const to = `/p/${post.id}`;
  return (
    <article className="post">
      <Link to={profilePath(post.creator)}><Avatar profile={post.creator} /></Link>
      <div className="post-body">
        {kicker && <div className="kicker">{kicker}</div>}
        <div className="byline">
          <Link to={profilePath(post.creator)}><b>{displayName(post.creator)}</b></Link>
          <span className="muted">{post.creator.x ? handle(post.creator) + ' · ' : ''}{ago(post.createdAt)}</span>
        </div>
        <Link to={to}><h2 className="post-title">{post.title}</h2></Link>
        <PostText post={post} onUnlock={unlock} busy={busy} />
        <div className="acts">
          {post.unlocked
            ? <span className="act done" data-tip="You unlocked this" aria-label={`Unlocked. ${post.unlocks} unlocks`}><UnlockedAction /><b className="mono">{num(post.unlocks)}</b></span>
            : (
              <button className="act act-unlock" onClick={unlock} disabled={busy} data-tip={`Unlock for ${fee(post.feeUsd)}`} aria-label={`Unlock for ${fee(post.feeUsd)}. ${post.unlocks} unlocks so far`}>
                {busy ? <i className="spin" /> : <LockAction />}<b className="mono">{num(post.unlocks)}</b>
              </button>
            )}
          <button className="act act-vouch" onClick={() => nav(to)} data-tip="Vouch: buy this post's token" aria-label={`Vouch. Market cap ${usd(post.marketCapUsd)}`}>
            <ArrowUpAction /><b className="mono">{usd(post.marketCapUsd)}</b>
          </button>
        </div>
      </div>
    </article>
  );
}

export const Skeletons = () => (
  <>{[0, 1, 2, 3].map((i) => <div className="skeleton" key={i}><i style={{ width: '30%' }} /><i style={{ width: '70%' }} /><i /><i style={{ width: '85%' }} /></div>)}</>
);
