import { api, group } from '../group/group';
import { playlists } from '../store/playlists';
import { resolvePick, type Pick } from '../resolve/resolve';
import type { RawPick } from '../resolve/text';
import type { Track } from '../types';
import { ensureFreeSource, findSongVideo, videoToTrack } from '../sources/ytsearch';
import { newKey } from '../types';

/**
 * Weekly picks, app side. The server researches the week; whichever group
 * member's app opens first turns the picks into the "Week of …" playlist,
 * using that phone's resolver and service logins.
 */

export interface WeeklyPick {
  kind: 'show' | 'new_artist';
  artist: string;
  date: string | null;
  venue: string | null;
  highlight: string | null;
  why: string;
  links: string[];
  caveats?: string | null;
}

export interface WeeklyConfig {
  enabled: boolean;
  day: number;
  hour: number;
  watchlist: string[];
  picks: number;
  maxPerBand: number;
  bandLimits: Record<string, number>;
  windowDays: number;
  newArtists: number;
  autoPublish: boolean;
  prompt?: string;
  model: string;
}

export type RunKind = 'weekly' | 'discovery';

export interface DiscoveryConfig {
  enabled: boolean;
  day: number;
  hour: number;
  bands: number;
  songsPerBand: number;
  autoPublish: boolean;
  prompt?: string;
  model: string;
}

export interface WeeklyRun {
  id: string;
  kind?: RunKind;
  autoPublish?: boolean;
  trigger: 'weekly' | 'manual';
  status: 'running' | 'ready' | 'error' | 'published';
  startedAt: number;
  finishedAt?: number;
  picks: WeeklyPick[];
  error?: string;
  searches?: number;
  inputTokens?: number;
  outputTokens?: number;
  playlistId?: string;
  missed: string[];
  dropped?: { artist: string; date: string | null; highlight: string | null; reason: string }[];
  raw?: string;
}

export interface WeeklyInfo {
  config: WeeklyConfig;
  discovery: DiscoveryConfig;
  nextRun: number | null;
  nextDiscovery: number | null;
  hasKey: boolean;
  runs: WeeklyRun[];
}

export const weeklyApi = {
  info: () => api<WeeklyInfo>('/weekly'),
  save: (cfg: (Partial<WeeklyConfig> | Partial<DiscoveryConfig>) & { resetPrompt?: boolean; kind?: RunKind }) =>
    api<WeeklyInfo>('/weekly/config', cfg),
  run: (kind: RunKind = 'weekly') => api<WeeklyInfo>('/weekly/run', { kind }),
  pending: () => api<{ runs?: WeeklyRun[]; run: WeeklyRun | null; autoPublish?: boolean; isOwner?: boolean }>('/weekly/pending'),
  claim: (id: string) => api<{ ok: boolean }>('/weekly/claim', { id }),
  publish: (id: string, playlistId: string, missed: string[]) => api<{ ok: boolean }>('/weekly/publish', { id, playlistId, missed }),
};

/** Turn a pick into the text the resolver understands (heading + why + an explicit highlight cue). */
export function toRawPicks(p: WeeklyPick): RawPick[] {
  const text = [
    p.artist,
    p.date ?? '',
    p.venue ?? '',
    p.highlight ? `The highlight is "${p.highlight}".` : '',
    p.why,
  ]
    .filter(Boolean)
    .join(' ');
  const note = p.caveats ? `${p.why} Caveat: ${p.caveats}` : p.why;
  const links = p.links.length ? p.links : [undefined];
  return links.map((link) => ({ link, text, note }));
}

/** Resolve one pick, trying each of its links in turn, then plain artist + date. */
export async function resolveWeeklyPick(p: WeeklyPick): Promise<Pick> {
  let last: Pick | null = null;
  for (const raw of toRawPicks(p)) {
    const r = await resolvePick(raw);
    if (r.status === 'ok') return r;
    last = r;
  }
  if (p.date) {
    // No link worked: look the show up by artist + date, keeping the highlight cue.
    const [raw] = toRawPicks({ ...p, links: [] });
    const r = await resolvePick(raw);
    if (r.status === 'ok') return r;
  }
  // Last resort: a YouTube video of that song (new bands, or shows with no tape yet).
  const v = await findSongVideo(p.artist, p.highlight, p.date);
  if (v) {
    const note = p.caveats ? `${p.why} Caveat: ${p.caveats}` : p.why;
    const t = videoToTrack(v, p.artist, [p.date, p.venue].filter(Boolean).join(' · ') || undefined);
    return {
      id: newKey(),
      input: `youtube:${v.id}`,
      status: 'ok',
      artist: p.artist,
      date: p.date ?? undefined,
      venue: p.venue ?? undefined,
      foundOn: ['youtube'],
      tracks: [{ ...t, note }],
      focus: 0,
      single: true,
      note,
    };
  }
  return last!;
}

