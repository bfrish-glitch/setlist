import { useSyncExternalStore } from 'react';
import type { Track } from '../types';
import { playable, resolve, sources } from '../sources';
import { sharedAudio } from '../sources/audio';

export interface PlayerState {
  queue: Track[];
  index: number; // -1 = nothing loaded
  playing: boolean;
  loading: boolean;
  positionSec: number;
  durationSec: number;
  error: string | null;
  /** Keys of tracks we skipped because their service isn't connected. */
  skipped: string[];
}

const initial: PlayerState = {
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  positionSec: 0,
  durationSec: 0,
  error: null,
  skipped: [],
};

/** Where you were, so reopening the app picks up the same song at the same spot. */
const SAVE_KEY = 'setlist.player';
interface Saved {
  queue: Track[];
  index: number;
  positionSec: number;
  durationSec: number;
  savedAt: number;
}
function loadSaved(): PlayerState {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null;
    if (!s || !Array.isArray(s.queue) || s.index < 0 || s.index >= s.queue.length) return initial;
    return { ...initial, queue: s.queue, index: s.index, positionSec: s.positionSec || 0, durationSec: s.durationSec || 0 };
  } catch {
    return initial;
  }
}

/**
 * The conductor. Holds the queue and hands each track to the adapter for its
 * service. Switching services means: stop the old adapter, start the new one.
 */
class PlayerEngine {
  private state: PlayerState = loadSaved();
  private listeners = new Set<() => void>();
  private token = 0; // guards against late events from a track we already left
  /** A restored track isn't loaded into its service yet; the first play loads it at this spot. */
  private restored = this.state.index >= 0;
  /** Seek here once the track actually starts playing. */
  private startAt = 0;
  private lastSave = 0;

  /** Save the queue and spot (throttled unless forced). */
  save(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSave < 5000) return;
    this.lastSave = now;
    const { queue, index, positionSec, durationSec } = this.state;
    try {
      if (index < 0 || !queue.length) localStorage.removeItem(SAVE_KEY);
      else {
        const slim = queue.map(({ social: _s, ...t }) => t);
        localStorage.setItem(SAVE_KEY, JSON.stringify({ queue: slim, index, positionSec, durationSec, savedAt: now } satisfies Saved));
      }
    } catch {
      /* storage full or unavailable */
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.state;

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
    this.syncMediaSession();
  }

  /** The current track as resolved to a source this listener can play. */
  get current(): Track | undefined {
    const t = this.state.queue[this.state.index];
    return t ? (resolve(t) ?? t) : undefined;
  }

  /** Replace the queue and start at `startIndex`. */
  playQueue(queue: Track[], startIndex = 0) {
    // Unlock the shared audio element during this tap, so a later handoff
    // from Spotify to Relisten/nugs can start without another tap.
    sharedAudio.prime();
    this.stopCurrent();
    this.restored = false;
    this.set({ queue, index: -1, skipped: [], error: null });
    void this.goTo(startIndex, 1);
  }

  /** Add to the end of the queue without interrupting. */
  enqueue(tracks: Track[]) {
    const queue = [...this.state.queue, ...tracks];
    this.set({ queue });
    if (this.state.index === -1) void this.goTo(0, 1);
  }

  toggle() {
    const t = this.current;
    if (!t) return;
    if (this.restored) {
      // First play after reopening: load the saved song and jump to where you were.
      sharedAudio.prime();
      this.restored = false;
      void this.goTo(this.state.index, 1, this.state.positionSec);
      return;
    }
    const a = sources[t.source];
    if (this.state.playing) a.pause();
    else a.resume();
  }

  next() {
    this.restored = false;
    void this.goTo(this.state.index + 1, 1);
  }

  prev() {
    if (this.restored) {
      this.restored = false;
      if (this.state.positionSec > 4 || this.state.index <= 0) return void this.goTo(this.state.index, 1);
      return void this.goTo(this.state.index - 1, -1);
    }
    // Standard player behavior: restart the song unless we're near the top.
    if (this.state.positionSec > 4 || this.state.index <= 0) {
      this.seek(0);
      return;
    }
    void this.goTo(this.state.index - 1, -1);
  }

