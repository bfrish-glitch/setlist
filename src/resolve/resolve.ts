import type { ShowRef, SourceId, SourceRef, Track } from '../types';
import { newKey } from '../types';
import { parseYouTube, youtubeTrack } from '../sources/youtube';
import { archiveTracks, fetchArchiveItem } from '../sources/archive';
import { bestSource, relistenApi, toTrack, venueLine, type RelistenArtist } from '../sources/relisten';
import { nugs, nugsApi, nugsToTrack, type NugsShow } from '../sources/nugs';
import { findDate, normArtist, normTitle, pairSetlists, toIsoDate } from './text';

/**
 * The link reader. Turns one pasted link or line of text into a "pick": a
 * show (or single video) with its songs, where every song carries every
 * service we could find it on.
 */

export interface Pick {
  id: string;
  input: string;
  /** Text around the link in the email: the curator's reason. */
  context?: string;
  status: 'ok' | 'error';
  error?: string;
  artist: string;
  date?: string;
  venue?: string;
  /** Which services carry this show. */
  foundOn: SourceId[];
  tracks: Track[];
  /** Index of the song the link (or the context text) points at. */
  focus?: number;
  /** True when it's one video/file rather than a show with a setlist. */
  single?: boolean;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const ref = (t: Track): SourceRef => ({
  source: t.source,
  sourceId: t.sourceId,
  streamUrl: t.streamUrl,
  durationSec: t.durationSec,
  startSec: t.startSec,
  endSec: t.endSec,
});

/* ---- per-service show loaders -------------------------------------- */

interface ShowData {
  source: SourceId;
  showId: string;
  artist: string;
  date?: string;
  venue?: string;
  tracks: Track[];
}

let artistCache: Promise<RelistenArtist[]> | null = null;
const relistenArtists = () => (artistCache ??= relistenApi.artists());

async function relistenArtistFor(name: string): Promise<RelistenArtist | null> {
  const n = normArtist(name);
  if (!n) return null;
  const all = await relistenArtists();
  return (
    all.find((a) => normArtist(a.name) === n) ??
    all.find((a) => normArtist(a.name).startsWith(n) || n.startsWith(normArtist(a.name))) ??
    null
  );
}

async function loadRelisten(artistSlug: string, date: string): Promise<ShowData | null> {
  const all = await relistenArtists();
  const artist = all.find((a) => a.slug === artistSlug) ?? ({ uuid: '', name: artistSlug, slug: artistSlug, sort_name: artistSlug, featured: 0 } as RelistenArtist);
  let show;
  try {
    show = await relistenApi.show(artistSlug, date);
  } catch {
    return null; // Relisten has no recording of that date
  }
  const src = bestSource(show.sources);
  if (!src) return null;
  const tracks = src.sets.flatMap((s) => s.tracks.map((t) => toTrack(t, artist, show))).filter((t): t is Track => !!t);
  return { source: 'relisten', showId: `${artistSlug}/${date}`, artist: artist.name, date, venue: venueLine(show.venue), tracks };
}

async function loadNugs(id: string): Promise<ShowData> {
  const show = await nugsApi.show(id);
  return {
    source: 'nugs',
    showId: id,
    artist: show.artist,
    date: toIsoDate(show.date) ?? undefined,
    venue: show.venue || show.title,
    tracks: show.songs.map((s) => nugsToTrack(s, show)),
  };
}

/** Find a show on nugs by artist + date (needs this person's nugs sign-in). */
async function findNugs(artist: string, date: string): Promise<ShowData | null> {
  if (nugs.status() !== 'ready') return null;
  try {
    const res = await nugsApi.search(artist);
    const n = normArtist(artist);
    const a = res.artists.find((x) => normArtist(x.name) === n) ?? res.artists[0];
    const candidates: NugsShow[] = [...res.shows];
    if (a) candidates.push(...(await nugsApi.artistShows(a.id)).shows);
    const hit = candidates.find((s) => toIsoDate(s.date) === date && (!a || normArtist(s.artist) === normArtist(a.name) || !s.artist));
    return hit ? await loadNugs(hit.id) : null;
  } catch {
    return null;
  }
}

/* ---- merging ------------------------------------------------------- */

/** Attach `other` as an alternate source on each matching song of `base`. */
function merge(base: ShowData, other: ShowData | null): void {
  if (!other || !other.tracks.length) return;
  const pairs = pairSetlists(
    base.tracks.map((t) => t.title),
    other.tracks.map((t) => t.title),
  );
  base.tracks.forEach((t, i) => {
    const j = pairs[i];
    t.shows = [...(t.shows ?? []), { source: other.source, id: other.showId }];
    if (j == null) return;
    const o = other.tracks[j];
    t.alts = [...(t.alts ?? []), ref(o)];
    t.durationSec ??= o.durationSec;
  });
}

function finish(input: string, context: string | undefined, base: ShowData, foundOn: SourceId[], songHint?: string): Pick {
  const tracks = base.tracks.map((t) => ({
    ...t,
    key: newKey(),
    shows: [{ source: base.source, id: base.showId } as ShowRef, ...(t.shows ?? [])],
  }));
  // Which song is the highlight? A song named in the link wins, then a song named in the curator's text.
  let focus = -1;
  if (songHint) focus = tracks.findIndex((t) => slug(t.title) === songHint || slug(t.title).startsWith(songHint));
  if (focus < 0 && context) focus = guessHighlight(tracks, context);
  return {
    id: newKey(),
    input,
    context,
    status: 'ok',
    artist: base.artist,
    date: base.date,
    venue: base.venue,
    foundOn: [...new Set(foundOn)],
    tracks,
    focus: focus >= 0 ? focus : undefined,
  };
}

/** Pick the song the curator's blurb talks about ("the 25-minute Tweezer"). */
export function guessHighlight(tracks: Track[], context: string): number {
  const ctx = ` ${normTitle(context)} `;
  let best = -1;
  let bestLen = 0;
  tracks.forEach((t, i) => {
    const n = normTitle(t.title);
    // Whole-title mention, longest wins ("Down with Disease" over "Disease").
    if (n.length >= 3 && ctx.includes(` ${n} `) && n.length > bestLen) {
      best = i;
      bestLen = n.length;
    }
  });
  return best;
}

/** After loading a show from its own link, look for it on the other services. */
async function crossMatch(base: ShowData): Promise<SourceId[]> {
  const found: SourceId[] = [base.source];
  if (!base.date || !base.artist) return found;
  const tasks: Promise<void>[] = [];
  if (base.source !== 'relisten') {
    tasks.push(
      relistenArtistFor(base.artist).then(async (a) => {
        const r = a ? await loadRelisten(a.slug, base.date!) : null;
        if (r) {
          merge(base, r);
          found.push('relisten');
        }
      }),
    );
  }
  if (base.source !== 'nugs') {
    tasks.push(
      findNugs(base.artist, base.date).then((n) => {
        if (n) {
          merge(base, n);
          found.push('nugs');
        }
      }),
    );
  }
  await Promise.all(tasks.map((t) => t.catch(() => {})));
  return found;
}

/* ---- entry point --------------------------------------------------- */

export async function resolvePick(input: { link?: string; text: string }): Promise<Pick> {
  const raw = input.link ?? input.text;
  try {
    return input.link ? await fromLink(input.link, input.text) : await fromText(input.text);
  } catch (e) {
    return {
      id: newKey(),
      input: raw,
      context: input.link ? input.text : undefined,
      status: 'error',
      error: e instanceof Error ? e.message : 'Couldn’t read that',
      artist: '',
      foundOn: [],
      tracks: [],
    };
  }
}

async function fromLink(link: string, context?: string): Promise<Pick> {
  const yt = parseYouTube(link);
  if (yt) {
    const t = await youtubeTrack(yt.id, yt.start);
    t.note = context || undefined;
    t.shows = [{ source: 'youtube', id: yt.id }];
    const pick: Pick = {
      id: newKey(),
      input: link,
      context,
      status: 'ok',
      artist: t.artist,
      foundOn: ['youtube'],
      tracks: [t],
      focus: 0,
      single: true,
    };
    // A dated upload ("Billy Strings 9/12/25 Red Rocks"): find that show on
    // Relisten/nugs. If we can tell which song it is, play the audio version
    // (keeps going with the phone locked) and keep the video as a backup.
    const date = findDate(`${t.title} ${context ?? ''}`)?.date;
    if (date) {
      const ra = await relistenArtistFor(t.artist.replace(/\s*-\s*topic$/i, '')).catch(() => null);
      const [rel, ng] = await Promise.all([
        ra ? loadRelisten(ra.slug, date).catch(() => null) : Promise.resolve(null),
        findNugs(ra?.name ?? t.artist, date),
      ]);
      const shows = [ng, rel].filter((x): x is ShowData => !!x);
      if (shows.length) {
        pick.date = date;
        pick.venue = shows[0].venue;
        for (const sh of shows) {
          t.shows!.push({ source: sh.source, id: sh.showId });
          pick.foundOn.push(sh.source);
        }
        const hint = `${t.title} ${context ?? ''}`;
        const audio = shows
          .map((sh) => sh.tracks[guessHighlight(sh.tracks, hint)])
          .filter((x): x is Track => !!x);
        if (audio.length) {
          const [main, ...rest] = audio;
          pick.tracks = [
            {
              ...main,
              key: newKey(),
              note: t.note,
              shows: t.shows,
              alts: [...rest.map(ref), ref(t)],
            },
          ];
        }
      }
    }
    return pick;
  }

  const u = new URL(link);
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'archive.org' && (parts[0] === 'details' || parts[0] === 'download') && parts[1]) {
    const item = await fetchArchiveItem(parts[1]);
    const tracks = archiveTracks(item);
    if (!tracks.length) throw new Error('No playable audio in that archive.org item');
    const base: ShowData = {
      source: 'archive',
      showId: item.id,
      artist: item.artist || item.title,
      date: toIsoDate(item.date) ?? toIsoDate(item.title) ?? undefined,
      venue: item.venue,
      tracks,
    };
    const found = await crossMatch(base);
    const file = decodeURIComponent(parts.slice(2).join('/'));
    const pick = finish(link, context, base, found);
    if (file) {
      const i = tracks.findIndex((t) => t.sourceId.endsWith(`/${file}`));
      if (i >= 0) pick.focus = i;
    }
    return pick;
  }

