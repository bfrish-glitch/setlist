import { player, usePlayer } from '../player/engine';
import { resolve } from '../sources';
import { SourceBadge, fmt } from './common';
import { nugs } from '../sources/nugs';
import { youtube } from '../sources/youtube';
import { useSourcesVersion } from '../sources/changes';

export function NowPlaying({ onOpenQueue }: { onOpenQueue: () => void }) {
  const s = usePlayer();
  useSourcesVersion();
  const raw = s.queue[s.index];
  const t = raw ? (resolve(raw) ?? raw) : undefined;
  if (!t) return s.error ? <div className="now error-bar">{s.error}</div> : null;

  const pct = s.durationSec ? Math.min(100, (s.positionSec / s.durationSec) * 100) : 0;

  return (
    <div className={`now ${s.playing ? 'playing' : ''}`}>
      <input
        className="scrub"
        type="range"
        min={0}
        max={s.durationSec || 0}
        step={1}
        value={s.positionSec}
        onChange={(e) => player.seek(Number(e.target.value))}
        style={{ ['--pct' as string]: `${pct}%` }}
        aria-label="Seek"
      />
      <div className="now-row">
        <span className="cassette" aria-hidden="true">
          <i />
          <i />
        </span>
        <button className="now-text" onClick={onOpenQueue} aria-label="Open the queue">
          <div className="title">{t.title}</div>
          <div className="sub">
            <SourceBadge track={t} />
            {t.source === 'nugs' && nugs.formatFor(t.sourceId) && <span className="fmt">{nugs.formatFor(t.sourceId)}</span>}{' '}
            {t.artist}
            {t.subtitle ? ` · ${t.subtitle}` : ''}
          </div>
        </button>
        <div className="now-time mono">
          {fmt(s.positionSec) || '0:00'} / {fmt(s.durationSec)}
        </div>
        <div className="controls">
          <button className="icon" onClick={() => player.prev()} aria-label="Previous">
            ⏮
          </button>
          <button className="icon big" onClick={() => player.toggle()} aria-label={s.playing ? 'Pause' : 'Play'}>
            {s.loading ? '…' : s.playing ? '⏸' : '▶'}
          </button>
          <button className="icon" onClick={() => player.next()} aria-label="Next">
            ⏭
          </button>
        </div>
      </div>
      {t.source === 'youtube' && youtube.needsTap && (
        <div className="warn">Tap the video once to start it. Your phone blocks videos from starting on their own.</div>
      )}
      {s.error && <div className="error-bar">{s.error}</div>}
    </div>
  );
}
