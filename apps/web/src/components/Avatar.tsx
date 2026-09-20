import type { Profile } from '@vouch/shared';

const hues = [210, 265, 330, 20, 160, 45, 190, 290];

export function Avatar({ profile, size = 40 }: { profile: Profile; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (profile.x?.avatarUrl) return <img className="avatar" style={style} src={profile.x.avatarUrl} alt="" />;
  const hue = hues[parseInt(profile.id.slice(2, 6), 16) % hues.length];
  const label = profile.x ? profile.x.name[0] : profile.wallet.slice(2, 4);
  return <div className="avatar" style={{ ...style, background: `hsl(${hue} 55% 42%)` }} aria-hidden>{label}</div>;
}
