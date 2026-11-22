import { useEffect, useState } from 'react';
import { useGroup } from '../group/group';
import { player } from '../player/engine';
import type { Track } from '../types';
import {
  autoPublishIfReady,
  publishWeek,
  resolveWeeklyPick,
  songsFor,
  weekName,
  weeklyApi,
  type WeeklyConfig,
  type WeeklyInfo,
  type WeeklyRun,
} from '../weekly/weekly';
import { TrackRow } from './common';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const when = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

export function WeeklyPanel({ toast }: { toast: (m: string) => void }) {
  const g = useGroup();
  const [info, setInfo] = useState<WeeklyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WeeklyConfig | null>(null);
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
  const last = info.runs[0];

  const save = async (patch: Partial<WeeklyConfig> & { resetPrompt?: boolean }) => {
    try {
      setInfo(await weeklyApi.save(patch));
      toast('Saved');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t save');
    }
  };

  const runNow = async () => {
    try {
      setInfo(await weeklyApi.run());
      setWaitingSince(Date.now());
      toast('Researching this week’s picks. Takes a few minutes.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Couldn’t start a run');
    }
  };

  return (
    <div className="group-card">
      <div className="group-head">
        <div>
          <div className="title">Weekly picks</div>
          <div className="sub wrap">
            {cfg.enabled
              ? `Every ${DAYS[cfg.day]} at ${cfg.hour % 12 || 12}${cfg.hour < 12 ? 'am' : 'pm'} ET · next ${when(info.nextRun)}`
              : 'Paused'}
            {cfg.autoPublish ? ' · publishes automatically' : ' · owner reviews first'}
          </div>
        </div>
        {owner && (
          <button className="primary small" disabled={!info.hasKey || running || waiting} onClick={runNow}>
            {running || waiting ? 'Running…' : 'Run now'}
          </button>
        )}
      </div>
      {owner && !info.hasKey && (
        <div className="warn">
          Waiting on the Anthropic API key. Add it as the repo secret ANTHROPIC_API_KEY, then redeploy the server.
        </div>
      )}
      <div className="sub wrap">Bands: {cfg.bands.join(', ')} · up to {cfg.showsPerBand} shows each · {cfg.newArtists} new artist{cfg.newArtists === 1 ? '' : 's'}</div>

      {last && <RunSummary run={last} owner={owner} onReview={() => setReview(last)} />}

      {owner && !editing && (
        <div className="btns">
          <button onClick={() => { setDraft({ ...cfg }); setEditing(true); }}>Edit settings & prompt</button>
          <button onClick={() => save({ enabled: !cfg.enabled })}>{cfg.enabled ? 'Pause' : 'Resume'}</button>
        </div>
      )}

      {owner && editing && draft && (
        <div className="weekly-form">
          <label>
            Bands (one per line)
            <textarea
              rows={3}
              value={draft.bands.join('\n')}
              onChange={(e) => setDraft({ ...draft, bands: e.target.value.split('\n') })}
            />
          </label>
          <div className="row-fields">
            <label>
              Shows per band
              <select value={draft.showsPerBand} onChange={(e) => setDraft({ ...draft, showsPerBand: +e.target.value })}>
                {[1, 2, 3].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label>
              New artists
              <select value={draft.newArtists} onChange={(e) => setDraft({ ...draft, newArtists: +e.target.value })}>
                {[0, 1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
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
            Placeholders: {'{{bands}}'}, {'{{showsPerBand}}'}, {'{{newArtists}}'}, {'{{today}}'}, {'{{already}}'} (shows picked in past weeks). The
            output format is added automatically.
          </p>
          <div className="btns">
            <button
              className="primary"
              onClick={async () => {
                await save({ ...draft, bands: draft.bands.map((b) => b.trim()).filter(Boolean) });
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

function RunSummary({ run, owner, onReview }: { run: WeeklyRun; owner: boolean; onReview: () => void }) {
  const [open, setOpen] = useState(false);
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
              {run.searches} searches · {Math.round(((run.inputTokens ?? 0) + (run.outputTokens ?? 0)) / 1000)}k tokens
            </span>
          )}
        </span>
        {run.picks.length > 0 && (
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
            </li>
          ))}
          {run.missed.length > 0 && <li className="warn">Couldn’t find: {run.missed.join(', ')}</li>}
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
        return r?.status === 'ok' ? { label, tracks: songsFor(r) } : { label, tracks: [], error: r?.error ?? 'Not found' };
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
        <div className="sheet-title">{weekName(run.finishedAt ?? run.startedAt)}</div>
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
