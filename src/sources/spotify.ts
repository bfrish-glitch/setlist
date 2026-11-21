import { SPOTIFY_CLIENT_ID, appUrl } from '../config';
import { newKey, type Track } from '../types';
import { notifySourcesChanged } from './changes';
import type { PlaybackEvents, SourceAdapter } from './types';

/* ================================================================== */
/* Auth: Authorization Code + PKCE, entirely in the browser.            */
/* ================================================================== */

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'user-library-read',
].join(' ');

const TOKEN_KEY = 'setlist.spotify.token.v1';
const VERIFIER_KEY = 'setlist.spotify.pkce';

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms epoch
}

const readToken = (): StoredToken | null => {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null');
  } catch {
    return null;
  }
};
const writeToken = (t: StoredToken | null) => {
  if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  else localStorage.removeItem(TOKEN_KEY);
  notifySourcesChanged();
};

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function startLogin() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: appUrl(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  window.location.assign(`https://accounts.spotify.com/authorize?${q}`);
}

async function tokenRequest(body: Record<string, string>): Promise<StoredToken> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: SPOTIFY_CLIENT_ID, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || `Spotify login failed (${r.status})`);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? readToken()?.refresh_token ?? '',
    expires_at: Date.now() + (j.expires_in - 60) * 1000,
  };
}

/** Call once on startup: finishes a login if Spotify just redirected back to us. */
export async function handleSpotifyRedirect(): Promise<string | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (!code && !err) return null;
  const saved = JSON.parse(sessionStorage.getItem(VERIFIER_KEY) ?? 'null');
  sessionStorage.removeItem(VERIFIER_KEY);
  window.history.replaceState(null, '', appUrl());
  if (err) return err === 'access_denied' ? 'Spotify login cancelled' : `Spotify login error: ${err}`;
  if (!saved || saved.state !== url.searchParams.get('state')) return 'Spotify login expired, try again';
  try {
    writeToken(
      await tokenRequest({ grant_type: 'authorization_code', code: code!, redirect_uri: appUrl(), code_verifier: saved.verifier }),
    );
    return 'Spotify connected';
  } catch (e) {
    return e instanceof Error ? e.message : 'Spotify login failed';
  }
}

