import { useState } from 'react';
import { PostCard, Skeletons } from '../components/PostCard';
import { api } from '../lib/api';
import { useLoad } from '../lib/app';
import { useAuth } from '../lib/auth';
import type { Sort } from '../lib/types';

export function Feed() {
  const { session } = useAuth();
  const [sort, setSort] = useState<Sort>('trending');
  const viewer = session?.profile.id;
  const { data, error } = useLoad(() => api.listPosts(sort, viewer), [sort, viewer]);

  return (
    <>
      <header className="header">
        <div className="tabs" role="tablist">
          {(['trending', 'new'] as Sort[]).map((s) => (
            <button key={s} role="tab" aria-selected={sort === s} className={`tab${sort === s ? ' active' : ''}`} onClick={() => setSort(s)}>
              <span>{s === 'trending' ? 'Most popular' : 'New'}</span>
            </button>
          ))}
        </div>
      </header>
      {error && <div className="empty"><b>Couldn't load posts</b>{error}</div>}
      {!data && !error && <Skeletons />}
      {data?.length === 0 && <div className="empty"><b>No posts yet</b>Be the first to gate something worth paying for.</div>}
      {data?.map((p) => <PostCard key={p.id} post={p} />)}
    </>
  );
}
