import { sourceOrder, sources } from '../sources';
import { Header } from './common';
import { useSourcesVersion } from '../sources/changes';

const label = { ready: 'Ready', 'needs-login': 'Sign in', 'coming-soon': 'Coming soon' } as const;

export function Services({ onNugsLogin }: { onNugsLogin: () => void }) {
  useSourcesVersion();
  return (
    <>
      <Header title="Services" />
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
      <p className="fine">
        Each person signs into their own accounts. Setlist never sees the music files from paid services, it just
        tells each service’s own player what to play next.
      </p>
    </>
  );
}