  if (host === 'phish.in' && /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? '')) {
    const base = await loadRelisten('phish', parts[0]);
    if (!base) throw new Error('Relisten doesn’t have that Phish show yet');
    return finish(link, context, base, await crossMatch(base), parts[1]);
  }

  if (host === 'relisten.net' && parts.length >= 4 && /^\d{4}$/.test(parts[1])) {
    const base = await loadRelisten(parts[0], `${parts[1]}-${parts[2]}-${parts[3]}`);
    if (!base) throw new Error('Couldn’t load that Relisten show');
    return finish(link, context, base, await crossMatch(base), parts[4]);
  }

  if (/(^|\.)(nugs\.net|livephish\.com)$/.test(host)) {
    const id =
      /release\/(\d+)/.exec(u.pathname)?.[1] ??
      u.searchParams.get('containerID') ??
      u.searchParams.get('showID') ??
      /(?:^|[/-])(\d{4,})(?:\.html)?\/?$/.exec(u.pathname)?.[1];
    if (/livephish/.test(host)) {
      // LivePhish isn't supported; find the same Phish show on Relisten by date.
      const date = findDate(`${u.pathname} ${context ?? ''}`)?.date;
      const base = date ? await loadRelisten('phish', date) : null;
      if (!base) throw new Error('LivePhish links aren’t supported yet, and no date was found to look it up on Relisten');
      return finish(link, context, base, await crossMatch(base));
    }
    if (id && nugs.status() === 'ready') {
      const base = await loadNugs(id);
      return finish(link, context, base, await crossMatch(base));
    }
    // Not signed in to nugs, or a link style we can't read: fall back to the text around it.
    const viaText = await fromText(`${context ?? ''} ${decodeURIComponent(u.pathname).replace(/[-/]/g, ' ')}`).catch(() => null);
    if (viaText) return { ...viaText, input: link, context };
    throw new Error(nugs.status() === 'ready' ? 'Couldn’t find the show in that nugs link' : 'Sign in to nugs (Services) to open nugs links');
  }

  if (host === 'setlist.fm' || host === 'phish.net' || host === 'kglw.net' || host === 'jambase.com') {
    // Setlist/review pages: use the date and artist in the URL or text.
    return { ...(await fromText(`${context ?? ''} ${u.pathname.replace(/[-/_]/g, ' ')}`)), input: link, context };
  }

  throw new Error('Setlist can’t open links from that site yet');
}

