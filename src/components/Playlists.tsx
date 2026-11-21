import { useRef, useState } from 'react';
import { playlists, usePlaylists } from '../store/playlists';
import { player, usePlayer } from '../player/engine';
import { canPlay, sourceOrder, sources } from '../sources';
import { Header, SourceBadge, TrackRow, fmt } from './common';

export function Playlists() {
  const all = usePlaylists();
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (openId && playlists.get(openId)) return <PlaylistDetail id={openId} onBack={() => setOpenId(null)} />;

  const create = () => {
    const name = prompt('Playlist name');
    if (name != null) setOpenId(playlists.create(name).id);
  };

  const importFile = async (f: File) => {
    try {
      setOpenId(playlists.importJson(await f.text()).id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not import that file');
    }
  };

  return (
    <>
      <Header
        title="Playlists"
        right={
          <>
            <button className="icon" title="Import" onClick={() => fileRef.current?.click()}>
              ⇪
            </button>
            <button className="icon" title="New playlist" onClick={create}>
              +
            </button>
          </>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
      />
      {all.length === 0 && (
        <div className="empty">
          No playlists yet. Tap + to make one, or add songs from Browse. Playlists can mix any sources.
        </div>
      )}
      <div className="list">
        {all.map((p) => {
          const counts = sourceOrder
            .map((s) => [s, p.tracks.filter((t) => t.source === s).length] as const)
            .filter(([, n]) => n > 0);
          return (
            <button key={p.id} className="row nav" onClick={() => setOpenId(p.id)}>
              <span className="track-text">
                <span className="title">{p.name}</span>
                <span className="sub">
                  {p.tracks.length} tracks{' '}
                  {counts.map(([s]) => (
                    <SourceBadge key={s} track={{ source: s }} />
                  ))}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function PlaylistDetail({ id, onBack }: { id: string; onBack: () => void }) {
  usePlaylists(); // re-render on changes
  const p = playlists.get(id)!;
  const { queue, index } = usePlayer();
  const nowKey = queue[index]?.key;
  const [editing, setEditing] = useState(false);

  const total = p.tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
  const unplayable = p.tracks.filter((t) => !canPlay(t.source));
  const missing = [...new Set(unplayable.map((t) => sources[t.source].name))];

  const share = async () => {
    const json = playlists.exportJson(id);
    const file = new File([json], `${p.name.replace(/[^\w-]+/g, '_')}.setlist.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: p.name }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };

  return (
    <>
      <Header
        title={p.name}
        onBack={onBack}
        right={
          <button className="link" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        }
      />
      <div className="show-head">
        <div className="sub">
          {p.tracks.length} tracks{total ? ` · ${fmt(total)}` : ''}
        </div>
        {missing.length > 0 && (
          <div className="warn">
            {unplayable.length} track{unplayable.length > 1 ? 's' : ''} will be skipped until you connect{' '}
            {missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]}.
          </div>
        )}
        <div className="btns">
          <button className="primary" disabled={!p.tracks.length} onClick={() => player.playQueue(p.tracks, 0)}>
            ▶ Play
          </button>
          <button
            disabled={!p.tracks.length}
            onClick={() => {
              const shuffled = [...p.tracks].sort(() => Math.random() - 0.5);
              player.playQueue(shuffled, 0);
            }}
          >
            ⤮ Shuffle
          </button>
          <button onClick={share}>Share</button>
        </div>
        {editing && (
          <div className="btns">
            <button
              onClick={() => {
                const name = prompt('Rename playlist', p.name);
                if (name != null) playlists.rename(id, name);
              }}
            >
              Rename
            </button>
            <button
              className="danger"
              onClick={() => {
                if (confirm(`Delete "${p.name}"?`)) {
                  playlists.remove(id);
                  onBack();
                }
              }}
            >
              Delete playlist
            </button>
          </div>
        )}
      </div>
      {p.tracks.length === 0 && <div className="empty">Empty. Add songs from Browse with the + button.</div>}
      <div className="list">
        {p.tracks.map((t, i) => (
          <TrackRow
            key={t.key}
            track={t}
            index={i}
            active={nowKey === t.key}
            onPlay={() => player.playQueue(p.tracks, i)}
            actions={
              editing ? (
                <>
                  <button className="icon" disabled={i === 0} onClick={() => playlists.moveTrack(id, i, i - 1)}>
                    ↑
                  </button>
                  <button
                    className="icon"
                    disabled={i === p.tracks.length - 1}
                    onClick={() => playlists.moveTrack(id, i, i + 1)}
                  >
                    ↓
                  </button>
                  <button className="icon danger" onClick={() => playlists.removeTrack(id, t.key)}>
                    ✕
                  </button>
                </>
              ) : undefined
            }
          />
        ))}
      </div>
    </>
  );
}
