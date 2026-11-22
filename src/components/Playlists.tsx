import { useRef, useState } from 'react';
import { playlists, usePlaylists } from '../store/playlists';
import { player, usePlayer } from '../player/engine';
import { playable, sourceOrder, sources } from '../sources';
import { Header, Loading, SourceBadge, TrackRow, fmt } from './common';
import { useGroup } from '../group/group';
import { loadShowTracks } from '../resolve/resolve';
import { canPlay } from '../sources';
import type { Track } from '../types';
import { normTitle } from '../resolve/text';

export function Playlists() {
  const all = usePlaylists();
  const g = useGroup();
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const liveId = openId ? playlists.currentId(openId) : null;
  if (liveId && playlists.get(liveId)) return <PlaylistDetail id={liveId} onBack={() => setOpenId(null)} />;

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
      {!g && (
        <div className="warn pad">
          These playlists live on this phone only. Join your friends group (Services) to share them.
        </div>
      )}
      {g && !playlists.isLoaded() && <Loading what="shared playlists" />}
      {playlists.lastError() && <div className="warn pad">{playlists.lastError()}</div>}
      {all.length === 0 && playlists.isLoaded() && (
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
                <span className="title">
                  {p.kind === 'weekly' ? '📅 ' : ''}
                  {p.name}
                </span>
                <span className="sub">
                  {p.tracks.length} {p.tracks.length === 1 ? "track" : "tracks"}{p.createdBy ? ` · by ${p.createdBy}` : ''}{' '}
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

/** Play the whole show a song came from, starting at that song. */
async function playFullShow(t: Track) {
  const ref = t.shows?.find((r) => canPlay(r.source));
  if (!ref) {
    alert('None of your connected services has the full show.');
    return;
  }
  try {
    const tracks = await loadShowTracks(ref);
    if (!tracks.length) throw new Error('That show came back empty');
    const n = normTitle(t.title);
    const start = Math.max(0, tracks.findIndex((x) => normTitle(x.title) === n));
    player.playQueue(tracks, start);
  } catch (e) {
    alert(e instanceof Error ? e.message : 'Couldn’t load the full show');
  }
}

function PlaylistDetail({ id, onBack }: { id: string; onBack: () => void }) {
  usePlaylists(); // re-render on changes
  const p = playlists.get(id)!;
  const { queue, index } = usePlayer();
  const nowKey = queue[index]?.key;
  const [editing, setEditing] = useState(false);

  const total = p.tracks.reduce((n, t) => n + (t.durationSec ?? 0), 0);
  const unplayable = p.tracks.filter((t) => !playable(t));
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
          {p.tracks.length} {p.tracks.length === 1 ? "track" : "tracks"}{total ? ` · ${fmt(total)}` : ''}
          {p.createdBy ? ` · made by ${p.createdBy}` : ''}
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
                if (confirm(`Delete "${p.name}"${playlists.isShared() ? ' for everyone' : ''}?`)) {
                  void Promise.resolve(playlists.remove(id)).then(onBack, (e) => alert(e.message));
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
            showNote
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
              ) : t.shows?.length && !(t.shows.length === 1 && t.shows[0].source === 'youtube') ? (
                <button className="icon" title="Play full show" onClick={() => void playFullShow(t)}>
                  ≣
                </button>
              ) : undefined
            }
          />
        ))}
      </div>
    </>
  );
}