let refreshing: Promise<string> | null = null;
async function accessToken(): Promise<string> {
  const t = readToken();
  if (!t) throw new Error('Not signed in to Spotify');
  if (Date.now() < t.expires_at) return t.access_token;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
    .then((nt) => {
      writeToken(nt);
      return nt.access_token;
    })
    .catch((e) => {
      writeToken(null); // refresh token revoked: make them sign in again
      throw e;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

/* ================================================================== */
/* Web API                                                              */
/* ================================================================== */

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (r.status === 204 || r.status === 202) return undefined as T;
  const text = await r.text();
  const j = text ? JSON.parse(text) : undefined;
  if (!r.ok) {
    const msg = j?.error?.message || `Spotify ${r.status}`;
    if (r.status === 403 && /premium/i.test(msg)) throw new Error('Spotify Premium is required for playback');
    if (r.status === 403) throw new Error(`${msg}. Is this account on the app's allowlist?`);
    throw new Error(msg);
  }
  return j as T;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album: { name: string; images: { url: string; width: number }[] };
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  images: { url: string }[] | null;
  owner: { display_name: string };
  items?: { total: number };
  tracks?: { total: number };
}

interface Device {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
}

interface PlaybackState {
  is_playing: boolean;
  progress_ms: number | null;
  device?: Device;
  item: SpotifyTrack | null;
}

export const spotifyApi = {
  me: () => api<{ display_name: string; id: string }>('/me'),
  // Dev-mode apps max out at 10 results per search.
  searchTracks: async (q: string) =>
    (await api<{ tracks: { items: SpotifyTrack[] } }>(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`)).tracks
      .items,
  myPlaylists: async () => (await api<{ items: SpotifyPlaylist[] }>('/me/playlists?limit=50')).items,
  playlistTracks: async (id: string) => {
    const out: SpotifyTrack[] = [];
    let url: string | null = `/playlists/${id}/items?limit=50`;
    while (url) {
      const page: { items: { item?: SpotifyTrack; track?: SpotifyTrack }[]; next: string | null } = await api(url);
      for (const row of page.items) {
        const t = row.item ?? row.track;
        if (t?.uri?.startsWith('spotify:track:')) out.push(t);
      }
      url = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
    }
    return out;
  },
  likedTracks: async () =>
    (await api<{ items: { track: SpotifyTrack }[] }>('/me/tracks?limit=50')).items.map((r) => r.track),
};

export function spotifyToTrack(t: SpotifyTrack): Track {
  const art = [...(t.album?.images ?? [])].sort((a, b) => a.width - b.width);
  return {
    key: newKey(),
    source: 'spotify',
    sourceId: t.uri,
    title: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    subtitle: t.album?.name,
    durationSec: Math.round(t.duration_ms / 1000),
    artworkUrl: (art.find((i) => i.width >= 300) ?? art[art.length - 1])?.url,
  };
}

/* ================================================================== */
/* Playback                                                             */
/*                                                                      */
/* Mode 1 "browser": the Web Playback SDK turns this page into a        */
/*   Spotify Connect device and plays inside the browser.               */
/* Mode 2 "remote": if the SDK can't start (some iPhone Safari setups), */
/*   we drive the Spotify app on this phone (or any active device)      */
/*   through the Web API and poll it to know when the song ends.        */
/* ================================================================== */

type Mode = 'browser' | 'remote';

interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: { uri: string; id: string } | null; previous_tracks: { uri: string; id: string }[] };
}

interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(ev: string, cb: (arg: never) => void): void;
  getCurrentState(): Promise<SdkState | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  activateElement(): Promise<void>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: new (opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) => SdkPlayer };
  }
}

let sdkLoad: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  sdkLoad ??= new Promise((resolve, reject) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error('Could not load the Spotify player'));
    document.head.appendChild(s);
  });
  return sdkLoad;
}

class SpotifyAdapter implements SourceAdapter {
  id = 'spotify' as const;
  name = 'Spotify';
  color = '#1db954';

  private sdk: SdkPlayer | null = null;
  private deviceId: string | null = null;
  private sdkFailed: string | null = null;
  private sdkStarting: Promise<void> | null = null;
  mode: Mode = 'browser';
  remoteDeviceName: string | null = null;
  userName: string | null = null;

  private current: { uri: string; ev: PlaybackEvents; started: boolean; ended: boolean } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  status() {
    if (!SPOTIFY_CLIENT_ID) return 'coming-soon' as const;
    return readToken() ? ('ready' as const) : ('needs-login' as const);
  }

  statusNote() {
    if (!SPOTIFY_CLIENT_ID) return 'Waiting on the Spotify client ID in the app config.';
    if (!readToken()) return 'Premium required. Your account must be on the app’s allowlist (max 5 people).';
    const who = this.userName ? `Signed in as ${this.userName}. ` : 'Signed in. ';
    if (this.mode === 'remote')
      return `${who}Playing through the Spotify app${this.remoteDeviceName ? ` (${this.remoteDeviceName})` : ''}, since in-browser playback isn’t available here.`;
    return `${who}Plays right here in the browser.`;
  }

  async connect() {
    await startLogin();
  }

  async disconnect() {
    this.stop();
    this.sdk?.disconnect();
    this.sdk = null;
    this.deviceId = null;
    this.userName = null;
    writeToken(null);
  }

  /** Warm up after login so the first play is fast. Safe to call repeatedly. */
  async warmUp() {
    if (this.status() !== 'ready') return;
    spotifyApi
      .me()
      .then((m) => {
        this.userName = m.display_name || m.id;
        notifySourcesChanged();
      })
      .catch(() => {});
    void this.startSdk().catch(() => {});
  }

  private startSdk(): Promise<void> {
    if (this.deviceId) return Promise.resolve();
    if (this.sdkFailed) return Promise.reject(new Error(this.sdkFailed));
    this.sdkStarting ??= (async () => {
      await loadSdk();
      const player = new window.Spotify!.Player({
        name: 'Setlist',
        getOAuthToken: (cb) => void accessToken().then(cb, () => {}),
        volume: 1,
      });
      const ready = new Promise<void>((resolve, reject) => {
        const fail = (why: string) => (e: { message: string }) => {
          this.sdkFailed = `${why}: ${e.message}`;
          reject(new Error(this.sdkFailed));
        };
        player.addListener('ready', ({ device_id }: { device_id: string }) => {
          this.deviceId = device_id;
          resolve();
        });
        player.addListener('not_ready', () => (this.deviceId = null));
        player.addListener('initialization_error', fail('This browser can’t play Spotify directly'));
        player.addListener('authentication_error', fail('Spotify sign-in problem'));
        player.addListener('account_error', fail('Spotify Premium is required'));
        player.addListener('playback_error', (e: { message: string }) => this.current?.ev.onError(e.message));
        player.addListener('player_state_changed', (s: SdkState | null) => this.onSdkState(s));
        setTimeout(() => {
          if (!this.deviceId) fail('Spotify player timed out')({ message: 'no response' });
        }, 10000);
      });
      const ok = await player.connect();
      if (!ok) throw new Error('Spotify player could not connect');
      this.sdk = player;
      await ready;
    })().catch((e) => {
      this.sdkStarting = null;
      this.mode = 'remote';
      notifySourcesChanged();
      throw e;
    });
    return this.sdkStarting;
  }

  async play(track: Track, ev: PlaybackEvents) {
    // Mobile browsers only allow audio that starts from a tap. This must run
    // before any await so it's still inside the tap that triggered playback.
    void this.sdk?.activateElement().catch(() => {});

    this.stopPolling();
    this.current = { uri: track.sourceId, ev, started: false, ended: false };

    if (this.mode === 'browser') {
      try {
        await this.startSdk();
        await api(`/me/player/play?device_id=${this.deviceId}`, {
          method: 'PUT',
          body: JSON.stringify({ uris: [track.sourceId] }),
        });
        this.startPolling(() => this.pollSdk());
        return;
      } catch (e) {
        if (!this.sdkFailed) throw e; // real API error (Premium, allowlist…): surface it
        this.mode = 'remote';
        notifySourcesChanged();
      }
    }
    await this.playRemote(track);
  }

  private async playRemote(track: Track) {
    const { devices } = await api<{ devices: Device[] }>('/me/player/devices');
    const usable = devices.filter((d) => !d.is_restricted && d.id !== this.deviceId);
    const target =
      usable.find((d) => d.is_active) ?? usable.find((d) => d.type === 'Smartphone') ?? usable[0];
    if (!target)
      throw new Error('Open the Spotify app on this phone once so Setlist can play through it, then try again');
    this.remoteDeviceName = target.name;
    notifySourcesChanged();
    await api(`/me/player/play?device_id=${target.id}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [track.sourceId] }),
    });
    this.startPolling(() => this.pollRemote(), 1000);
  }

  /* ---- end-of-track detection ------------------------------------- */

  private finish() {
    const c = this.current;
    if (!c || c.ended) return;
    c.ended = true;
    this.stopPolling();
    // Stop Spotify from rolling into autoplay/radio on its own.
    if (this.mode === 'browser') void this.sdk?.pause().catch(() => {});
    else void api('/me/player/pause', { method: 'PUT' }).catch(() => {});
    c.ev.onEnded();
  }

  private judge(uri: string | undefined, paused: boolean, posMs: number, durMs: number, prev: string[] = []) {
    const c = this.current;
    if (!c || c.ended) return;
    const ours = uri === c.uri;
    if (ours && !paused && posMs > 0) c.started = true;
    if (!c.started) return;
    c.ev.onTime(posMs / 1000, durMs / 1000);
    const endedHere = ours && paused && (posMs === 0 || durMs - posMs < 1500);
    const movedOn = !ours && (prev.includes(c.uri) || uri !== undefined);
    if (endedHere || movedOn) this.finish();
  }

  private onSdkState(s: SdkState | null) {
    if (!s || this.mode !== 'browser') return;
    const uri = s.track_window.current_track?.uri;
    if (this.current && uri === this.current.uri) this.current.ev.onPlayingChange(!s.paused);
    this.judge(uri, s.paused, s.position, s.duration, s.track_window.previous_tracks.map((t) => t.uri));
  }

  private async pollSdk() {
    const s = await this.sdk?.getCurrentState();
    if (s) this.onSdkState(s);
  }

  private async pollRemote() {
    const s = await api<PlaybackState | undefined>('/me/player').catch(() => undefined);
    if (!s || !this.current) return;
    const uri = s.item?.uri;
    if (uri === this.current.uri) this.current.ev.onPlayingChange(s.is_playing);
    this.judge(uri, !s.is_playing, s.progress_ms ?? 0, s.item?.duration_ms ?? 0);
  }

  private startPolling(fn: () => Promise<void>, ms = 500) {
    this.stopPolling();
    this.poll = setInterval(() => void fn().catch(() => {}), ms);
  }
  private stopPolling() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /* ---- transport -------------------------------------------------- */

  pause() {
    if (this.mode === 'browser') void this.sdk?.pause();
    else void api('/me/player/pause', { method: 'PUT' }).then(() => this.current?.ev.onPlayingChange(false));
  }
  resume() {
    void this.sdk?.activateElement().catch(() => {});
    if (this.mode === 'browser') void this.sdk?.resume();
    else void api('/me/player/play', { method: 'PUT' }).then(() => this.current?.ev.onPlayingChange(true));
  }
  seek(sec: number) {
    const ms = Math.round(sec * 1000);
    if (this.mode === 'browser') void this.sdk?.seek(ms);
    else void api(`/me/player/seek?position_ms=${ms}`, { method: 'PUT' });
  }
  stop() {
    const wasPlaying = this.current && !this.current.ended;
    this.stopPolling();
    this.current = null;
    if (!wasPlaying) return;
    if (this.mode === 'browser') void this.sdk?.pause().catch(() => {});
    else void api('/me/player/pause', { method: 'PUT' }).catch(() => {});
  }
}

export const spotify = new SpotifyAdapter();
