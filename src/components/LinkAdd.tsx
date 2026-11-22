import { useState, type ReactNode } from 'react';
import type { Track } from '../types';
import { parseYouTube, youtubeTrack } from '../sources/youtube';
import { archiveTracks, fetchArchiveItem } from '../sources/archive';
import { relistenApi, bestSource, toTrack, venueLine } from '../sources/relisten';
import { nugs, nugsApi, nugsToTrack } from '../sources/nugs';
import { player, usePlayer } from '../player/engine';
import { ErrorBox, Header, Loading, TrackRow } from './common';

interface Resolved {
  heading: string;
  sub: string;
  tracks: Track[];
  /** Index of the specific song the link pointed at, if any. */
  focus?: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Turn a pasted link into playable tracks. Phase 3 grows this into the full link reader. */
async function resolveLink(raw: string): Promise<Resolved> {
  const text = raw.trim();
  const yt = parseYouTube(text);
  if (yt) {
    const t = await youtubeTrack(yt.id, yt.start);
    return { heading: t.title, sub: `YouTube · ${t.artist}`, tracks: [t], focus: 0 };
  }

  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error('That doesn’t look like a link. Paste the full address, starting with https://');
  }
  const host = u.hostname.replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  // archive.org/details/<identifier>[/<file>]
  if (host === 'archive.org' && (parts[0] === 'details' || parts[0] === 'download') && parts[1]) {
    const item = await fetchArchiveItem(parts[1]);
    const tracks = archiveTracks(item);
    if (!tracks.length) throw new Error('That archive.org item has no playable audio files');
    const file = parts.slice(2).join('/');
    const focus = file ? tracks.findIndex((t) => t.sourceId.endsWith(`/${decodeURIComponent(file)}`)) : -1;
    return {
      heading: item.artist || item.title,
      sub: ['archive.org', item.date, item.venue].filter(Boolean).join(' · '),
      tracks,
      focus: focus >= 0 ? focus : undefined,
    };
  }

  // phish.in/<yyyy-mm-dd>[/<song-slug>] → Relisten's Phish catalog (phish.in feeds it)
  // relisten.net/<artist-slug>/<yyyy>/<mm>/<dd>[/<song-slug>]
  let artistSlug: string | null = null;
  let date: string | null = null;
  let songSlug: string | undefined;
  if (host === 'phish.in' && /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? '')) {
    artistSlug = 'phish';
    date = parts[0];
    songSlug = parts[1];
  } else if (host === 'relisten.net' && parts.length >= 4 && /^\d{4}$/.test(parts[1])) {
    artistSlug = parts[0];
    date = `${parts[1]}-${parts[2]}-${parts[3]}`;
    songSlug = parts[4];
  }
  if (artistSlug && date) {
    const [artists, show] = await Promise.all([relistenApi.artists(), relistenApi.show(artistSlug, date)]);
    const artist = artists.find((a) => a.slug === artistSlug) ?? { uuid: '', name: artistSlug, slug: artistSlug, sort_name: artistSlug, featured: 0 };
    const src = bestSource(show.sources);
    if (!src) throw new Error('Relisten has no recording of that show yet');
    const tracks = src.sets.flatMap((set) => set.tracks.map((t) => toTrack(t, artist, show))).filter((t): t is Track => !!t);
    const focus = songSlug ? tracks.findIndex((t) => slug(t.title) === songSlug || slug(t.title).startsWith(songSlug!)) : -1;
    return {
      heading: `${artist.name} · ${show.display_date}`,
      sub: `Relisten · ${venueLine(show.venue)}`,
      tracks,
      focus: focus >= 0 ? focus : undefined,
    };
  }

  // nugs.net release links (needs a nugs sign-in)
  if (/(^|\.)nugs\.net$/.test(host)) {
    const id = /release\/(\d+)/.exec(u.pathname)?.[1] ?? /(\d{4,})(?:\.html)?$/.exec(u.pathname)?.[1];
    if (!id) throw new Error('Couldn’t find the show in that nugs link. Phase 3 will handle more nugs link styles.');
    if (nugs.status() !== 'ready') throw new Error('Sign in to nugs (Services) to open nugs links');
    const show = await nugsApi.show(id);
    return {
      heading: `${show.artist}${show.date ? ` · ${show.date}` : ''}`,
      sub: `nugs.net · ${show.venue || show.title}`,
      tracks: show.songs.map((s) => nugsToTrack(s, show)),
    };
  }

  throw new Error('Setlist can open YouTube, archive.org, phish.in, Relisten and nugs links so far.');
}

export function LinkAdd({ onAdd, switcher }: { onAdd: (t: Track[]) => void; switcher: ReactNode }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [res, setRes] = useState<Resolved | null>(null);
  const { queue, index } = usePlayer();
  const now = queue[index]?.sourceId;

  const go = async (value = text) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    setRes(null);
    try {
      setRes(await resolveLink(value));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setText(t);
      void go(t);
    } catch {
      /* clipboard blocked; they can paste manually */
    }
  };

  return (
    <>
      <Header title="Add from link" />
      {switcher}
      <form
        className="link-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input
          className="search"
          placeholder="Paste a YouTube, archive.org, phish.in or nugs link"
          value={text}
          onChange={(e) => setText(e.target.value)}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="btns pad-x">
          <button type="button" onClick={paste}>
            Paste
          </button>
          <button className="primary" disabled={busy || !text.trim()}>
            Open
          </button>
        </div>
      </form>
      {busy && <Loading />}
      {error != null && <ErrorBox error={error} />}
      {res && (
        <>
          <div className="show-head">
            <div className="title">{res.heading}</div>
            <div className="sub">{res.sub}</div>
            <div className="btns">
              {res.focus != null && res.tracks.length > 1 && (
                <button className="primary" onClick={() => player.playQueue(res.tracks, res.focus)}>
                  ▶ Play linked song
                </button>
              )}
              <button
                className={res.focus != null && res.tracks.length > 1 ? '' : 'primary'}
                onClick={() => player.playQueue(res.tracks, 0)}
              >
                ▶ Play {res.tracks.length > 1 ? 'all' : ''}
              </button>
              {res.focus != null && res.tracks.length > 1 && (
                <button onClick={() => onAdd([res.tracks[res.focus!]])}>+ Add linked song</button>
              )}
              <button onClick={() => onAdd(res.tracks)}>+ Add {res.tracks.length > 1 ? 'all' : ''} to playlist</button>
            </div>
          </div>
          <div className="list">
            {res.tracks.map((t, i) => (
              <TrackRow
                key={t.key}
                track={t}
                index={res.tracks.length > 1 ? i : undefined}
                active={now === t.sourceId || i === res.focus}
                onPlay={() => player.playQueue(res.tracks, i)}
                actions={
                  <button className="icon" title="Add to playlist" onClick={() => onAdd([t])}>
                    +
                  </button>
                }
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
