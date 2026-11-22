import type { ReactNode } from 'react';
import type { Track } from '../types';
import { resolve, sources } from '../sources';

export function fmt(sec?: number) {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function SourceBadge({ track }: { track: Pick<Track, 'source'> }) {
  const s = sources[track.source];
  return (
    <span className="badge" style={{ background: s.color }} title={s.name}>
      {s.name}
    </span>
  );
}

export function TrackRow(props: {
  track: Track;
  index?: number;
  active?: boolean;
  onPlay?: () => void;
  actions?: ReactNode;
  /** Show the curator's note under the song. */
  showNote?: boolean;
}) {
  const { active, onPlay, actions, index } = props;
  const resolved = resolve(props.track);
  const playable = resolved !== null;
  const track = resolved ?? props.track;
  return (
    <div className={`row track ${active ? 'active' : ''} ${playable ? '' : 'dim'}`}>
      <button className="track-main" onClick={onPlay} disabled={!playable || !onPlay}>
        {index != null && <span className="num">{index + 1}</span>}
        <span className="track-text">
          <span className="title">{track.title}</span>
          <span className="sub">
            <SourceBadge track={track} /> {track.artist}
            {track.subtitle ? ` · ${track.subtitle}` : ''}
            {track.addedBy ? ` · added by ${track.addedBy}` : ''}
          </span>
          {props.showNote && track.note && <span className="track-note">“{track.note}”</span>}
        </span>
        <span className="dur">{fmt(track.endSec && track.startSec != null ? track.endSec - track.startSec : track.durationSec)}</span>
      </button>
      {actions && <span className="track-actions">{actions}</span>}
    </div>
  );
}

export function Header({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <div className="header">
      {onBack ? (
        <button className="icon" onClick={onBack} aria-label="Back">
          ‹
        </button>
      ) : (
        <span className="icon-spacer" />
      )}
      <h1>{title}</h1>
      <span className="header-right">{right}</span>
    </div>
  );
}

export function Loading({ what }: { what?: string }) {
  return <div className="empty">Loading{what ? ` ${what}` : ''}…</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="empty error">{error instanceof Error ? error.message : String(error)}</div>;
}
