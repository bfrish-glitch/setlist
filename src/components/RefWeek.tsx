import { useEffect, useState } from 'react';
import { api } from '../group/group';
import { weeklyApi, type WeeklyRun } from '../weekly/weekly';
import { runCost } from './WeeklyPanel';

/**
 * Reference week: a frozen week of candidates you rate once. "Test the prompt"
 * replays it with the current prompt and scores the picks against your ratings.
 */
interface RefShow {
  id: string;
  artist: string;
  date: string;
  venue: string | null;
  rating: 0 | 1 | 2 | null;
}
interface RefInfo {
  ref: { today: number; createdAt: number } | null;
  shows: RefShow[];
  tests: (WeeklyRun & { label: string | null })[];
  running: boolean;
}

const refApi = {
  info: () => api<RefInfo>('/ref'),
  create: () => api<RefInfo>('/ref/create', {}),
  rate: (id: string, rating: number | null) => api('/ref/rate', { id, rating }),
  add: (artist: string, date: string) => api<RefInfo>('/ref/add', { artist, date }),
  del: (id: string) => api<RefInfo>('/ref/delete', { id }),
};

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, '');
/** Same band, allowing co-bills: "Trey Anastasio Band with Billy Strings" matches both bands. */
const same = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  if (x.length < 4 || y.length < 4) return x === y && !!x;
  return x.includes(y) || y.includes(x);
};

/** How a test run did against your ratings. */
export function scoreRun(run: WeeklyRun, shows: RefShow[]) {
  // A co-billed pick can match several rated rows; it counts as the best of them.
  const ratingOf = (p: { artist: string; date: string | null }) => {
    const rs = shows.filter((s) => s.date === p.date && same(s.artist, p.artist) && s.rating !== null).map((s) => s.rating as number);
    if (rs.length) return Math.max(...rs) as 0 | 1 | 2;
    return null;
  };
  const musts = shows.filter((s) => s.rating === 2);
  const caught = musts.filter((m) => run.picks.some((p) => p.date === m.date && same(m.artist, p.artist)));
  const marks = run.picks.map((p) => ratingOf(p));
  return {
    musts: musts.length,
    caught: caught.length,
    missed: musts.filter((m) => !caught.includes(m)),
    maybes: marks.filter((r) => r === 1).length,
    skips: marks.filter((r) => r === 0).length,
    unrated: marks.filter((r) => r === null).length,
    marks,
  };
}

const MARK = { 2: '✓', 1: '~', 0: '✗' } as const;

