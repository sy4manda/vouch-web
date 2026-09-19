import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Avatar } from './components/Avatar';
import { HomeIcon, UserIcon, XLogo } from './components/icons';
import { api, DEMO_DATA } from './lib/api';
import { useLoad } from './lib/app';
import { useAuth } from './lib/auth';
import { displayName, handle, profilePath, usd } from './lib/format';
import { resetMock } from './lib/mockApi';
import { CREATOR_FEE_SHARE, TRADE_FEE } from './lib/types';
import { Compose } from './pages/Compose';
import { Feed } from './pages/Feed';
import { PostPage } from './pages/PostPage';
import { ProfilePage } from './pages/ProfilePage';

function Logo() {
  return <Link to="/" className="logo"><b>vouch</b><i /></Link>;
}

function LeftRail() {
  const { session, login, ready } = useAuth();
  const nav = useNavigate();
  const me = session ? profilePath(session.profile) : null;
  return (
    <aside className="rail">
      <Logo />
      <NavLink to="/" end className={({ isActive }) => `nav${isActive ? ' active' : ''}`}><HomeIcon /><span>Home</span></NavLink>
      {me
        ? <NavLink to={me} className={({ isActive }) => `nav${isActive ? ' active' : ''}`}><UserIcon /><span>Profile</span></NavLink>
        : <button className="nav" onClick={login} disabled={!ready}><UserIcon /><span>Profile</span></button>}
      <button className="btn btn-primary" onClick={() => nav('/post')} aria-label="New post">+<span>&nbsp;POST</span></button>
      {!session && (
        <div className="signin">
          <p>Sign in to unlock posts, vouch for them and publish your own.</p>
          <button className="btn btn-primary" onClick={login} disabled={!ready} aria-label="Sign in with X"><XLogo /><span>Sign in with X</span></button>
        </div>
      )}
      {session && (
        <Link to={me!} className="me">
          <Avatar profile={session.profile} size={38} />
          <div className="me-text"><b>{displayName(session.profile)}</b><span className="muted">{handle(session.profile)}</span></div>
        </Link>
      )}
    </aside>
  );
}

function RightRail() {
  const { data } = useLoad(() => api.listPosts('trending'), []);
  return (
    <aside className="rail rail-right">
      <div className="panel">
        <h3>Most vouched</h3>
        {(data ?? []).slice(0, 5).map((p, i) => (
          <Link to={`/p/${p.id}`} className="top-row" key={p.id}>
            <span className="mono muted" style={{ width: 14 }}>{i + 1}</span>
            <div className="t"><b>{p.title}</b><span className="muted">{displayName(p.creator)} · {p.unlocks} unlocks</span></div>
            <span className="mono" style={{ color: 'var(--accent)' }}>{usd(p.marketCapUsd)}</span>
          </Link>
        ))}
      </div>
      <div className="panel">
        <h3>How it works</h3>
        <ul className="steps">
          <li><b>Post</b> up to 280 characters behind a fixed fee.</li>
          <li><b>Unlock</b> pays that fee once. All of it buys the post's token and burns it.</li>
          <li><b>Vouch</b> buys the token on its curve. The market cap is the ranking.</li>
          <li><b>Earn:</b> {TRADE_FEE * 100}% fee on vouch interactions, {CREATOR_FEE_SHARE * 100}% goes to the creator.</li>
        </ul>
      </div>
    </aside>
  );
}

function BottomNav() {
  const { session, login } = useAuth();
  const composing = useLocation().pathname === '/post';
  return (
    <>
      {!composing && <Link to="/post" className="fab" aria-label="New post">+</Link>}
      <nav className="bottom-nav">
        <NavLink to="/" aria-label="Home"><HomeIcon /></NavLink>
        {session
          ? <NavLink to={profilePath(session.profile)} aria-label="Profile"><UserIcon /></NavLink>
          : <button onClick={login} aria-label="Sign in with X"><UserIcon /></button>}
      </nav>
    </>
  );
}

export default function App() {
  const { demo } = useAuth();
  return (
    <div className="shell">
      <LeftRail />
      <main className="main">
        {(demo || DEMO_DATA) && (
          <div className="demo-banner">
            <span>Demo mode: {DEMO_DATA ? 'sample data' : 'live data'}, {demo ? 'no real wallet' : 'Privy login'}. Nothing is on-chain.</span>
            {DEMO_DATA && <button onClick={() => { resetMock(); location.reload(); }}>Reset</button>}
          </div>
        )}
        <Routes>
          <Route path="/" element={<Feed />} />
          <Route path="/post" element={<Compose />} />
          <Route path="/p/:id" element={<PostPage />} />
          <Route path="/u/:key" element={<ProfilePage />} />
          <Route path="*" element={<div className="empty"><b>Nothing here</b>That page doesn't exist.</div>} />
        </Routes>
      </main>
      <RightRail />
      <BottomNav />
    </div>
  );
}