function longestIndex(p: Pick) {
  let best = 0;
  p.tracks.forEach((t, i) => {
    if ((t.durationSec ?? 0) > (p.tracks[best].durationSec ?? 0)) best = i;
  });
  return best;
}

/** One song per pick: the named highlight, else the longest track; the curator's reason as the note. */
export function songsFor(p: Pick): Track[] {
  if (p.status !== 'ok' || !p.tracks.length) return [];
  const i = p.single ? 0 : (p.focus ?? longestIndex(p));
  const t = p.tracks[i];
  return t ? [{ ...t, note: p.note ?? t.note }] : [];
}

const shortDate = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
export const weekName = (at: number) => `Week of ${shortDate(at)}`;
export const runName = (run: WeeklyRun) =>
  run.kind === 'discovery' ? `New to Your Radar · ${shortDate(run.finishedAt ?? run.startedAt)}` : weekName(run.finishedAt ?? run.startedAt);

/** Create the weekly playlist and mark the run done. */
export async function publishWeek(run: WeeklyRun, tracks: Track[], missed: string[]) {
  const name = runName(run);
  const payload = tracks.map(({ key: _k, addedBy: _a, social: _s, ...t }) => t);
  const p = await api<{ id: string; name: string }>('/playlists', {
    name,
    tracks: payload,
    kind: run.kind === 'discovery' ? 'discovery' : 'weekly',
    week: new Date(run.finishedAt ?? run.startedAt).toISOString().slice(0, 10),
  });
  await weeklyApi.publish(run.id, p.id, missed);
  await playlists.refresh();
  return p;
}

let busy = false;

/** Build one run's playlist on this phone. Returns a toast message or null. */
async function publishOne(run: WeeklyRun, onProgress?: (msg: string) => void): Promise<string | null> {
  const { ok } = await weeklyApi.claim(run.id);
  if (!ok) return null;
  onProgress?.(`Building ${runName(run)}…`);
  const resolved = await Promise.all(run.picks.map((p) => resolveWeeklyPick(p).catch(() => null)));
  // Songs only on nugs/Spotify get a YouTube backup so everyone can play them.
  const tracks = await Promise.all(resolved.flatMap((r) => (r ? songsFor(r) : [])).map((t) => ensureFreeSource(t)));
  const missed = run.picks
    .filter((_, i) => resolved[i]?.status !== 'ok')
    .map((p) => `${p.artist}${p.date ? ` ${p.date}` : p.highlight ? ` (${p.highlight})` : ''}`);
  if (!tracks.length) return null;
  const p = await publishWeek(run, tracks, missed);
  return `${p.name} is up: ${tracks.length} songs${missed.length ? ` (${missed.length} couldn’t be found)` : ''}`;
}

/**
 * On app open: if the server has finished picks nobody has published yet
 * (Side A and/or Side B), and the group auto-publishes, build them here.
 */
export async function autoPublishIfReady(onProgress?: (msg: string) => void): Promise<string | null> {
  if (busy || !group.signedIn()) return null;
  busy = true;
  try {
    const res = await weeklyApi.pending();
    const runs = res.runs ?? (res.run ? [{ ...res.run, autoPublish: res.autoPublish }] : []);
    const msgs: string[] = [];
    for (const run of runs) {
      if (!run.autoPublish) {
        if (res.isOwner ?? group.get()?.me.role === 'owner')
          msgs.push(`${runName(run)} is ready to review (Friends → Weekly picks)`);
        continue;
      }
      const m = await publishOne(run, onProgress).catch(() => null);
      if (m) msgs.push(m);
    }
    return msgs.length ? msgs.join(' · ') : null;
  } catch {
    return null;
  } finally {
    busy = false;
  }
}
