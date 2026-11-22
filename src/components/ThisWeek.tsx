import { useMemo, useState } from 'react';
import type { Playlist, Track } from '../types';
import { usePlaylists } from '../store/playlists';
import { useGroup } from '../group/group';
import { player, usePlayer } from '../player/engine';
import { canPlay, playable } from '../sources';
import { loadShowTracks } from '../resolve/resolve';
import { normTitle } from '../resolve/text';
import { fmt } from './common';

/** Ticket-stub colors, cycled down the list: cream, peach, lavender, mint. */
const STUBS = [
  { bg: '#F6EBD9', ink: '#C6402F', dash: '#D8C3A5' },
  { bg: '#FFD9CF', ink: '#B0331F', dash: '#E7B1A4' },
  { bg: '#E7E0FA', ink: '#4B33A8', dash: '#C3B7E8' },
  { bg: '#CFF1EA', ink: '#0E6A5E', dash: '#9FD3C6' },
];
const STRIPE = ['#FF8A3D', '#E94F8A', '#B9A3FF', '#3CC6B5', '#F6EBD9'];

/** "2026-11-20 · Madison Square Garden" → { date: "11/20", place: "Madison Square Garden" } */
function splitSubtitle(t: Track) {
  const parts = (t.subtitle ?? '').split(' · ');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? '');
  if (!m) return { date: '', place: t.subtitle ?? '' };
  return { date: `${+m[2]}/${+m[3]}`, place: parts.slice(1).join(' · ') };
}

const duration = (t: Track) => (t.endSec && t.startSec != null ? t.endSec - t.startSec : t.durationSec);

async function playFullShow(t: Track) {
  const ref = t.shows?.find((r) => canPlay(r.source));
  if (!ref) return alert('None of your connected services has the full show.');
  try {
    const tracks = await loadShowTracks(ref);
    const n = normTitle(t.title);
    player.playQueue(tracks, Math.max(0, tracks.findIndex((x) => normTitle(x.title) === n)));
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Couldn’t load the full show');
  }
}

export function ThisWeek({ onGoServices }: { onGoServices: () => void }) {
  const all = usePlaylists();
  const g = useGroup();
  const { queue, index, playing } = usePlayer();
  const weeks = useMemo(
    () => all.filter((p) => p.kind === 'weekly').sort((a, b) => b.createdAt - a.createdAt),
    [all],
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const week: Playlist | undefined = weeks.find((w) => w.id === pickedId) ?? weeks[0];
  const nowKey = queue[index]?.key;

  if (!week) {
    return (
      <>
        <WeekHeader title="This Week" sub="The week’s best live jams, picked for you" />
        <div className="empty-week">
          {g ? (
            <>
              <b>The first week is on its way.</b>
              <span>Setlist researches the week’s standout shows every Monday morning and posts them here.</span>
              {g.me.role === 'owner' && (
                <button className="link inline" onClick={onGoServices}>
                  Run it now from Weekly picks →
                </button>
              )}
            </>
          ) : (
            <>
              <b>Join your friends group to get the weekly picks.</b>
              <span>Open the invite link a friend sent you, or paste it under Friends.</span>
              <button className="link inline" onClick={onGoServices}>
                Go to Friends →
              </button>
            </>
          )}
        </div>
      </>
    );
  }

  const isLatest = week.id === weeks[0]?.id;
  const total = week.tracks.reduce((n, t) => n + (duration(t) ?? 0), 0);

  return (
    <>
      <WeekHeader
        title={isLatest ? 'This Week' : week.name.replace(/^Week of /, '')}
        sub={`${week.name} · ${week.tracks.length} jam${week.tracks.length === 1 ? '' : 's'}${total ? ` · ${fmt(total)}` : ''}`}
      />
      <button className="play-side" disabled={!week.tracks.length} onClick={() => player.playQueue(week.tracks, 0)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7 4.5v15l13-7.5z" />
        </svg>
        Play side A
      </button>

      <div className="stubs">
        {week.tracks.map((t, i) => {
          const c = STUBS[i % STUBS.length];
          const { date, place } = splitSubtitle(t);
          const ok = playable(t);
          const on = nowKey === t.key;
          const d = duration(t);
          return (
            <div key={t.key}>
              <button
                className={`stub-card ${ok ? '' : 'dim'} ${on ? 'on' : ''}`}
                style={{ background: c.bg }}
                onClick={() => ok && player.playQueue(week.tracks, i)}
                aria-label={`Play ${t.title} by ${t.artist}`}
              >
                <span className="stub-num" style={{ color: c.ink }}>
                  {on && playing ? '♪' : i + 1}
                </span>
                <span className="stub-main" style={{ borderRightColor: c.dash }}>
                  <span className="stub-title">{t.title}</span>
                  <span className="stub-sub">
                    {t.artist}
                    {place ? ` · ${place}` : ''}
                  </span>
                  {t.note && (
                    <span className="stub-note" style={{ color: c.ink }}>
                      {t.note.length > 120 ? `${t.note.slice(0, 117)}…` : t.note}
                    </span>
                  )}
                </span>
                <span className="stub-side">
                  <span className="stub-date">{date || 'NEW'}</span>
                  {d ? <span className="stub-dur">{fmt(d)}</span> : null}
                </span>
              </button>
              {t.shows?.some((r) => r.source !== 'youtube') && (
                <div className="stub-actions">
                  <button className="link small-link" onClick={() => void playFullShow(t)}>
                    ≣ full show
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {weeks.length > 1 && (
        <div className="past">
          <h2>Past weeks</h2>
          <div className="list">
            {weeks
              .filter((w) => w.id !== week.id)
              .map((w) => (
                <button key={w.id} className="row nav" onClick={() => setPickedId(w.id)}>
                  <span className="track-text">
                    <span className="title">{w.id === weeks[0].id ? `This week · ${w.name}` : w.name}</span>
                    <span className="sub">
                      {w.tracks.length} jams · {w.tracks.map((t) => t.artist).filter((a, i, arr) => arr.indexOf(a) === i).slice(0, 3).join(', ')}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </>
  );
}

function WeekHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="week-head">
      <div className="stripe" aria-hidden="true">
        {STRIPE.map((c) => (
          <i key={c} style={{ background: c }} />
        ))}
      </div>
      <h1 className="week-title">{title}</h1>
      <div className="week-sub">{sub}</div>
    </div>
  );
}
