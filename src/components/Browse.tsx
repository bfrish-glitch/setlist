import { PlayIcon } from './Icons';
import { useMemo, useState, type ReactNode } from 'react';
import { SpotifyBrowse } from './SpotifyBrowse';
import { NugsBrowse } from './NugsBrowse';
import { Import } from './Import';
import type { Track } from '../types';
import {
  bestSource,
  relistenApi,
  toTrack,
  venueLine,
  type RelistenArtist,
  type RelistenShow,
} from '../sources/relisten';
import { player, usePlayer } from '../player/engine';
import { ErrorBox, Header, Loading, TrackRow, fmt } from './common';
import { useAsync } from './useAsync';

type View =
  | { kind: 'artists' }
  | { kind: 'artist'; artist: RelistenArtist }
  | { kind: 'year'; artist: RelistenArtist; year: string }
  | { kind: 'show'; artist: RelistenArtist; show: RelistenShow };

type Catalog = 'relisten' | 'nugs' | 'spotify' | 'link';
const catalogNames: Record<Catalog, string> = { relisten: 'Relisten', nugs: 'nugs', spotify: 'Spotify', link: '🔗 Links' };

export function Browse({ onAdd, onNugsLogin }: { onAdd: (tracks: Track[], name?: string) => void; onNugsLogin: () => void }) {
  const [catalog, setCatalog] = useState<Catalog>('relisten');
  const switcher = (
    <div className="segmented">
      {(['relisten', 'nugs', 'spotify', 'link'] as const).map((c) => (
        <button key={c} className={catalog === c ? 'on' : ''} onClick={() => setCatalog(c)}>
          {catalogNames[c]}
        </button>
      ))}
    </div>
  );
  // Both stay mounted so each keeps its place when you flip between them.
  return (
    <>
      <div hidden={catalog !== 'relisten'}>
        <RelistenBrowse onAdd={onAdd} switcher={switcher} />
      </div>
      <div hidden={catalog !== 'nugs'}>
        <NugsBrowse onAdd={onAdd} switcher={switcher} onLogin={onNugsLogin} />
      </div>
      <div hidden={catalog !== 'spotify'}>
        <SpotifyBrowse onAdd={onAdd} switcher={switcher} />
      </div>
      <div hidden={catalog !== 'link'}>
        <Import onAdd={onAdd} switcher={switcher} />
      </div>
    </>
  );
}

function RelistenBrowse({ onAdd, switcher }: { onAdd: (tracks: Track[]) => void; switcher: ReactNode }) {
  const [stack, setStack] = useState<View[]>([{ kind: 'artists' }]);
  const view = stack[stack.length - 1];
  const push = (v: View) => setStack((s) => [...s, v]);
  const back = () => setStack((s) => s.slice(0, -1));

  switch (view.kind) {
    case 'artists':
      return <Artists switcher={switcher} onPick={(artist) => push({ kind: 'artist', artist })} />;
    case 'artist':
      return (
        <Artist
          artist={view.artist}
          onBack={back}
          onYear={(year) => push({ kind: 'year', artist: view.artist, year })}
          onShow={(show) => push({ kind: 'show', artist: view.artist, show })}
        />
      );
    case 'year':
      return (
        <Year
          artist={view.artist}
          year={view.year}
          onBack={back}
          onShow={(show) => push({ kind: 'show', artist: view.artist, show })}
        />
      );
    case 'show':
      return <Show artist={view.artist} show={view.show} onBack={back} onAdd={onAdd} />;
  }
}

function Artists({ onPick, switcher }: { onPick: (a: RelistenArtist) => void; switcher: ReactNode }) {
  const { data, error, loading } = useAsync(relistenApi.artists, []);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const all = data ?? [];
    const needle = q.trim().toLowerCase();
    const filtered = needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all;
    return [...filtered].sort(
      (a, b) => (needle ? 0 : b.featured - a.featured) || a.sort_name.localeCompare(b.sort_name),
    );
  }, [data, q]);

  return (
    <>
      <Header title="Relisten" />
      {switcher}
      <input
        className="search"
        placeholder="Find an artist (Grateful Dead, Phish, Goose…)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {loading && <Loading what="artists" />}
      {error != null && <ErrorBox error={error} />}
      <div className="list">
        {list.map((a) => (
          <button key={a.uuid} className="row nav" onClick={() => onPick(a)}>
            <span className="title">{a.name}</span>
            {a.show_count != null && <span className="meta">{a.show_count.toLocaleString()} shows</span>}
          </button>
        ))}
      </div>
    </>
  );
}