  seek(sec: number) {
    const t = this.current;
    if (!t) return;
    // Not loaded yet (just reopened): move the resume point instead.
    if (!this.restored) sources[t.source].seek(sec);
    this.set({ positionSec: sec });
    this.save(true);
  }

  jump(index: number) {
    this.restored = false;
    void this.goTo(index, 1);
  }

  private stopCurrent() {
    if (this.restored) return;
    const t = this.current;
    if (t) sources[t.source].stop();
  }

  /** Move to `index`, walking in `dir` past tracks we can't play. */
  private async goTo(index: number, dir: 1 | -1, startAt = 0) {
    const { queue } = this.state;
    const skipped = [...this.state.skipped];
    let i = index;
    while (i >= 0 && i < queue.length && !playable(queue[i])) {
      if (!skipped.includes(queue[i].key)) skipped.push(queue[i].key);
      i += dir;
    }

    this.stopCurrent();
    const token = ++this.token;

    if (i < 0 || i >= queue.length) {
      this.set({ index: -1, playing: false, loading: false, positionSec: 0, skipped });
      return;
    }

    const track = resolve(queue[i])!;
    this.startAt = i === index ? startAt : 0;
    this.set({
      index: i,
      loading: true,
      playing: false,
      positionSec: this.startAt,
      durationSec: track.durationSec ?? 0,
      error: null,
      skipped,
    });

    const live = () => token === this.token;
    try {
      await sources[track.source].play(track, {
        onTime: (positionSec, durationSec) => {
          if (!live() || this.startAt) return; // ignore the 0:00 ticks before the resume seek lands
          this.set({ positionSec, durationSec: durationSec || this.state.durationSec });
          this.save();
        },
        onEnded: () => live() && this.next(),
        onError: (msg) => {
          if (!live()) return;
          this.set({ error: `${track.title}: ${msg}`, loading: false });
          setTimeout(() => live() && this.next(), 1500);
        },
        onPlayingChange: (playing) => {
          if (!live()) return;
          if (playing && this.startAt) {
            const at = this.startAt;
            this.startAt = 0;
            sources[track.source].seek(at);
          }
          this.set({ playing, loading: false });
          this.save(true);
        },
      });
    } catch (e) {
      if (!live()) return;
      // Autoplay blocks show up here on mobile; leave the track loaded so a tap resumes it.
      const msg = e instanceof Error ? e.message : String(e);
      const blocked = /NotAllowed|user didn't interact|gesture/i.test(msg);
      this.set({ loading: false, playing: false, error: blocked ? null : `${track.title}: ${msg}` });
    }
  }

  /** Lock-screen / headphone controls and now-playing info. */
  private syncMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = this.current;
    const ms = navigator.mediaSession;
    if (!t) {
      ms.metadata = null;
      return;
    }
    if (ms.metadata?.title !== t.title || ms.metadata?.artist !== t.artist) {
      ms.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.subtitle ?? '',
        artwork: t.artworkUrl ? [{ src: t.artworkUrl }] : [],
      });
    }
    ms.playbackState = this.state.playing ? 'playing' : 'paused';
  }

  installMediaHandlers() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const safe = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* unsupported action */
      }
    };
    safe('play', () => this.toggle());
    safe('pause', () => this.toggle());
    safe('nexttrack', () => this.next());
    safe('previoustrack', () => this.prev());
    safe('seekto', (d) => d.seekTime != null && this.seek(d.seekTime));
  }
}

export const player = new PlayerEngine();
player.installMediaHandlers();
// Phones can kill a backgrounded app without warning, so save on the way out.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => player.save(true));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && player.save(true));
}

export function usePlayer() {
  return useSyncExternalStore(player.subscribe, player.get);
}