export function RefWeek({ model, toast }: { model: string; toast: (m: string) => void }) {
  const [info, setInfo] = useState<RefInfo | null>(null);
  const [band, setBand] = useState('');
  const [date, setDate] = useState('');
  const [openTest, setOpenTest] = useState<string | null>(null);
  const [starting, setStarting] = useState<number | null>(null);

  const load = () => refApi.info().then(setInfo, (e) => toast(e.message));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const testing = !!info?.tests.some((t) => t.status === 'running');
  useEffect(() => {
    if (!testing && !starting) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [testing, starting]); // eslint-disable-line react-hooks/exhaustive-deps
  // Clear "starting" once the server shows the new test running or finished.
  useEffect(() => {
    if (starting && info?.tests.some((t) => t.startedAt >= starting - 5000)) setStarting(null);
  }, [info, starting]);

  if (!info) return null;
  const rated = info.shows.filter((s) => s.rating !== null).length;
  const musts = info.shows.filter((s) => s.rating === 2).length;
  const best = info.tests.find((t) => t.status === 'ready');
  const bestScore = best ? scoreRun(best, info.shows) : null;

  const rate = (s: RefShow, r: 0 | 1 | 2) => {
    const next = s.rating === r ? null : r;
    setInfo({ ...info, shows: info.shows.map((x) => (x.id === s.id ? { ...x, rating: next } : x)) });
    void refApi.rate(s.id, next).catch((e) => toast(e.message));
  };

  return (
    <details className="run ref-week">
      <summary className="sub">
        Reference week
        {info.ref ? ` · ${rated} of ${info.shows.length} rated` : ''}
        {bestScore && bestScore.musts ? ` · last test caught ${bestScore.caught} of ${bestScore.musts} musts` : ''}
      </summary>
      {!info.ref ? (
        <div className="sub wrap ref-intro">
          <p>
            Freeze this week’s candidates as an answer key. Rate each show once, then test any prompt change against the same
            week, so changes get judged on more than one run.
          </p>
          <button className="primary small" onClick={() => refApi.create().then(setInfo, (e) => toast(e.message))}>
            Freeze this week
          </button>
        </div>
      ) : (
        <>
          <div className="sub wrap ref-intro">
            Frozen {new Date(info.ref.today).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. <b>Must</b>: belongs on
            the list. <b>Maybe</b>: fine either way. <b>Skip</b>: shouldn’t make it. Tap again to clear.
          </div>
          <div className="ref-shows">
            {info.shows.map((s) => (
              <div key={s.id} className="ref-show">
                <span className="track-text">
                  <span className="title">{s.artist}</span>
                  <span className="sub">
                    {s.date.slice(5).replace('-', '/')}
                    {s.venue ? ` · ${s.venue}` : ''}
                  </span>
                </span>
                <span className="seg">
                  {([2, 1, 0] as const).map((r) => (
                    <button key={r} className={s.rating === r ? `on r${r}` : ''} onClick={() => rate(s, r)}>
                      {r === 2 ? 'Must' : r === 1 ? 'Maybe' : 'Skip'}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
          <form
            className="ref-add"
            onSubmit={(e) => {
              e.preventDefault();
              refApi.add(band, date).then(
                (r) => {
                  setInfo(r);
                  setBand('');
                  setDate('');
                },
                (err) => toast(err.message),
              );
            }}
          >
            <input value={band} onChange={(e) => setBand(e.target.value)} placeholder="Band" />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="small" disabled={!band.trim() || !date}>
              Add missing show
            </button>
          </form>
          <div className="btns">
            <button
              className="primary small"
              disabled={testing || !!starting || musts === 0}
              onClick={async () => {
                setStarting(Date.now());
                try {
                  await weeklyApi.run('test');
                  toast('Replaying the reference week. Takes a few minutes.');
                  void load();
                } catch (e) {
                  setStarting(null);
                  toast(e instanceof Error ? e.message : 'Couldn’t start the test');
                }
              }}
            >
              {testing || starting ? 'Testing…' : 'Test the current prompt (≈ $0.80)'}
            </button>
            <button
              className="small"
              onClick={() =>
                confirm('Re-freeze from your latest run? This clears your ratings.') && refApi.create().then(setInfo, (e) => toast(e.message))
              }
            >
              Re-freeze
            </button>
          </div>
          {musts === 0 && <div className="sub">Mark at least one Must to test against.</div>}
          {info.tests.map((t) => {
            if (t.status === 'running') return <div key={t.id} className="sub ref-test">Testing {t.label ?? ''}…</div>;
            if (t.status === 'error') return <div key={t.id} className="sub ref-test warn">Test failed: {t.error}</div>;
            const sc = scoreRun(t, info.shows);
            return (
              <div key={t.id} className="ref-test">
                <button className="link small-link" onClick={() => setOpenTest(openTest === t.id ? null : t.id)}>
                  {new Date(t.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ·{' '}
                  {t.label} · <b>caught {sc.caught} of {sc.musts} musts</b>
                  {sc.maybes ? ` · ${sc.maybes} maybe` : ''}
                  {sc.skips ? ` · ${sc.skips} skip${sc.skips === 1 ? '' : 's'} picked` : ''}
                  {sc.unrated ? ` · ${sc.unrated} unrated` : ''} · ${runCost(t, model).toFixed(2)}
                </button>
                {openTest === t.id && (
                  <div className="sub wrap">
                    {t.picks.map((p, i) => (
                      <div key={i}>
                        {sc.marks[i] === null ? '?' : MARK[sc.marks[i] as 0 | 1 | 2]} {p.artist} {p.date?.slice(5).replace('-', '/')}
                        {p.highlight ? ` · ${p.highlight}` : ''}
                      </div>
                    ))}
                    {sc.missed.length > 0 && (
                      <div>
                        <b>Missed musts:</b> {sc.missed.map((m) => `${m.artist} ${m.date.slice(5).replace('-', '/')}`).join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </details>
  );
}
