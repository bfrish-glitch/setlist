import { disablePush, enablePush, usePushState } from '../group/push';
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

/** Paste an invite or device link (or just its code) when opening the link directly didn't work. */
function PasteLink({ onJoinCode, toast }: { onJoinCode: (code: string) => void; toast: (m: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const t = text.trim();
    const device = /device=([\w-]+)/.exec(t)?.[1];
    const join = /join=([\w-]+)/.exec(t)?.[1];
    if (device) {
      setBusy(true);
      try {
        const me = await group.redeemDevice(device);
        toast(`Signed in as ${me.name} on this device`);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'That link didn’t work');
      } finally {
        setBusy(false);
      }
    } else if (join) onJoinCode(join);
    else toast('Paste the whole link you were sent');
  };
  return (
    <form
      className="fix-row"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <input placeholder="Paste an invite or device link" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="small" disabled={busy || !text.trim()}>
        Go
      </button>
    </form>
  );
}

export function GroupPanel({ onStart, onJoinCode, toast }: { onStart: () => void; onJoinCode: (code: string) => void; toast: (m: string) => void }) {
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
            You’re not in the group on this device. Open the invite link (or your own “Use on another device” link)
            here, or paste it below.
          </p>
        )}
        <PasteLink onJoinCode={onJoinCode} toast={toast} />
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

      <NotifyRow toast={toast} />

      <div className="btns">
        <button
          onClick={async () => {
            try {
              const url = await group.deviceLink();
              const text = 'Open this on your other device to sign in as you (works once, for 15 minutes):';
              if (navigator.share) await navigator.share({ title: 'Setlist on another device', text, url }).catch(() => {});
              else {
                await navigator.clipboard.writeText(url).catch(() => {});
                prompt('Device link copied. Open it on your other device within 15 minutes:', url);
              }
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Couldn’t make a device link');
            }
          }}
        >
          Use on another device
        </button>
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

function NotifyRow({ toast }: { toast: (m: string) => void }) {
  const [state, refresh] = usePushState();
  const [busy, setBusy] = useState(false);
  if (state === 'loading' || state === 'unsupported') return null;
  const copy: Record<string, string> = {
    'needs-install': 'To get a ping when a new week is up: tap Share, then Add to Home Screen, and open Setlist from there.',
    denied: 'Notifications are blocked for Setlist. Turn them on in your phone’s Settings.',
    off: 'Get a ping when a new week goes up.',
    on: 'On for this device. You’ll get a ping when a new week goes up.',
  };
  return (
    <div className="notify-row">
      <span className="track-text">
        <span className="title">Notifications</span>
        <span className="sub wrap">{copy[state]}</span>
      </span>
      {(state === 'off' || state === 'on') && (
        <button
          className={state === 'off' ? 'primary small' : 'small'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (state === 'off') {
                await enablePush();
                toast('Notifications on. A test ping is on its way.');
              } else {
                await disablePush();
                toast('Notifications off for this device');
              }
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Couldn’t change notifications');
            } finally {
              setBusy(false);
              refresh();
            }
          }}
        >
          {state === 'off' ? 'Turn on' : 'Turn off'}
        </button>
      )}
    </div>
  );
}
