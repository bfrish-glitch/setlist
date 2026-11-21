import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Track } from '../types';
import { spotify, spotifyApi, spotifyToTrack, type SpotifyPlaylist } from '../sources/spotify';
import { useSourcesVersion } from '../sources/changes';
import { player, usePlayer } from '../player/engine';
import { ErrorBox, Header, Loading, TrackRow } from './common';
import { useAsync } from './useAsync';

type View = { kind: 'home' } | { kind: 'liked' } | { kind: 'playlist'; playlist: SpotifyPlaylist };

export function SpotifyBrowse({ onAdd, switcher }: { onAdd: (t: Track[]) => void; switcher: ReactNode }) {
  useSourcesVersion();
  const [view, setView] = useState<View>({ kind: 'home' });
  const home = () => setView({ kind: 'home' });

  const status = spotify.status();
  if (status !== 'ready')
    return (
      <>
        <Header title="Spotify" />
        {switcher}
        <div className="empty">
          {status === 'coming-soon' ? (
            spotify.statusNote()
          ) : (
            <>
              <p>Connect your Spotify Premium account to search and mix Spotify songs into playlists.</p>
              <button className="primary pill-btn" onClick={() => spotify.connect()}>
                Connect Spotify
              </button>
            </>
          )}
        </div>
      </>
    );

  if (view.kind === 'liked')
    return (
      <>
        <Header title="Liked Songs" onBack={home} />
        <TrackList load={spotifyApi.likedTracks} deps={['liked']} onAdd={onAdd} />
      </>
    );
  if (view.kind === 'playlist')
    return (
      <>
        <Header title={view.playlist.name} onBack={home} />
        <TrackList load={() => spotifyApi.playlistTracks(view.playlist.id)} deps={[view.playlist.id]} onAdd={onAdd} />
      </>
    );
  return (
    <>
      <Header title="Spotify" />
      {switcher}
      <Home onAdd={onAdd} open={setView} />
    </>
  );
}

function Home({ onAdd, open }: { onAdd: (t: Track[]) => void; open: (v: View) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Track[] | null>(null);
  const [searchErr, setSearchErr] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const lists = useAsync(spotifyApi.myPlaylists, []);

  useEffect(() => {
    clearTimeout(timer.current);
    const needle = q.trim();
    if (needle.length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(() => {
      spotifyApi.searchTracks(needle).then(
        (r) => {
          setSearchErr(null);
          setResults(r.map(spotifyToTrack));
        },
        setSearchErr,
      );
    }, 300);
  }, [q]);

  return (
    <>
      <input
        className="search"
        placeholder="Search Spotify songs"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        enterKeyHint="search"
      />
      {searchErr != null && <ErrorBox error={searchErr} />}
      {results ? (
        <Tracks tracks={results} onAdd={onAdd} />
      ) : (
        <div className="list">
          <button className="row nav" onClick={() => open({ kind: 'liked' })}>
            <span className="title">Liked Songs</span>
          </button>
          {lists.loading && <Loading what="your playlists" />}
          {lists.error != null && <ErrorBox error={lists.error} />}
          {(lists.data ?? []).map((p) => (
            <button key={p.id} className="row nav" onClick={() => open({ kind: 'playlist', playlist: p })}>
              <span className="track-text">
                <span className="title">{p.name}</span>
                <span className="sub">
                  {(p.items ?? p.tracks)?.total ?? ''} {p.owner?.display_name ? `· ${p.owner.display_name}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function TrackList({ load, deps, onAdd }: { load: () => Promise<import('../sources/spotify').SpotifyTrack[]>; deps: unknown[]; onAdd: (t: Track[]) => void }) {
  const { data, error, loading } = useAsync(async () => (await load()).map(spotifyToTrack), deps);
  return (
    <>
      {loading && <Loading what="songs" />}
      {error != null && <ErrorBox error={error} />}
      {data && data.length > 0 && (
        <div className="show-head">
          <div className="btns">
            <button className="primary" onClick={() => player.playQueue(data, 0)}>
              ▶ Play all
            </button>
            <button onClick={() => onAdd(data)}>+ Add all to playlist</button>
          </div>
        </div>
      )}
      {data && <Tracks tracks={data} onAdd={onAdd} />}
    </>
  );
}

function Tracks({ tracks, onAdd }: { tracks: Track[]; onAdd: (t: Track[]) => void }) {
  const { queue, index } = usePlayer();
  const now = queue[index]?.sourceId;
  if (!tracks.length) return <div className="empty">No songs found.</div>;
  return (
    <div className="list">
      {tracks.map((t, i) => (
        <TrackRow
          key={t.key}
          track={t}
          active={now === t.sourceId}
          onPlay={() => player.playQueue(tracks, i)}
          actions={
            <>
              <button className="icon" title="Add to queue" onClick={() => player.enqueue([t])}>
                ⤓
              </button>
              <button className="icon" title="Add to playlist" onClick={() => onAdd([t])}>
                +
              </button>
            </>
          }
        />
      ))}
    </div>
  );
}