/** "Phish 7/30/25 MSG" or "Billy Strings - Red Rocks - 2025-09-12" */
async function fromText(text: string): Promise<Pick> {
  const d = findDate(text);
  if (!d) throw new Error('No show date found in that text');
  const all = await relistenArtists();
  const n = ` ${normArtist(text)} `;
  // Longest artist name that appears in the text.
  const artist = all
    .filter((a) => normArtist(a.name).length >= 3 && n.includes(` ${normArtist(a.name)} `))
    .sort((a, b) => b.name.length - a.name.length)[0];

  if (artist) {
    const base = await loadRelisten(artist.slug, d.date);
    if (base) return finish(text, text, base, await crossMatch(base));
    const viaNugs = await findNugs(artist.name, d.date);
    if (viaNugs) return finish(text, text, viaNugs, await crossMatch(viaNugs));
    throw new Error(`Couldn’t find ${artist.name} on ${d.date} on Relisten or nugs`);
  }
  // Artist not on Relisten: try nugs search with the text before the date.
  const guess = text.slice(0, text.toLowerCase().indexOf(d.match)).replace(/[-–|:,·]+$/g, '').trim();
  const viaNugs = guess ? await findNugs(guess, d.date) : null;
  if (viaNugs) return finish(text, text, viaNugs, await crossMatch(viaNugs));
  throw new Error('Couldn’t tell which artist that is');
}

/* ---- full show playback -------------------------------------------- */

/** Load every song of a show from a ShowRef, for "play full show". */
export async function loadShowTracks(r: ShowRef): Promise<Track[]> {
  switch (r.source) {
    case 'relisten': {
      const [artistSlug, date] = r.id.split('/');
      return (await loadRelisten(artistSlug, date))?.tracks ?? [];
    }
    case 'nugs':
      return (await loadNugs(r.id)).tracks;
    case 'archive':
      return archiveTracks(await fetchArchiveItem(r.id));
    case 'youtube': {
      const t = await youtubeTrack(r.id);
      return [t];
    }
    default:
      return [];
  }
}

