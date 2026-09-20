import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { BackIcon, XLogo } from '../components/icons';
import { PostCard, Skeletons } from '../components/PostCard';
import { api } from '../lib/api';
import { useApp, useLoad } from '../lib/app';
import { useAuth } from '../lib/auth';
import { displayName, short, usd } from '../lib/format';

export function ProfilePage() {
  const { key = '' } = useParams();
  const nav = useNavigate();
  const { session, logout } = useAuth();
  const { toast } = useApp();
  const viewer = session?.profile.id;
  const [tab, setTab] = useState<'vouched' | 'created'>('vouched');
  const { data, error } = useLoad(() => api.getProfile(key, viewer), [key, viewer]);
  const { data: balance } = useLoad(async () => (session ? api.getUsdcBalance(session) : null), [viewer]);

  const mine = !!session && !!data && data.profile.id === session.profile.id;
  // A signed-in user with no activity yet is unknown to the backend: show what the session knows.
  const profile = mine ? { ...data!.profile, ...session!.profile } : data?.profile;

  return (
    <>
      <header className="header">
        <div className="header-title"><button className="back" onClick={() => nav(-1)} aria-label="Back"><BackIcon /></button>{profile ? displayName(profile) : 'Profile'}</div>
      </header>
      {error && <div className="empty"><b>Couldn't load profile</b>{error}</div>}
      {!data && !error && <Skeletons />}
      {data && profile && (
        <>
          <div className="profile-head">
            <div className="profile-row">
              <Avatar profile={profile} size={84} />
              {mine && <button className="btn btn-ghost" onClick={() => { logout(); nav('/'); }}>Sign out</button>}
            </div>
            <h1>{displayName(profile)}</h1>
            {profile.x
              ? <a className="muted" href={`https://x.com/${profile.x.username}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><XLogo /> @{profile.x.username}</a>
              : <span className="muted">No X profile linked</span>}
            <div className="profile-stats">
              <span><b className="mono">{data.created.length}</b> created</span>
              <span><b className="mono">{data.vouched.length}</b> vouched</span>
              <span><b className="mono">{usd(data.vouched.reduce((a, v) => a + v.usd, 0))}</b> total vouched</span>
            </div>
            {mine && (
              <div className="wallet-box">
                <div className="grow">
                  <div className="muted" style={{ fontSize: 13 }}>Your wallet on Base · send USDC here to fund it</div>
                  <b className="mono">{short(profile.wallet)}</b>
                  {balance != null && <span className="muted mono"> · {usd(balance)} USDC</span>}
                </div>
                <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(profile.wallet); toast('Wallet address copied'); }}>Copy address</button>
              </div>
            )}
          </div>
          <div className="tabs" role="tablist" style={{ borderBottom: '1px solid var(--line)' }}>
            {(['vouched', 'created'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
                <span>{t === 'vouched' ? 'Vouched for' : 'Created'}</span>
              </button>
            ))}
          </div>
          {tab === 'vouched' && (data.vouched.length
            ? data.vouched.map((v) => <PostCard key={v.post.id} post={v.post} kicker={`Vouched ${usd(v.usd)}`} />)
            : <div className="empty"><b>No vouches yet</b>Posts this account backs will show up here.</div>)}
          {tab === 'created' && (data.created.length
            ? data.created.map((p) => <PostCard key={p.id} post={p} kicker={`${p.unlocks} unlocks · ${usd(p.buybackUsd)} bought back`} />)
            : <div className="empty"><b>Nothing posted yet</b>Gated posts by this account will show up here.</div>)}
        </>
      )}
    </>
  );
}
