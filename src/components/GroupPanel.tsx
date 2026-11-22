import { useEffect, useState } from 'react';
import { group, useGroup } from '../group/group';

function ago(ms?: number) {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'active now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function GroupPanel({ onStart, toast }: { onStart: () => void; toast: (m: string) => void }) {
  const s = useGroup();
  const [initialized, setInitialized] = useState<boolean | null>(null);

  useEffect(() => {
    if (s) void group.refresh().catch(() => {});
    else group.status().then((r) => setInitialized(r.initialized), () => setInitialized(null));
  }, [s?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s) {
    return (
      <div className="group-card">
        <div className="title">Friends group</div>
        {initialized === false ? (
          <>
            <p className="sub wrap">No group yet. Start one and you’ll get an invite link to send your friends.</p>
            <button className="primary small" onClick={onStart}>
              Start the group
            </button>
          </>
        ) : (
          <p className="sub wrap">
            You’re not in the group on this device. Ask a friend for the invite link and open it here.
          </p>
        )}
      </div>
    );
  }

  const link = group.inviteUrl();
  const share = async () => {
    if (!link) return;
    const text = 'Join our Setlist group to listen along:';
    if (navigator.share) await navigator.share({ title: 'Setlist', text, url: link }).catch(() => {});
    else {
      await navigator.clipboard.writeText(link).catch(() => {});
      toast('Invite link copied');
    }
  };
  const owner = s.me.role === 'owner';

  return (
    <div className="group-card">
      <div className="group-head">
        <div>
          <div className="title">Friends group</div>
          <div className="sub">
            You’re{' '}
            <button
              className="link inline"
              onClick={() => {
                const n = prompt('Your name in the group', s.me.name);
                if (n?.trim()) void group.rename(n).catch((e) => toast(e.message));
              }}
            >
              {s.me.name}
            </button>
            {owner ? ' · owner' : ''}
          </div>
        </div>
        <button className="primary small" onClick={share} disabled={!link}>
          Invite friends
        </button>
      </div>

      <div className="members">
        {s.members.map((m) => (
          <div key={m.id} className="member">
            <span className="avatar">{m.name.slice(0, 1).toUpperCase()}</span>
            <span className="track-text">
              <span className="title">
                {m.name}
                {m.id === s.me.id ? ' (you)' : ''}
              </span>
              <span className="sub">{m.role === 'owner' ? 'owner · ' : ''}{ago(m.lastSeen)}</span>
            </span>
            {owner && m.id !== s.me.id && (
              <button
                className="icon danger"
                title="Remove from group"
                onClick={() => confirm(`Remove ${m.name} from the group?`) && void group.removeMember(m.id).catch((e) => toast(e.message))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="btns">
        {owner && (
          <button
            onClick={() =>
              confirm('Make a new invite link? The old one stops working (people already in stay in).') &&
              void group.rotateInvite().then(() => toast('New invite link ready'), (e) => toast(e.message))
            }
          >
            Reset invite link
          </button>
        )}
        <button
          className="danger"
          onClick={() =>
            confirm(
              owner
                ? 'You’re the group owner. If you sign out, nobody can reset the invite link or remove people anymore. Sign out anyway?'
                : 'Sign out of the group on this device? You’ll need the invite link to get back in.',
            ) && group.leave()
          }
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
