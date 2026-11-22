import { sourceOrder, sources } from '../sources';
import { Header } from './common';
import { useSourcesVersion } from '../sources/changes';
import { GroupPanel } from './GroupPanel';
import { WeeklyPanel } from './WeeklyPanel';
import { BUILD } from '../update';
import { OwnSpotify } from './OwnSpotify';

const label = { ready: 'Ready', 'needs-login': 'Sign in', 'coming-soon': 'Coming soon' } as const;

export function Services(props: { onNugsLogin: () => void; onStartGroup: () => void; onJoinCode: (code: string) => void; toast: (m: string) => void }) {
  const { onNugsLogin } = props;
  useSourcesVersion();
  return (
    <>
      <Header title="Services" />
      <GroupPanel onStart={props.onStartGroup} onJoinCode={props.onJoinCode} toast={props.toast} />
      <WeeklyPanel toast={props.toast} />
      <div className="set-name">Your music services</div>
      <div className="list">
        {sourceOrder.map((id) => {
          const s = sources[id];
          const status = s.status();
          return (
            <div key={id} className="row service">
              <span className="dot" style={{ background: s.color }} />
              <span className="track-text">
                <span className="title">{s.name}</span>
                <span className="sub">{s.statusNote()}</span>
              </span>
              {status === 'needs-login' && (s.connect || id === 'nugs') ? (
                <button className="primary small" onClick={() => (id === 'nugs' ? onNugsLogin() : s.connect!())}>
                  Connect
                </button>
              ) : status === 'ready' && s.disconnect ? (
                <span className="svc-actions">
                  <span className={`pill ${status}`}>{label[status]}</span>
                  <button className="link small-link" onClick={() => s.disconnect!()}>
                    Sign out
                  </button>
                </span>
              ) : (
                <span className={`pill ${status}`}>{label[status]}</span>
              )}
            </div>
          );
        })}
      </div>
      <OwnSpotify toast={props.toast} />
      <p className="fine">
        Music services are per person and per device: each friend connects their own. When a shared playlist has a
        song you can’t play, Setlist uses another service you do have, or skips it.
      </p>
      <p className="fine">Version {BUILD}</p>
    </>
  );
}
