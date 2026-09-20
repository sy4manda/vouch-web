import { useRef, useState } from 'react';
import { num, usd } from '../lib/format';
import type { CurvePoint } from '@vouch/shared';

const W = 600, H = 220, PAD = { l: 8, r: 8, t: 26, b: 22 };

/** The bonding curve, with the sold portion filled and a marker at the current price. */
export function CurveChart({ curve, supplySold, preview }: { curve: CurvePoint[]; supplySold: number; preview?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Zoom so the current position sits around 45% of the width, else the early curve is a flat line.
  const full = curve[curve.length - 1].supply;
  const maxS = Math.min(full, Math.max(supplySold * 2.2, full * 0.08));
  const pts = curve.filter((p) => p.supply <= maxS);
  const at = (s: number) => {
    const i = Math.max(1, curve.findIndex((p) => p.supply >= s));
    const a = curve[i - 1], b = curve[i] ?? a;
    const t = b.supply === a.supply ? 0 : (s - a.supply) / (b.supply - a.supply);
    return a.priceUsd + (b.priceUsd - a.priceUsd) * t;
  };
  pts.push({ supply: maxS, priceUsd: at(maxS) });
  const maxP = at(maxS);
  const x = (s: number) => PAD.l + (s / maxS) * (W - PAD.l - PAD.r);
  const y = (p: number) => H - PAD.b - (p / maxP) * (H - PAD.t - PAD.b);
  const line = (list: CurvePoint[]) => list.map((p, i) => `${i ? 'L' : 'M'}${x(p.supply).toFixed(1)},${y(p.priceUsd).toFixed(1)}`).join('');

  const sold = [...pts.filter((p) => p.supply < supplySold), { supply: supplySold, priceUsd: at(supplySold) }];
  const after = preview && preview > supplySold ? Math.min(preview, maxS) : null;
  const gain = after ? [{ supply: supplySold, priceUsd: at(supplySold) }, ...pts.filter((p) => p.supply > supplySold && p.supply < after), { supply: after, priceUsd: at(after) }] : null;
  const before = preview !== undefined && preview < supplySold ? Math.max(0, preview) : null;
  const loss = before !== null ? [{ supply: before, priceUsd: at(before) }, ...pts.filter((p) => p.supply > before && p.supply < supplySold), { supply: supplySold, priceUsd: at(supplySold) }] : null;
  const base = H - PAD.b;

  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const s = ((e.clientX - r.left) / r.width * W - PAD.l) / (W - PAD.l - PAD.r) * maxS;
    setHover(Math.min(maxS, Math.max(0, s)));
  };

  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bonding curve. ${num(supplySold)} tokens sold, current price ${usd(at(supplySold))}.`}
        onPointerMove={move} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
        <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} stroke="var(--line-strong)" />
        <path d={`${line(sold)}L${x(supplySold)},${base}L${x(0)},${base}Z`} fill="var(--accent-soft)" />
        {gain && <path d={`${line(gain)}L${x(after!)},${base}L${x(supplySold)},${base}Z`} fill="var(--accent)" opacity="0.35" />}
        {loss && <path d={`${line(loss)}L${x(supplySold)},${base}L${x(before!)},${base}Z`} fill="var(--danger)" opacity="0.3" />}
        <path d={line(pts)} fill="none" stroke="var(--faint)" strokeWidth="2" strokeDasharray="2 5" strokeLinecap="round" />
        <path d={line(sold)} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={base} stroke="var(--muted)" strokeWidth="1" />}
        {hover !== null && <circle cx={x(hover)} cy={y(at(hover))} r="4" fill="var(--ink)" stroke="var(--bg)" strokeWidth="2" />}
        <circle cx={x(supplySold)} cy={y(at(supplySold))} r="5.5" fill="var(--accent)" stroke="var(--bg)" strokeWidth="2" />
        <text x={PAD.l} y={H - 5} fontSize="11" fill="var(--muted)">0</text>
        <text x={W - PAD.r} y={H - 5} fontSize="11" fill="var(--muted)" textAnchor="end">{num(maxS)} tokens sold</text>
        <text x={x(supplySold)} y={y(at(supplySold)) - 12} fontSize="12" fontWeight="600" fill="var(--ink)" textAnchor={supplySold / maxS > 0.8 ? 'end' : 'middle'}>now</text>
      </svg>
      {hover !== null && (
        <div className="chart-tip mono" style={{ left: `${Math.min(86, Math.max(14, (x(hover) / W) * 100))}%` }}>
          {num(hover)} sold · {usd(at(hover))}
        </div>
      )}
    </div>
  );
}