function Artist(props: {
  artist: RelistenArtist;
  onBack: () => void;
  onYear: (y: string) => void;
  onShow: (s: RelistenShow) => void;
}) {
  const { artist } = props;
  const years = useAsync(() => relistenApi.years(artist.slug), [artist.slug]);
  const top = useAsync(() => relistenApi.topShows(artist.slug), [artist.slug]);
  const [tab, setTab] = useState<'years' | 'top'>('years');

  return (
    <>
      <Header title={artist.name} onBack={props.onBack} />
      <div className="segmented">
        <button className={tab === 'years' ? 'on' : ''} onClick={() => setTab('years')}>
          Years
        </button>
        <button className={tab === 'top' ? 'on' : ''} onClick={() => setTab('top')}>
          Top rated
        </button>
      </div>
      {tab === 'years' && (
        <>
          {years.loading && <Loading />}
          {years.error != null && <ErrorBox error={years.error} />}
          <div className="list">
            {[...(years.data ?? [])].reverse().map((y) => (
              <button key={y.uuid} className="row nav" onClick={() => props.onYear(y.year)}>
                <span className="title">{y.year}</span>
                <span className="meta">{y.show_count} shows</span>
              </button>
            ))}
          </div>
        </>
      )}
      {tab === 'top' && (
        <>
          {top.loading && <Loading />}
          {top.error != null && <ErrorBox error={top.error} />}
          <ShowList shows={top.data ?? []} onShow={props.onShow} />
        </>
      )}
    </>
  );
}

function Year(props: { artist: RelistenArtist; year: string; onBack: () => void; onShow: (s: RelistenShow) => void }) {
  const { data, error, loading } = useAsync(
    () => relistenApi.showsInYear(props.artist.slug, props.year),
    [props.artist.slug, props.year],
  );
  return (
    <>
      <Header title={`${props.artist.name} · ${props.year}`} onBack={props.onBack} />
      {loading && <Loading what="shows" />}
      {error != null && <ErrorBox error={error} />}
      <ShowList shows={data ?? []} onShow={props.onShow} />
    </>
  );
}

function ShowList({ shows, onShow }: { shows: RelistenShow[]; onShow: (s: RelistenShow) => void }) {
  return (
    <div className="list">
      {shows.map((s) => (
        <button key={s.uuid} className="row nav" onClick={() => onShow(s)}>
          <span className="track-text">
            <span className="title">{s.display_date}</span>
            <span className="sub">{venueLine(s.venue)}</span>
          </span>
          <span className="meta">
            {s.has_soundboard_source && <span className="sbd">SBD</span>}
            {s.avg_rating ? `★ ${s.avg_rating.toFixed(1)}` : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

function Show(props: { artist: RelistenArtist; show: RelistenShow; onBack: () => void; onAdd: (t: Track[]) => void }) {
  const { artist, show } = props;
  const { data, error, loading } = useAsync(
    () => relistenApi.show(artist.slug, show.display_date),
    [artist.slug, show.display_date],
  );
  const [sourceId, setSourceId] = useState<string | null>(null);
  const { queue, index } = usePlayer();
  const nowKey = queue[index]?.sourceId;

  const source = data ? (data.sources.find((s) => s.uuid === sourceId) ?? bestSource(data.sources)) : undefined;

  // Build tracks once per source so play-all and add-all share keys.
  const sets = useMemo(() => {
    if (!source || !data) return [];
    return source.sets.map((set) => ({
      set,
      tracks: set.tracks.map((t) => toTrack(t, artist, data)).filter((t): t is Track => t !== null),
    }));
  }, [source, data, artist]);
  const all = sets.flatMap((s) => s.tracks);

  return (
    <>
      <Header title={show.display_date} onBack={props.onBack} />
      <div className="show-head">
        <div className="title">{artist.name}</div>
        <div className="sub">{venueLine(show.venue)}</div>
        {data && data.sources.length > 1 && (
          <select value={source?.uuid} onChange={(e) => setSourceId(e.target.value)}>
            {data.sources.map((s, i) => (
              <option key={s.uuid} value={s.uuid}>
                {`Source ${i + 1}${s.is_soundboard ? ' · SBD' : ''}${s.avg_rating ? ` · ★ ${s.avg_rating.toFixed(1)}` : ''}${s.duration ? ` · ${fmt(s.duration)}` : ''}${s.taper ? ` · ${s.taper}` : ''}`}
              </option>
            ))}
          </select>
        )}
        <div className="btns">
          <button className="primary" disabled={!all.length} onClick={() => player.playQueue(all, 0)}>
            <PlayIcon size={14} /> Play show
          </button>
          <button disabled={!all.length} onClick={() => props.onAdd(all)}>
            + Add all to playlist
          </button>
        </div>
      </div>
      {loading && <Loading what="setlist" />}
      {error != null && <ErrorBox error={error} />}
      {sets.map(({ set, tracks }) => (
        <div key={set.uuid}>
          {sets.length > 1 && <div className="set-name">{set.name || (set.is_encore ? 'Encore' : `Set ${set.index + 1}`)}</div>}
          <div className="list">
            {tracks.map((t) => (
              <TrackRow
                key={t.key}
                track={t}
                active={nowKey === t.sourceId}
                onPlay={() => player.playQueue(all, all.indexOf(t))}
                actions={
                  <>
                    <button className="icon" title="Add to queue" onClick={() => player.enqueue([t])}>
                      ⤓
                    </button>
                    <button className="icon" title="Add to playlist" onClick={() => props.onAdd([t])}>
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
