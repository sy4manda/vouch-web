import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { BackIcon } from '../components/icons';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useAuth } from '../lib/auth';
import { fee } from '../lib/format';
import { FEE_TIERS, MAX_CHARS, MAX_FEE, MIN_FEE } from '../lib/types';

export function Compose() {
  const nav = useNavigate();
  const { session, login } = useAuth();
  const { bump, toast } = useApp();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [preset, setPreset] = useState<number | null>(1);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  const left = MAX_CHARS - text.length;
  const feeUsd = preset ?? Number(custom);
  const feeOk = Number.isFinite(feeUsd) && feeUsd >= MIN_FEE && feeUsd <= MAX_FEE;
  const feeError = preset === null && custom !== '' && !feeOk;
  const valid = title.trim().length > 0 && text.trim().length > 0 && left >= 0 && feeOk;

  const submit = async () => {
    if (!session) return login();
    setBusy(true);
    try {
      const post = await api.createPost({ title: title.trim(), text: text.trim(), feeUsd }, session);
      bump();
      toast('Gated. Your token is live on its curve.');
      nav(`/p/${post.id}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };

  return (
    <>
      <header className="header">
        <div className="header-title"><button className="back" onClick={() => nav(-1)} aria-label="Back"><BackIcon /></button>New post</div>
      </header>
      <div className="compose">
        {session && <Avatar profile={session.profile} />}
        <div className="compose-fields">
          <input className="title" placeholder="Title (public)" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" autoFocus />
          <textarea placeholder="What's worth paying for? (gated)" value={text} onChange={(e) => setText(e.target.value)} aria-label="Gated text" />
          <div className="field-label">Fee to unlock</div>
          <div className="tiers" role="radiogroup" aria-label="Fee to unlock">
            {FEE_TIERS.map((t) => (
              <button key={t} role="radio" aria-checked={preset === t} className={`tier mono${preset === t ? ' on' : ''}`} onClick={() => { setPreset(t); setCustom(''); }}>{fee(t)}</button>
            ))}
            <label className={`tier tier-custom mono${preset === null ? ' on' : ''}${feeError ? ' bad' : ''}`}>
              <span>$</span>
              <input
                inputMode="decimal" placeholder="Other" aria-label="Custom fee in dollars" value={custom}
                onFocus={() => setPreset(null)}
                onChange={(e) => {
                  // digits and one dot, at most two decimals
                  const v = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').replace(/(\.\d\d).+/, '$1');
                  setCustom(v);
                  setPreset(null);
                }}
              />
            </label>
          </div>
          {feeError && <p className="note" style={{ color: 'var(--danger)', marginTop: 8 }}>Enter a fee between {fee(MIN_FEE)} and ${MAX_FEE.toLocaleString('en-US')}.</p>}
          <div className="compose-foot">
            <span className={`count mono${left < 0 ? ' over' : ''}`}>{left}</span>
            <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
              {busy && <i className="spin" />}{session ? `Gate content${feeOk ? ` · ${fee(feeUsd)}` : ''}` : 'Sign in with X to post'}
            </button>
          </div>
          <p className="note">
            The title, your name and the stats are public. The text is only served after payment.
            Every unlock fee buys and burns this post's token. There is a 2.5% fee on vouch interactions, and 80% of it goes to you.
          </p>
        </div>
      </div>
    </>
  );
}
