import { newKey, type Track } from '../types';
import type { PlaybackEvents, SourceAdapter } from './types';
import { sharedAudio } from './audio';

/* ------------------------------------------------------------------ */
/* Relisten API (https://api.relisten.net, open CORS, no auth)          */
/* ------------------------------------------------------------------ */

const API = 'https://api.relisten.net/api/v2';

export interface RelistenArtist {
  uuid: string;
  name: string;
  slug: string;
  sort_name: string;
  featured: number;
  show_count?: number;
  source_count?: number;
}

export interface RelistenYear {
  uuid: string;
  year: string;
  show_count: number;
}

export interface RelistenVenue {
  name: string;
  location?: string;
}

export interface RelistenShow {
  uuid: string;
  display_date: string;
  venue?: RelistenVenue | null;
  avg_rating: number;
  has_soundboard_source: boolean;
  source_count: number;
}

export interface RelistenTrack {
  uuid: string;
  title: string;
  duration: number | null;
  track_position: number;
  mp3_url: string | null;
}

export interface RelistenSet {
  uuid: string;
  name: string;
  index: number;
  is_encore: boolean;
  tracks: RelistenTrack[];
}

export interface RelistenSource {
  uuid: string;
  is_soundboard: boolean;
  avg_rating: number;
  num_reviews: number;
  duration: number;
  taper?: string | null;
  source?: string | null;
  sets: RelistenSet[];
}

export interface RelistenShowWithSources extends RelistenShow {
  sources: RelistenSource[];
}

const cache = new Map<string, Promise<unknown>>();

async function get<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const p = fetch(API + path).then(async (r) => {
      if (!r.ok) throw new Error(`Relisten ${r.status} on ${path}`);
      return r.json();
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}

export const relistenApi = {
  artists: () => get<RelistenArtist[]>('/artists'),
  years: (slug: string) => get<RelistenYear[]>(`/artists/${slug}/years`),
  showsInYear: async (slug: string, year: string) =>
    (await get<{ shows: RelistenShow[] }>(`/artists/${slug}/years/${year}`)).shows ?? [],
  show: (slug: string, displayDate: string) =>
    get<RelistenShowWithSources>(`/artists/${slug}/shows/${displayDate}`),
  topShows: (slug: string) => get<RelistenShow[]>(`/artists/${slug}/shows/top`),
};

export function venueLine(v?: RelistenVenue | null) {
  if (!v) return '';
  return [v.name, v.location].filter(Boolean).join(', ');
}

/** Pick the source most people would want: highest weighted rating, soundboards first on ties. */
export function bestSource(sources: RelistenSource[]): RelistenSource | undefined {
  return [...sources].sort(
    (a, b) =>
      b.avg_rating - a.avg_rating ||
      Number(b.is_soundboard) - Number(a.is_soundboard) ||
      b.num_reviews - a.num_reviews,
  )[0];
}

export function toTrack(
  t: RelistenTrack,
  artist: RelistenArtist,
  show: RelistenShow,
): Track | null {
  if (!t.mp3_url) return null;
  return {
    key: newKey(),
    source: 'relisten',
    sourceId: t.uuid,
    title: t.title,
    artist: artist.name,
    subtitle: [show.display_date, venueLine(show.venue)].filter(Boolean).join(' · '),
    durationSec: t.duration ?? undefined,
    streamUrl: t.mp3_url,
  };
}

/* ------------------------------------------------------------------ */
/* Playback: plain <audio>, streams straight from archive.org / phish.in */
/* ------------------------------------------------------------------ */

class RelistenAdapter implements SourceAdapter {
  id = 'relisten' as const;
  name = 'Relisten';
  color = '#3fb68b';

  status() {
    return 'ready' as const;
  }
  statusNote() {
    return 'No account needed. Live shows from archive.org and phish.in.';
  }

  async play(track: Track, ev: PlaybackEvents) {
    if (!track.streamUrl) throw new Error('This Relisten track has no stream URL');
    await sharedAudio.play(track.streamUrl, track.durationSec, ev, 'Could not load this recording');
  }
  pause() {
    sharedAudio.pause();
  }
  resume() {
    sharedAudio.resume();
  }
  seek(sec: number) {
    sharedAudio.seek(sec);
  }
  stop() {
    sharedAudio.stop();
  }
}

export const relisten = new RelistenAdapter();
