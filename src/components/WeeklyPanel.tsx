import { useEffect, useState } from 'react';
import { useGroup } from '../group/group';
import { player } from '../player/engine';
import type { Track } from '../types';
import {
  autoPublishIfReady,
  publishWeek,
  resolveWeeklyPick,
  songsFor,
  runName,
  weeklyApi,
  type DiscoveryConfig,
  type RunKind,
  type WeeklyConfig,
  type WeeklyInfo,
  type WeeklyRun,
} from '../weekly/weekly';
import { TrackRow } from './common';
import { ensureFreeSource } from '../sources/ytsearch';

// Claude API list prices (USD): per million tokens, and per search. Update if prices change.
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-haiku-5-5': { in: 0.5, out: 2.5 },
};
const SEARCH_COST = 0.01;

/** Rough cost of a run, from its token and search counts. */
export function runCost(r: { inputTokens?: number; outputTokens?: number; searches?: number }, model: string) {
  const p = PRICES[model] ?? PRICES['claude-sonnet-5-5'];
  return ((r.inputTokens ?? 0) * p.in + (r.outputTokens ?? 0) * p.out) / 1e6 + (r.searches ?? 0) * SEARCH_COST;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const when = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

export function WeeklyPanel({ toast }: { toast: (m: string) => void }) {
  const g = useGroup();
  const [info, setInfo] = useState<WeeklyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WeeklyConfig | null>(null);
  const [limitsText, setLimitsText] = useState('');
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<WeeklyRun | null>(null);
  /** Set when Run now is tapped: keep checking until that run is done. */
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const owner = g?.me.role === 'owner';

  const load = () =>
    weeklyApi.info().then(
      (i) => {
        setInfo(i);
        setError(null);
      },
      (e) => setError(e.message),
    );

  useEffect(() => {
    if (!g) return;
    void load();
  }, [g?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // While a run is going (or one was just requested), check back every 8 seconds.
  const running = info?.runs.some((r) => r.status === 'running');
  const newest = info?.runs[0];
  const waiting = waitingSince != null && !(newest && newest.startedAt >= waitingSince - 5000 && newest.status !== 'running');
  useEffect(() => {
    if (!running && !waiting) return;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [running, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  // A requested run just finished: publish it right away if the group auto-publishes.
  useEffect(() => {
    if (waitingSince == null || waiting || !newest) return;
    setWaitingSince(null);
    if (newest.status === 'error') toast('The weekly run failed. See the details below.');
    else if (newest.status === 'ready' && info?.config.autoPublish)
      void autoPublishIfReady(toast).then((m) => {
        if (m) toast(m);
        void load();
      });
  }, [waiting, newest?.id, newest?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!g) return null;
  if (error) return <div className="group-card"><div className="title">Weekly picks</div><div className="warn">{error}</div></div>;
  if (!info) return null;

  const cfg = info.config;
  const last = info.runs.find((r) => (r.kind ?? 'weekly') === 'weekly');
  const lastB = info.runs.find((r) => r.kind === 'discovery');

  const save = async (patch: (Partial<WeeklyConfig> | Partial<DiscoveryConfig>) & { resetPrompt?: boolean; kind?: RunKind }) => {
    try {
      setInfo(await weeklyApi.save(patch));
      toast('Saved');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t save');
    }
  };

  const runNow = async (kind: RunKind = 'weekly') => {
    try {
      setInfo(await weeklyApi.run(kind));
      setWaitingSince(Date.now());
      toast(kind === 'discovery' ? 'Looking for new bands. Takes a few minutes.' : 'Researching this week’s picks. Takes a few minutes.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t start a run');
    }
  };

  return (
    <div className="group-card">
      <div className="group-head">
        <div>
          <div className="title">Side A · Weekly jams</div>
          <div className="sub wrap">
            {cfg.enabled
              ? `Every ${DAYS[cfg.day]} at ${cfg.hour % 12 || 12}${cfg.hour < 12 ? 'am' : 'pm'} ET · next ${when(info.nextRun)}`
              : 'Paused'}
            {cfg.autoPublish ? ' · publishes automatically' : ' · owner reviews first'}
          </div>
        </div>
        {owner && (
          <button className="primary small" disabled={!info.hasKey || running || waiting} onClick={() => runNow('weekly')}>
            {running || waiting ? 'Running…' : 'Run now'}
          </button>
        )}
      </div>
      {owner && !info.hasKey && (
        <div className="warn">
          Waiting on the Anthropic API key. Add it as the repo secret ANTHROPIC_API_KEY, then redeploy the server.
        </div>
      )}
      <div className="sub wrap">
        Up to {cfg.picks} jams from the last {cfg.windowDays} days · max {cfg.maxPerBand} per band
        {Object.entries(cfg.bandLimits ?? {}).map(([b, n]) => ` · ${b} max ${n}`).join('')} · {cfg.newArtists} new artist
        {cfg.newArtists === 1 ? '' : 's'}
      </div>
      <div className="sub wrap">Always checks: {cfg.watchlist.join(', ')}, plus anything great in the recap sites.</div>

      {last && <RunSummary run={last} owner={owner} model={cfg.model} onReview={() => setReview(last)} />}

      {owner && !editing && (
        <div className="btns">
          <button
            onClick={() => {
              setDraft({ ...cfg });
              setLimitsText(Object.entries(cfg.bandLimits ?? {}).map(([b, n]) => `${b}: ${n}`).join('\n'));
              setEditing(true);
            }}
          >
            Edit settings & prompt
          </button>
          <button onClick={() => save({ enabled: !cfg.enabled })}>{cfg.enabled ? 'Pause' : 'Resume'}</button>
        </div>
      )}

      {owner && editing && draft && (
        <div className="weekly-form">
          <label>
            Watchlist: bands checked every week (one per line)
            <textarea
              rows={5}
              value={draft.watchlist.join('\n')}
              onChange={(e) => setDraft({ ...draft, watchlist: e.target.value.split('\n') })}
            />
          </label>
          <label>
            Band limits (one per line, like “Goose: 1”)
            <textarea
              rows={2}
              value={limitsText}
              onChange={(e) => setLimitsText(e.target.value)}
            />
          </label>
          <div className="row-fields">
            <label>
              Jams per week
              <select value={draft.picks} onChange={(e) => setDraft({ ...draft, picks: +e.target.value })}>
                {[4, 5, 6, 7, 8, 9, 10, 12].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label>
              Max per band
              <select value={draft.maxPerBand} onChange={(e) => setDraft({ ...draft, maxPerBand: +e.target.value })}>
                {[1, 2, 3].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div className="row-fields">
            <label>
              Shows from the last
              <select value={draft.windowDays} onChange={(e) => setDraft({ ...draft, windowDays: +e.target.value })}>
                {[7, 10, 14, 21, 30].map((n) => <option key={n} value={n}>{n} days</option>)}
              </select>
            </label>
            <label>
              New artists
              <select value={draft.newArtists} onChange={(e) => setDraft({ ...draft, newArtists: +e.target.value })}>
                {[0, 1, 2, 3].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div className="row-fields">
            <label>
              Day
              <select value={draft.day} onChange={(e) => setDraft({ ...draft, day: +e.target.value })}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
            <label>
              Time (ET)
              <select value={draft.hour} onChange={(e) => setDraft({ ...draft, hour: +e.target.value })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{`${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={draft.autoPublish} onChange={(e) => setDraft({ ...draft, autoPublish: e.target.checked })} />
            Publish automatically (off = you review the picks first)
          </label>
          <label>
            Curator prompt
            <textarea rows={12} value={draft.prompt ?? ''} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
          </label>
          <p className="fine">
            Placeholders: {'{{today}}'}, {'{{windowStart}}'}, {'{{watchlist}}'}, {'{{picks}}'}, {'{{maxPerBand}}'}, {'{{bandLimits}}'},{' '}
            {'{{newArtists}}'}, {'{{already}}'} (shows picked in past weeks). The output format is added automatically, and band limits are
            enforced even if the prompt is edited.
          </p>
          <div className="btns">
            <button
              className="primary"
              onClick={async () => {
                const bandLimits: Record<string, number> = {};
                for (const line of limitsText.split('\n')) {
                  const m = /^(.+?)\s*[:=]\s*(\d)\s*$/.exec(line.trim());
                  if (m) bandLimits[m[1].trim()] = Number(m[2]);
                }
                await save({ ...draft, watchlist: draft.watchlist.map((b) => b.trim()).filter(Boolean), bandLimits });
                setEditing(false);
              }}
            >
              Save
            </button>
            <button onClick={() => setEditing(false)}>Cancel</button>
            <button
              className="danger"
              onClick={async () => {
                if (!confirm('Put the original prompt back?')) return;
                await save({ resetPrompt: true });
                setEditing(false);
              }}
            >
              Reset prompt
            </button>
          </div>
        </div>
      )}

      <SideB
        info={info}
        owner={owner}
        busy={!!running || waiting}
        last={lastB}
        onRun={() => runNow('discovery')}
        onSave={(patch) => save({ ...patch, kind: 'discovery' } as Partial<WeeklyConfig>)}
        onReview={(r) => setReview(r)}
      />

      {review && (
        <ReviewSheet
          run={review}
          onClose={(msg) => {
            setReview(null);
            if (msg) toast(msg);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RunSummary({ run, owner, model, onReview }: { run: WeeklyRun; owner: boolean; model: string; onReview: () => void }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const [why, setWhy] = useState(false);
  const considered = run.considered ?? [];
  const passed = considered.filter((c) => c.decision === 'passed');
  const label =
    run.status === 'running'
      ? `Researching… started ${when(run.startedAt)}`
      : run.status === 'error'
        ? `Last run failed (${when(run.startedAt)})`
        : `${run.status === 'published' ? 'Published' : 'Ready'}: ${run.picks.length} picks · ${when(run.finishedAt)}`;
  return (
    <div className="run">
      <div className="run-head">
        <span className={`status-dot ${run.status === 'error' ? 'bad' : run.status === 'running' ? 'mid' : 'good'}`} />
        <span className="track-text">
          <span className="title">{label}</span>
          {run.error && <span className="sub wrap">{run.error}</span>}
          {owner && run.searches != null && (
            <span className="sub">
              {run.searches} searches · {Math.round(((run.inputTokens ?? 0) + (run.outputTokens ?? 0)) / 1000)}k tokens · ≈ $
              {runCost(run, model).toFixed(2)}
            </span>
          )}
        </span>
        {(run.picks.length > 0 || (run.dropped?.length ?? 0) > 0 || run.raw || considered.length > 0) && (
          <button className="link" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Picks'}
          </button>
        )}
      </div>
      {open && (
        <ul className="run-picks">
          {run.picks.map((p, i) => (
            <li key={i}>
              <b>{p.artist}</b>
              {p.date ? ` · ${p.date}` : ''}
              {p.highlight ? ` · ★ ${p.highlight}` : ''}
              <div className="sub wrap">{p.why}</div>
              {p.caveats && <div className="sub wrap">Caveat: {p.caveats}</div>}
            </li>
          ))}
          {run.missed.length > 0 && <li className="warn">Couldn’t find a playable source: {run.missed.join(', ')}</li>}
          {(run.dropped?.length ?? 0) > 0 && (
            <li className="sub wrap">
              <b>Left out by your settings:</b>
              {run.dropped!.map((d, i) => (
                <div key={i}>
                  {d.artist}
                  {d.date ? ` ${d.date}` : ''}
                  {d.highlight ? ` (${d.highlight})` : ''}: {d.reason}
                </div>
              ))}
            </li>
          )}
          {(considered.length > 0 || run.candidates) && (
            <li>
              <button className="link small-link" onClick={() => setWhy((v) => !v)}>
                {why ? 'Hide' : 'Show'} what it considered
                {considered.length ? ` (${considered.length} shows, ${passed.length} passed)` : ''}
              </button>
              {why && (
                <div className="sub wrap considered">
                  {passed.length > 0 && <b>Passed on:</b>}
                  {passed.map((c, i) => (
                    <div key={`p${i}`}>
                      {c.artist}
                      {c.date ? ` ${c.date}` : ''}: {c.reason}
                    </div>
                  ))}
                  {considered.some((c) => c.decision === 'picked') && <b>Picked:</b>}
                  {considered
                    .filter((c) => c.decision === 'picked')
                    .map((c, i) => (
                      <div key={`k${i}`}>
                        {c.artist}
                        {c.date ? ` ${c.date}` : ''}: {c.reason}
                      </div>
                    ))}
                  {run.candidates && (
                    <>
                      <b>
                        Candidate list: {run.candidates.articles.length} recaps, {run.candidates.shows.length} shows
                      </b>
                      {run.candidates.sources.map((s, i) => (
                        <div key={`s${i}`}>
                          {s.ok ? '✓' : '✗'} {s.name}: {s.ok ? s.count : s.error || 'failed'}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </li>
          )}
          {owner && run.raw && (
            <li>
              <button className="link small-link" onClick={() => setRaw((v) => !v)}>
                {raw ? 'Hide' : 'Show'} Claude’s full answer
              </button>
              {raw && <pre className="raw">{run.raw}</pre>}
            </li>
          )}
        </ul>
      )}
      {owner && run.status === 'ready' && (
        <div className="btns">
          <button className="primary" onClick={onReview}>Review & publish</button>
        </div>
      )}
    </div>
  );
}

/** Owner review: resolve every pick on this phone, show what will go in, publish. */
function ReviewSheet({ run, onClose }: { run: WeeklyRun; onClose: (msg?: string) => void }) {
  const [rows, setRows] = useState<{ label: string; tracks: Track[]; error?: string }[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all(
      run.picks.map(async (p) => {
        const r = await resolveWeeklyPick(p).catch(() => null);
        const label = `${p.artist}${p.date ? ` · ${p.date}` : ''}`;
        if (r?.status !== 'ok') return { label, tracks: [], error: r?.error ?? 'Not found' };
        return { label, tracks: await Promise.all(songsFor(r).map((t) => ensureFreeSource(t))) };
      }),
    ).then((x) => alive && setRows(x));
    return () => {
      alive = false;
    };
  }, [run.id]);

  const tracks = rows?.flatMap((r) => r.tracks) ?? [];
  const missed = rows?.filter((r) => !r.tracks.length).map((r) => r.label) ?? [];

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet review-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">{runName(run)}</div>
        {!rows && <div className="empty">Finding every pick…</div>}
        {rows?.map((r, i) => (
          <div key={i}>
            <div className="set-name">{r.label}</div>
            {r.error ? (
              <div className="warn pad">{r.error}</div>
            ) : (
              <div className="list">
                {r.tracks.map((t) => (
                  <TrackRow key={t.key} track={t} showNote onPlay={() => player.playQueue(tracks, tracks.indexOf(t))} />
                ))}
              </div>
            )}
          </div>
        ))}
        {rows && (
          <div className="btns pad">
            <button
              className="primary"
              disabled={busy || !tracks.length}
              onClick={async () => {
                setBusy(true);
                try {
                  const p = await publishWeek(run, tracks, missed);
                  onClose(`${p.name} published`);
                } catch (e) {
                  setBusy(false);
                  alert(e instanceof Error ? e.message : 'Couldn’t publish');
                }
              }}
            >
              Publish {tracks.length} songs
            </button>
            <button onClick={() => onClose()}>Not now</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Side B: New to Your Radar. Its own schedule, settings and prompt. */
function SideB(props: {
  info: WeeklyInfo;
  owner: boolean;
  busy: boolean;
  last?: WeeklyRun;
  onRun: () => void;
  onSave: (patch: Partial<DiscoveryConfig> & { resetPrompt?: boolean }) => Promise<void>;
  onReview: (r: WeeklyRun) => void;
}) {
  const { info, owner, last } = props;
  const d = info.discovery;
  const [draft, setDraft] = useState<DiscoveryConfig | null>(null);
  if (!d) return null;
  return (
    <div className="side-b">
      <div className="group-head">
        <div>
          <div className="title">Side B · New to Your Radar</div>
          <div className="sub wrap">
            {d.enabled
              ? `Every ${DAYS[d.day]} at ${d.hour % 12 || 12}${d.hour < 12 ? 'am' : 'pm'} ET · next ${when(info.nextDiscovery)}`
              : 'Paused'}
            {` · ${d.bands === 1 ? '1 new band' : `1–${d.bands} new bands`}, ${d.songsPerBand} songs each`}
          </div>
        </div>
        {owner && (
          <button className="primary small" disabled={!info.hasKey || props.busy} onClick={props.onRun}>
            {props.busy ? 'Running…' : 'Run now'}
          </button>
        )}
      </div>
      {last && <RunSummary run={last} owner={owner} model={d.model} onReview={() => props.onReview(last)} />}
      {owner && !draft && (
        <div className="btns">
          <button onClick={() => setDraft({ ...d })}>Edit Side B</button>
          <button onClick={() => void props.onSave({ enabled: !d.enabled })}>{d.enabled ? 'Pause' : 'Resume'}</button>
        </div>
      )}
      {owner && draft && (
        <div className="weekly-form">
          <div className="row-fields">
            <label>
              New bands per week
              <select value={draft.bands} onChange={(e) => setDraft({ ...draft, bands: +e.target.value })}>
                {[1, 2, 3].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label>
              Songs per band
              <select value={draft.songsPerBand} onChange={(e) => setDraft({ ...draft, songsPerBand: +e.target.value })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div className="row-fields">
            <label>
              Day
              <select value={draft.day} onChange={(e) => setDraft({ ...draft, day: +e.target.value })}>
                {DAYS.map((x, i) => <option key={x} value={i}>{x}</option>)}
              </select>
            </label>
            <label>
              Time (ET)
              <select value={draft.hour} onChange={(e) => setDraft({ ...draft, hour: +e.target.value })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{`${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={draft.autoPublish} onChange={(e) => setDraft({ ...draft, autoPublish: e.target.checked })} />
            Publish automatically
          </label>
          <label>
            Discovery prompt
            <textarea rows={10} value={draft.prompt ?? ''} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
          </label>
          <p className="fine">Placeholders: {'{{today}}'}, {'{{bands}}'}, {'{{songs}}'}, {'{{scene}}'} (your watchlist), {'{{already}}'} (bands already featured).</p>
          <div className="btns">
            <button className="primary" onClick={async () => { await props.onSave(draft); setDraft(null); }}>Save</button>
            <button onClick={() => setDraft(null)}>Cancel</button>
            <button className="danger" onClick={async () => { if (confirm('Put the original Side B prompt back?')) { await props.onSave({ resetPrompt: true }); setDraft(null); } }}>Reset prompt</button>
          </div>
        </div>
      )}
    </div>
  );
}
