import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { CurveChart } from '../components/CurveChart';
import { BackIcon, CheckIcon } from '../components/icons';
import { PostText, Skeletons, useUnlock } from '../components/PostCard';
import { api } from '../lib/api';
import { useApp, useLoad } from '../lib/app';
import { useAuth } from '../lib/auth';
import { ago, displayName, fee, handle, num, profilePath, short, usd } from '../lib/format';
import { CREATOR_FEE_SHARE, DEFAULT_SLIPPAGE, SLIPPAGE_PRESETS, TRADE_FEE, type PostDetail, type Quote, type SellQuote } from '../lib/types';

type Side = 'buy' | 'sell';

const clean = (v: string) => v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');

function Slippage({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [custom, setCustom] = useState('');
  const isPreset = custom === '' && SLIPPAGE_PRESETS.includes(value);
  return (
    <>
      <div className="field-label">Max slippage</div>
      <div className="seg" role="radiogroup" aria-label="Max slippage">
        {SLIPPAGE_PRESETS.map((v) => (
          <button key={v} role="radio" aria-checked={isPreset && value === v} className={`mono${isPreset && value === v ? ' on' : ''}`} onClick={() => { setCustom(''); onChange(v); }}>{v}%</button>
        ))}
        <input
          className={`mono${!isPreset ? ' on' : ''}`} inputMode="decimal" placeholder="custom" aria-label="Custom max slippage in percent" value={custom}
          onChange={(e) => {
            const v = clean(e.target.value).slice(0, 4);
            setCustom(v);
            const n = Number(v);
            if (v === '') onChange(DEFAULT_SLIPPAGE);
            else if (n > 0 && n <= 50) onChange(n);
          }}
        />
      </div>
      <p className="note" style={{ marginTop: 8 }}>Currently {value}%. The price can move between quoting and confirming; the trade reverts rather than filling worse than this.</p>
    </>
  );
}

function TradePanel({ post, onPreview }: { post: PostDetail; onPreview: (supplyAfter: number | null) => void }) {
  const { session, login } = useAuth();
  const { bump, toast } = useApp();
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('10');
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE);
  const [buyQuote, setBuyQuote] = useState<Quote | null>(null);
  const [sellQuote, setSellQuote] = useState<SellQuote | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const value = Number(amount);
  const held = post.myTokens;
  const tooMany = side === 'sell' && value > held * 1.000001;
  const ok = Number.isFinite(value) && value > 0 && !tooMany;
  const sym = post.tokenSymbol;

  const switchSide = (next: Side) => { setSide(next); setAmount(next === 'buy' ? '10' : ''); };

  useEffect(() => {
    let live = true;
    setBuyQuote(null); setSellQuote(null);
    if (!ok) { onPreview(null); return; }
    const t = setTimeout(() => {
      if (side === 'buy') api.quoteBuy(post.id, value).then((q) => { if (live) { setBuyQuote(q); onPreview(post.supplySold + q.tokensOut); } }, () => {});
      else api.quoteSell(post.id, value).then((q) => { if (live) { setSellQuote(q); onPreview(post.supplySold - q.tokensIn); } }, () => {});
    }, 150);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, post.id, post.supplySold]);

  useEffect(() => {
    if (!session) return setBalance(null);
    api.getUsdcBalance(session).then(setBalance, () => setBalance(null));
  }, [session, post.supplySold, post.unlocks]);

  const submit = async () => {
    if (!session) return login();
    setBusy(true);
    try {
      if (side === 'buy') {
        await api.buy(post.id, value, slippage, session);
        toast(`Vouched ${usd(value)} on ${sym}.`);
      } else {
        await api.sell(post.id, value, slippage, session);
        toast(`Sold ${num(value)} ${sym}${sellQuote ? ` for ${usd(sellQuote.usdOut)}` : ''}.`);
        setAmount('');
      }
      bump();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const quote = side === 'buy' ? buyQuote : sellQuote;
  return (
    <div className="trade">
      <div className="side" role="tablist">
        {(['buy', 'sell'] as Side[]).map((v) => (
          <button key={v} role="tab" aria-selected={side === v} className={side === v ? 'on' : ''} onClick={() => switchSide(v)}>{v}</button>
        ))}
      </div>
      <div className="trade-body">
        <div className="field-label" style={{ marginTop: 0 }}>{side === 'buy' ? 'You pay · USDC' : `You sell · ${sym}`}</div>
        <div className="amount-row">
          <label className={`amount${tooMany ? ' bad' : ''}`}>
            {side === 'buy' && <span className="muted">$</span>}
            <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(clean(e.target.value))} aria-label={side === 'buy' ? 'Amount in USDC' : `Amount of ${sym} to sell`} />
          </label>
          {side === 'sell' && <button className="btn btn-ghost max" disabled={held <= 0} onClick={() => setAmount(String(Math.floor(held * 1e4) / 1e4))}>Max</button>}
        </div>
        {side === 'buy'
          ? <div className="chips">{[1, 10, 50, 100].map((v) => <button key={v} className="chip mono" onClick={() => setAmount(String(v))}>${v}</button>)}</div>
          : <p className="note" style={{ marginTop: 8, color: tooMany ? 'var(--danger)' : undefined }}>{session ? (tooMany ? `You only hold ${num(held)} ${sym}.` : `You hold ${num(held)} ${sym}.`) : 'Sign in to see your balance.'}</p>}

        <div className="receive">
          <div className="field-label" style={{ marginTop: 0 }}>You receive</div>
          <b className="mono">{side === 'buy' ? `${buyQuote ? num(buyQuote.tokensOut) : '0'} ${sym}` : `${sellQuote ? sellQuote.usdOut.toFixed(2) : '0.00'} USDC`}</b>
          <span className="muted mono">{side === 'buy' ? (buyQuote ? `at about ${usd(value / buyQuote.tokensOut)} each` : '–') : (sellQuote ? `at about ${usd(sellQuote.usdOut / value)} each` : '$0')}</span>
        </div>

        <Slippage value={slippage} onChange={setSlippage} />

        <div className="quote" style={{ marginTop: 14 }}>
          <div><span>{TRADE_FEE * 100}% fee on vouch interactions, {CREATOR_FEE_SHARE * 100}% goes to the creator</span><b className="mono">{quote ? usd(quote.feeUsd) : '–'}</b></div>
          <div><span>Market cap after</span><b className="mono">{quote ? usd(quote.marketCapAfterUsd) : '–'}</b></div>
          {balance !== null && <div><span>Your balance</span><b className="mono">{usd(balance)} USDC</b></div>}
        </div>
        <button className={`btn btn-lg ${side === 'buy' ? 'btn-accent' : 'btn-primary'}`} disabled={busy || (!!session && !ok)} onClick={submit}>
          {busy && <i className="spin" />}
          {!session ? `Sign in with X to ${side === 'buy' ? 'vouch' : 'sell'}` : side === 'buy' ? `Vouch ${ok ? usd(value) : ''}` : `Sell ${sym}`}
        </button>
        {post.myVouchUsd > 0 && <p className="note">You have <b className="mono">{usd(post.myVouchUsd)}</b> vouched on this post.</p>}
      </div>
    </div>
  );
}

export function PostPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { session } = useAuth();
  const { toast } = useApp();
  const viewer = session?.profile.id;
  const { data: post, error } = useLoad(() => api.getPost(id, viewer), [id, viewer]);
  const [preview, setPreview] = useState<number | null>(null);

  const head = (
    <header className="header">
      <div className="header-title"><button className="back" onClick={() => nav(-1)} aria-label="Back"><BackIcon /></button>Vouch</div>
    </header>
  );
  if (error) return <>{head}<div className="empty"><b>Couldn't load this post</b>{error}</div></>;
  if (!post) return <>{head}<Skeletons /></>;

  const top = post.topVouchers[0]?.usd ?? 1;
  return (
    <>
      {head}
      <PostHeader post={post} />
      <div className="stats">
        <div className="stat"><span>Market cap</span><b className="mono">{usd(post.marketCapUsd)}</b></div>
        <div className="stat"><span>Vouchers</span><b className="mono">{post.vouchers}</b></div>
        <div className="stat"><span>Unlocks</span><b className="mono">{post.unlocks}</b></div>
        <div className="stat"><span>Bought back & burned</span><b className="mono">{usd(post.buybackUsd)}</b></div>
      </div>

      <section className="section">
        <div className="price-row">
          <span className="price-big mono">{usd(post.priceUsd)}</span>
          <span className="muted">per {post.tokenSymbol} · {num(post.supplySold)} sold · {num(post.burned)} burned</span>
        </div>
        <CurveChart curve={post.curve} supplySold={post.supplySold} preview={preview ?? undefined} />
        <button className="addr mono" onClick={() => { navigator.clipboard?.writeText(post.tokenAddress); toast('Token address copied'); }}>
          {post.tokenSymbol} · {short(post.tokenAddress)} · copy
        </button>
      </section>

      <section className="section">
        <h2>Trade this post's token</h2>
        <TradePanel post={post} onPreview={setPreview} />
      </section>

      <section className="section">
        <h2>Top vouchers</h2>
        {post.topVouchers.length === 0 && <p className="muted">No one has vouched yet. The first buyer gets the lowest price on the curve.</p>}
        {post.topVouchers.map((v, i) => (
          <Link to={profilePath(v.profile)} className="leader" key={v.profile.id}>
            <span className="n mono">{i + 1}</span>
            <Avatar profile={v.profile} size={36} />
            <div className="who">
              <b>{displayName(v.profile)}</b>
              <span className="muted">{v.profile.x ? handle(v.profile) : 'wallet'} · {num(v.tokens)} {post.tokenSymbol}</span>
              <div className="bar" style={{ width: `${(v.usd / top) * 100}%` }} />
            </div>
            <b className="mono">{usd(v.usd)}</b>
          </Link>
        ))}
      </section>
    </>
  );
}

function PostHeader({ post }: { post: PostDetail }) {
  const { unlock, busy } = useUnlock(post);
  return (
    <section className="section">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <Link to={profilePath(post.creator)}><Avatar profile={post.creator} size={44} /></Link>
        <Link to={profilePath(post.creator)} style={{ lineHeight: 1.25, minWidth: 0 }}>
          <b style={{ display: 'block' }}>{displayName(post.creator)}</b>
          <span className="muted">{handle(post.creator)} · {ago(post.createdAt)}</span>
        </Link>
        <div className="actions" style={{ width: 'auto', marginLeft: 'auto' }}>
          {post.unlocked
            ? <span className="unlocked-tag"><CheckIcon /> Unlocked</span>
            : <button className="btn btn-primary" onClick={unlock} disabled={busy}>{busy && <i className="spin" />}Unlock {fee(post.feeUsd)}</button>}
        </div>
      </div>
      <h1 className="post-title" style={{ fontSize: 21 }}>{post.title}</h1>
      <PostText post={post} />
    </section>
  );
}
