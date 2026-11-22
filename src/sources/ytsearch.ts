import { SERVER } from '../config';
import { newKey, type SourceRef, type Track } from '../types';
import { findDate, normArtist, normTitle } from '../resolve/text';

/**
 * Find a YouTube video for a song or show when no free source exists.
 * Strict on purpose: a wrong video (studio cut, different night) is worse
 * than none, so live jams need the artist AND the show date in the title.
 */

export interface YtResult {
  id: string;
  title: string;
  channel: string;
  publishedAt: string;
  thumbnail?: string;
  durationSec?: number;
}

let unavailable = false; // server has no key: stop asking this session

export async function searchYouTube(q: string): Promise<YtResult[]> {
  if (unavailable) return [];
  try {
    const r = await fetch(`${SERVER}/resolve/youtube-search?q=${encodeURIComponent(q)}`);
    if (r.status === 503) {
      unavailable = true;
      return [];
    }
    if (!r.ok) return [];
    return ((await r.json()) as { results: YtResult[] }).results ?? [];
  } catch {
    return [];
  }
}

const mdy = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${+m}/${+d}/${y.slice(2)}`;
};

function artistMatches(r: YtResult, artist: string) {
  const a = normArtist(artist);
  if (a.length < 3) return false;
  // Long names often appear shortened ("King Gizzard"): accept the first two words.
  const short = a.split(' ').slice(0, 2).join(' ');
  const hay = ` ${normArtist(r.title)} ${normArtist(r.channel)} `;
  return hay.includes(` ${a} `) || (short.length >= 6 && hay.includes(` ${short} `));
}

function songMatches(r: YtResult, song: string) {
  const s = normTitle(song);
  return s.length >= 3 && ` ${normTitle(r.title)} `.includes(` ${s} `);
}

function dateMatches(r: YtResult, date: string) {
  return findDate(r.title)?.date === date;
}

/**
 * Pick the best result. mode "song": one song (a jam from a show, or a new
 * band's tune). mode "show": a full-show upload.
 */
export function bestVideo(
  results: YtResult[],
  want: { artist: string; date?: string | null; song?: string | null },
  mode: 'song' | 'show',
): YtResult | null {
  let best: YtResult | null = null;
  let bestScore = 0;
  for (const r of results) {
    if (/\b(cover|covers|tribute|lesson|tutorial|reaction|reacts|karaoke|how to play|guitar tab)\b/i.test(r.title)) continue;
    if (!artistMatches(r, want.artist)) continue;
    const dateOk = want.date ? dateMatches(r, want.date) : false;
    const songOk = want.song ? songMatches(r, want.song) : false;
    const mins = (r.durationSec ?? 0) / 60;
    // Live jams must be from that exact night.
    if (want.date && !dateOk) continue;
    if (mode === 'song') {
      if (want.song && !songOk) continue;
      if (mins > 75) continue; // a full show isn't "the song"
    } else if (mins && mins < 40) continue;
    const score = 10 + (dateOk ? 5 : 0) + (songOk ? 5 : 0) + (/\b(sbd|soundboard|pro ?shot|official)\b/i.test(r.title) ? 1 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

export function videoToTrack(v: YtResult, fallbackArtist: string, subtitle?: string): Track {
  return {
    key: newKey(),
    source: 'youtube',
    sourceId: v.id,
    title: v.title,
    artist: fallbackArtist || v.channel,
    subtitle,
    durationSec: v.durationSec,
    artworkUrl: v.thumbnail,
    shows: [{ source: 'youtube', id: v.id }],
  };
}

/** Find a YouTube video of one song (a jam from a dated show, or a new band's song). */
export async function findSongVideo(artist: string, song: string | null | undefined, date?: string | null): Promise<YtResult | null> {
  const q = [artist, song ?? (date ? '' : 'live'), date ? mdy(date) : ''].filter(Boolean).join(' ');
  const hit = bestVideo(await searchYouTube(q), { artist, song, date }, 'song');
  if (hit || !date) return hit;
  // Some uploads write the date as 2026-11-20.
  return bestVideo(await searchYouTube(`${artist} ${song ?? ''} ${date}`), { artist, song, date }, 'song');
}

/** Services anyone can play without an account. */
const FREE = new Set(['relisten', 'archive', 'youtube']);
export const hasFreeSource = (t: Track) => FREE.has(t.source) || (t.alts ?? []).some((a) => FREE.has(a.source));

/**
 * If a song only plays for people with a paid login (nugs/Spotify), look for
 * a matching YouTube video and attach it as a backup source.
 */
export async function ensureFreeSource(t: Track): Promise<Track> {
  if (hasFreeSource(t)) return t;
  const date = findDate(t.subtitle ?? '')?.date ?? null;
  const v = await findSongVideo(t.artist, t.title, date);
  if (!v) return t;
  const alt: SourceRef = { source: 'youtube', sourceId: v.id, durationSec: v.durationSec };
  return { ...t, alts: [...(t.alts ?? []), alt] };
}
