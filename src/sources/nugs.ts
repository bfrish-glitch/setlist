import { NUGS_RELAY } from '../config';
import { newKey, type Track } from '../types';
import { sharedAudio } from './audio';
import { notifySourcesChanged } from './changes';
import type { PlaybackEvents, SourceAdapter } from './types';

/**
 * nugs.net through our Cloudflare relay (worker/). Tokens and subscription
 * details stay in this browser; the relay just forwards requests.
 */

const KEY = 'setlist.nugs.session.v1';

interface Sub {
  subscriptionID: string;
  subCostplanIDAccessList: string;
  startDateStamp: string;
  endDateStamp: string;
}

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  userId?: string;
  name?: string;
  email?: string;
  subscribed?: boolean;
  sub?: Sub | null;
}

const read = (): Session | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};
const write = (s: Session | null) => {
  if (s) localStorage.setItem(KEY, JSON.stringify(s));
  else localStorage.removeItem(KEY);
  notifySourcesChanged();
};

class NugsError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
  }
}

async function relay<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${NUGS_RELAY}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new NugsError('Can’t reach the Setlist nugs server');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new NugsError(j.error || `nugs relay error ${r.status}`, j.code, r.status);
  return j as T;
}

interface TokenOut {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

let refreshing: Promise<string> | null = null;
async function token(): Promise<string> {
  const s = read();
  if (!s) throw new NugsError('Not signed in to nugs');
  if (Date.now() < s.expires_at) return s.access_token;
  refreshing ??= relay<TokenOut>('/nugs/refresh', { method: 'POST', body: JSON.stringify({ refresh_token: s.refresh_token }) })
    .then((t) => {
      write({ ...read()!, access_token: t.access_token, refresh_token: t.refresh_token || s.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 });
      return t.access_token;
    })
    .catch((e) => {
      if (e instanceof NugsError && (e.status === 400 || e.status === 401)) write(null);
      throw e;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

/** Authenticated GET with one retry after a token refresh. */
async function authed<T>(path: string): Promise<T> {
  try {
    return await relay<T>(path, {}, await token());
  } catch (e) {
    if (e instanceof NugsError && e.code === 'expired') {
      const s = read();
      if (s) write({ ...s, expires_at: 0 });
      return relay<T>(path, {}, await token());
    }
    throw e;
  }
}

/* ---- catalog ------------------------------------------------------- */

export interface NugsArtist {
  id: string;
  name: string;
}
export interface NugsShow {
  id: string;
  artistId?: string;
  artist: string;
  title: string;
  date: string;
  venue: string;
  artwork?: string;
}
export interface NugsSong {
  trackId: string;
  title: string;
  durationSec?: number;
  set: number;
  position: number;
}

export const nugsApi = {
  search: (q: string) => authed<{ artists: NugsArtist[]; shows: NugsShow[] }>(`/nugs/search?q=${encodeURIComponent(q)}`),
  artistShows: (id: string) => authed<{ shows: NugsShow[]; total: number }>(`/nugs/artist?id=${encodeURIComponent(id)}`),
  show: (id: string) => authed<NugsShow & { songs: NugsSong[] }>(`/nugs/show?id=${encodeURIComponent(id)}`),
};

export function nugsToTrack(song: NugsSong, show: NugsShow): Track {
  return {
    key: newKey(),
    source: 'nugs',
    sourceId: song.trackId,
    title: song.title,
    artist: show.artist,
    subtitle: [show.date, show.venue || show.title].filter(Boolean).join(' · '),
    durationSec: song.durationSec,
    artworkUrl: show.artwork,
  };
}

/* ---- adapter ------------------------------------------------------- */

class NugsAdapter implements SourceAdapter {
  id = 'nugs' as const;
  name = 'nugs.net';
  color = '#e85d2a';
  lastFormat: string | null = null;

  status() {
    if (!NUGS_RELAY) return 'coming-soon' as const;
    return read() ? ('ready' as const) : ('needs-login' as const);
  }

  statusNote() {
    if (!NUGS_RELAY) return 'Waiting on the nugs server address in the app config.';
    const s = read();
    if (!s) return 'Sign in with your nugs.net account. Needs an active subscription.';
    const who = s.name || s.email || 'your account';
    if (s.subscribed === false) return `Signed in as ${who}, but nugs doesn’t show an active subscription.`;
    return `Signed in as ${who}.${this.lastFormat ? ` Streaming ${this.lastFormat}.` : ''} Unofficial: may break when nugs updates their app.`;
  }

  /** Sign in with email + password. The password goes to nugs via the relay and isn't stored anywhere. */
  async login(email: string, password: string) {
    const t = await relay<TokenOut>('/nugs/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    const session: Session = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + (t.expires_in - 60) * 1000,
      email,
    };
    write(session);
    try {
      await this.loadProfile();
    } catch (e) {
      write(null);
      throw e;
    }
  }

  private async loadProfile() {
    const me = await authed<{ userId: string; name: string; subscribed: boolean; sub: Sub | null }>('/nugs/me');
    write({ ...read()!, userId: me.userId, name: me.name, subscribed: me.subscribed, sub: me.sub });
    return read()!;
  }

  async disconnect() {
    this.stop();
    write(null);
  }

  async play(track: Track, ev: PlaybackEvents) {
    let s = read();
    if (!s) throw new Error('Sign in to nugs first');
    if (!s.sub || !s.userId) s = await this.loadProfile();
    if (!s.sub) throw new Error('nugs doesn’t show an active subscription on this account');
    const q = new URLSearchParams({ trackID: track.sourceId, nn_userID: s.userId!, ...s.sub });
    const res = await authed<{ url: string; format: string }>(`/nugs/stream?${q}`);
    if (this.lastFormat !== res.format) {
      this.lastFormat = res.format;
      notifySourcesChanged();
    }
    await sharedAudio.play(res.url, track.durationSec, ev, 'nugs stream failed to load');
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

export const nugs = new NugsAdapter();
