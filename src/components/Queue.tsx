import { player, usePlayer } from '../player/engine';
import { Header, TrackRow } from './common';

export function Queue({ onAdd }: { onAdd: (t: import('../types').Track[]) => void }) {
  const { queue, index, skipped } = usePlayer();
  return (
    <>
      <Header
        title="Queue"
        right={
          queue.length > 0 ? (
            <button className="link" onClick={() => onAdd(queue)}>
              Save as playlist
            </button>
          ) : undefined
        }
      />
      {queue.length === 0 && <div className="empty">Nothing queued. Play a show or a playlist.</div>}
      {skipped.length > 0 && (
        <div className="warn pad">Skipped {skipped.length} track(s) from services that aren’t connected yet.</div>
      )}
      <div className="list">
        {queue.map((t, i) => (
          <TrackRow key={t.key} track={t} index={i} active={i === index} onPlay={() => player.jump(i)} />
        ))}
      </div>
    </>
  );
}
