import { PlayIcon } from './Icons';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Track } from '../types';
import { nugs, nugsApi, nugsToTrack, type NugsArtist, type NugsShow } from '../sources/nugs';
import { useSourcesVersion } from '../sources/changes';
import { player, usePlayer } from '../player/engine';
import { ErrorBox, Header, Loading, TrackRow } from './common';
import { useAsync } from './useAsync';

type View = { kind: 'home' } | { kind: 'artist'; artist: NugsArtist } | { kind: 'show'; show: NugsShow };

export function NugsBrowse(props: { onAdd: (t: Track[]) => void; switcher: ReactNode; onLogin: () => void }) {
  useSourcesVersion();
  const [stack, setStack] = useState<View[]>([{ kind: 'home' }]);
  const view = stack[stack.length - 1];
  const push = (v: View) => setStack((s) => [...s, v]);
  const back = () => setStack((s) => s.slice(0, -1));

  const status = nugs.status();
  if (status !== 'ready')
    return (
      <>
        <Header title="nugs.net" />
        {props.switcher}
        <div className="empty">
          {status === 'coming-soon' ? (
            nugs.statusNote()
          ) : (
            <>
              <p>Sign in with your nugs.net subscription to stream shows and mix them into playlists.</p>
              <button className="primary pill-btn" onClick={props.onLogin}>
                Sign in to nugs
              </button>
            </>
          )}
        </div>
      </>
    );

  if (view.kind === 'artist')
    return <Artist artist={view.artist} onBack={back} onShow={(show) => push({ kind: 'show', show })} />;
  if (view.kind === 'show') return <Show show={view.show} onBack={back} onAdd={props.onAdd} />;
  return (
    <>
      <Header title="nugs.net" />
      {props.switcher}
      <Search onArtist={(artist) => push({ kind: 'artist', artist })} onShow={(show) => push({ kind: 'show', show })} />
    </>
  );
}

function Search({ onArtist, onShow }: { onArtist: (a: NugsArtist) => void; onShow: (s: NugsShow) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ artists: NugsArtist[]; shows: NugsShow[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(timer.current);
    const needle = q.trim();
    if (needle.length < 2) {
      setRes(null);
      return;
    }
    timer.current = setTimeout(() => {
      setBusy(true);
      nugsApi
        .search(needle)
        .then((r) => {
          setErr(null);
          setRes(r);
        }, setErr)
        .finally(() => setBusy(false));
    }, 350);
  }, [q]);

  return (
    <>
      <input
        className="search"
        placeholder="Search artists, songs, venues"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        enterKeyHint="search"
      />
      {err != null && <ErrorBox error={err} />}
      {busy && !res && <Loading />}
      {!res && !busy && <div className="empty">Try “Billy Strings”, “Dead & Company” or “Red Rocks”.</div>}
      {res && res.artists.length === 0 && res.shows.length === 0 && <div className="empty">Nothing found.</div>}
      {res && res.artists.length > 0 && (
        <>
          <div className="set-name">Artists</div>
          <div className="list">
            {res.artists.map((a) => (
              <button key={a.id} className="row nav" onClick={() => onArtist(a)}>
                <span className="title">{a.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {res && res.shows.length > 0 && (
        <>
          <div className="set-name">Shows</div>
          <ShowList shows={res.shows} onShow={onShow} showArtist />
        </>
      )}
    </>
  );
}

function ShowList({ shows, onShow, showArtist }: { shows: NugsShow[]; onShow: (s: NugsShow) => void; showArtist?: boolean }) {
  return (
    <div className="list">
      {shows.map((s) => (
        <button key={s.id} className="row nav" onClick={() => onShow(s)}>
          <span className="track-text">
            <span className="title">{showArtist ? `${s.artist}${s.date ? ` · ${s.date}` : ''}` : s.date || s.title}</span>
            <span className="sub">{s.venue || s.title}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Artist({ artist, onBack, onShow }: { artist: NugsArtist; onBack: () => void; onShow: (s: NugsShow) => void }) {
  const { data, error, loading } = useAsync(() => nugsApi.artistShows(artist.id), [artist.id]);
  const [q, setQ] = useState('');
  const shows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = data?.shows ?? [];
    return needle ? all.filter((s) => `${s.date} ${s.venue} ${s.title}`.toLowerCase().includes(needle)) : all;
  }, [data, q]);
  return (
    <>
      <Header title={artist.name} onBack={onBack} />
      <input className="search" placeholder="Filter by date or venue" value={q} onChange={(e) => setQ(e.target.value)} />
      {loading && <Loading what="shows" />}
      {error != null && <ErrorBox error={error} />}
      <ShowList shows={shows} onShow={onShow} />
    </>
  );
}

function Show({ show, onBack, onAdd }: { show: NugsShow; onBack: () => void; onAdd: (t: Track[]) => void }) {
  const { data, error, loading } = useAsync(() => nugsApi.show(show.id), [show.id]);
  const { queue, index } = usePlayer();
  const nowId = queue[index]?.source === 'nugs' ? queue[index].sourceId : null;

  const sets = useMemo(() => {
    if (!data) return [];
    const bySet = new Map<number, Track[]>();
    for (const s of data.songs) {
      const list = bySet.get(s.set) ?? [];
      list.push(nugsToTrack(s, data));
      bySet.set(s.set, list);
    }
    return [...bySet.entries()].sort((a, b) => a[0] - b[0]);
  }, [data]);
  const all = sets.flatMap(([, t]) => t);
  const info = data ?? show;

  return (
    <>
      <Header title={info.date || info.title} onBack={onBack} />
      <div className="show-head">
        <div className="title">{info.artist}</div>
        <div className="sub">{info.venue || info.title}</div>
        <div className="btns">
          <button className="primary" disabled={!all.length} onClick={() => player.playQueue(all, 0)}>
            <PlayIcon size={14} /> Play show
          </button>
          <button disabled={!all.length} onClick={() => onAdd(all)}>
            + Add all to playlist
          </button>
        </div>
      </div>
      {loading && <Loading what="setlist" />}
      {error != null && <ErrorBox error={error} />}
      {sets.map(([setNum, tracks]) => (
        <div key={setNum}>
          {sets.length > 1 && <div className="set-name">Set {setNum}</div>}
          <div className="list">
            {tracks.map((t) => (
              <TrackRow
                key={t.key}
                track={t}
                active={nowId === t.sourceId}
                onPlay={() => player.playQueue(all, all.indexOf(t))}
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
        </div>
      ))}
    </>
  );
}
