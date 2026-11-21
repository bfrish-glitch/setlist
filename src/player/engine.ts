import { useSyncExternalStore } from 'react';
import type { Track } from '../types';
import { canPlay, sources } from '../sources';
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

/**
 * The conductor. Holds the queue and hands each track to the adapter for its
 * service. Switching services means: stop the old adapter, start the new one.
 */
class PlayerEngine {
  private state: PlayerState = initial;
  private listeners = new Set<() => void>();
  private token = 0; // guards against late events from a track we already left

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

  get current(): Track | undefined {
    return this.state.queue[this.state.index];
  }

  /** Replace the queue and start at `startIndex`. */
  playQueue(queue: Track[], startIndex = 0) {
    // Unlock the shared audio element during this tap, so a later handoff
    // from Spotify to Relisten/nugs can start without another tap.
    sharedAudio.prime();
    this.stopCurrent();
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
    const a = sources[t.source];
    if (this.state.playing) a.pause();
    else a.resume();
  }

  next() {
    void this.goTo(this.state.index + 1, 1);
  }

  prev() {
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
    sources[t.source].seek(sec);
    this.set({ positionSec: sec });
  }

  jump(index: number) {
    void this.goTo(index, 1);
  }

  private stopCurrent() {
    const t = this.current;
    if (t) sources[t.source].stop();
  }

  /** Move to `index`, walking in `dir` past tracks we can't play. */
  private async goTo(index: number, dir: 1 | -1) {
    const { queue } = this.state;
    const skipped = [...this.state.skipped];
    let i = index;
    while (i >= 0 && i < queue.length && !canPlay(queue[i].source)) {
      if (!skipped.includes(queue[i].key)) skipped.push(queue[i].key);
      i += dir;
    }

    this.stopCurrent();
    const token = ++this.token;

    if (i < 0 || i >= queue.length) {
      this.set({ index: -1, playing: false, loading: false, positionSec: 0, skipped });
      return;
    }

    const track = queue[i];
    this.set({
      index: i,
      loading: true,
      playing: false,
      positionSec: 0,
      durationSec: track.durationSec ?? 0,
      error: null,
      skipped,
    });

    const live = () => token === this.token;
    try {
      await sources[track.source].play(track, {
        onTime: (positionSec, durationSec) =>
          live() && this.set({ positionSec, durationSec: durationSec || this.state.durationSec }),
        onEnded: () => live() && this.next(),
        onError: (msg) => {
          if (!live()) return;
          this.set({ error: `${track.title}: ${msg}`, loading: false });
          setTimeout(() => live() && this.next(), 1500);
        },
        onPlayingChange: (playing) => live() && this.set({ playing, loading: false }),
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

export function usePlayer() {
  return useSyncExternalStore(player.subscribe, player.get);
}
