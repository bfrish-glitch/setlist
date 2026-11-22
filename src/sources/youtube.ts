import { SERVER } from '../config';
import { newKey, type Track } from '../types';
import { notifySourcesChanged } from './changes';
import type { PlaybackEvents, SourceAdapter } from './types';

/**
 * YouTube through the official IFrame player. YouTube's rules require the
 * video to be visible, so a small player panel appears above the controls
 * while a YouTube track is on. It can't play with the phone locked.
 *
 * Tracks can have startSec/endSec, so one jam inside a full-show upload can
 * be its own playlist entry.
 */

interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(sec: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        o: {
          width?: string;
          height?: string;
          playerVars?: Record<string, number | string>;
          events?: Record<string, (e: { data: number; target: YTPlayer }) => void>;
        },
      ) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/** Parse a YouTube link into { id, start }. Handles watch, youtu.be, shorts, live, embed. */
export function parseYouTube(input: string): { id: string; start?: number } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') ?? /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = u.searchParams.get('t') ?? u.searchParams.get('start');
  let start: number | undefined;
  if (t) {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
    start = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : undefined;
  }
  return { id, start: start || undefined };
}

export async function youtubeTrack(id: string, start?: number): Promise<Track> {
  const r = await fetch(`${SERVER}/resolve/youtube?id=${id}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Couldn’t load that YouTube video');
  return {
    key: newKey(),
    source: 'youtube',
    sourceId: id,
    title: j.title,
    artist: j.channel,
    artworkUrl: j.thumbnail,
    startSec: start,
  };
}

let apiLoad: Promise<void> | null = null;
function loadApi() {
  apiLoad ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('Couldn’t load the YouTube player'));
    document.head.appendChild(s);
  });
  return apiLoad;
}

class YouTubeAdapter implements SourceAdapter {
  id = 'youtube' as const;
  name = 'YouTube';
  color = '#ff0033';

  private player: YTPlayer | null = null;
  private ready: Promise<YTPlayer> | null = null;
  private host: HTMLDivElement | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private cur: { track: Track; ev: PlaybackEvents; ended: boolean } | null = null;
  /** True while the panel is showing; the UI listens to lay itself out. */
  visible = false;
  needsTap = false;

  status() {
    return 'ready' as const;
  }
  statusNote() {
    return 'No account needed. The video shows while it plays, and it stops if the phone locks.';
  }

  private mount(): Promise<YTPlayer> {
    this.ready ??= loadApi().then(
      () =>
        new Promise<YTPlayer>((resolve) => {
          this.host = document.createElement('div');
          this.host.className = 'yt-panel';
          const inner = document.createElement('div');
          this.host.appendChild(inner);
          document.body.appendChild(this.host);
          const p = new window.YT!.Player(inner, {
            width: '100%',
            height: '100%',
            playerVars: { playsinline: 1, rel: 0, modestbranding: 1, autoplay: 1 },
            events: {
              onReady: () => resolve(p),
              onStateChange: (e) => this.onState(e.data),
              onError: (e) => {
                const why = e.data === 101 || e.data === 150 ? 'This video can’t be played outside YouTube' : e.data === 100 ? 'Video removed or private' : 'YouTube error';
                this.cur?.ev.onError(why);
              },
            },
          });
          this.player = p;
        }),
    );
    return this.ready;
  }

  /** Load the YouTube player early so the first play is quick. */
  warmUp() {
    void this.mount().catch(() => {});
  }

  private show(on: boolean) {
    this.visible = on;
    this.host?.classList.toggle('on', on);
    document.body.classList.toggle('yt-on', on);
    notifySourcesChanged();
  }

  private onState(state: number) {
    const c = this.cur;
    if (!c) return;
    if (state === S.PLAYING) {
      if (this.needsTap) {
        this.needsTap = false;
        notifySourcesChanged();
      }
      c.ev.onPlayingChange(true);
    } else if (state === S.PAUSED) c.ev.onPlayingChange(false);
    else if (state === S.ENDED) this.finish();
  }

  private finish() {
    const c = this.cur;
    if (!c || c.ended) return;
    c.ended = true;
    this.stopPolling();
    c.ev.onEnded();
  }

  async play(track: Track, ev: PlaybackEvents) {
    this.cur = { track, ev, ended: false };
    const p = await this.mount();
    if (this.cur?.track !== track) return; // user already moved on
    this.show(true);
    p.loadVideoById({ videoId: track.sourceId, startSeconds: track.startSec, endSeconds: track.endSec });
    const start = track.startSec ?? 0;
    this.stopPolling();
    this.poll = setInterval(() => {
      const c = this.cur;
      if (!c || c.track !== track) return;
      const t = p.getCurrentTime() || 0;
      const end = track.endSec ?? p.getDuration();
      ev.onTime(Math.max(0, t - start), Math.max(0, (end || 0) - start));
      if (track.endSec && t >= track.endSec - 0.3) this.finish();
    }, 500);
    // Phones often block video that wasn't started by a tap on the video itself.
    setTimeout(() => {
      if (this.cur?.track !== track) return;
      const st = p.getPlayerState();
      if (st === S.UNSTARTED || st === S.CUED) {
        this.needsTap = true;
        notifySourcesChanged();
        ev.onPlayingChange(false);
      }
    }, 2500);
  }

  pause() {
    this.player?.pauseVideo();
  }
  resume() {
    this.player?.playVideo();
  }
  seek(sec: number) {
    this.player?.seekTo((this.cur?.track.startSec ?? 0) + sec, true);
  }
  private stopPolling() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
  stop() {
    this.stopPolling();
    this.cur = null;
    this.needsTap = false;
    try {
      this.player?.stopVideo();
    } catch {
      /* not ready */
    }
    if (this.visible) this.show(false);
  }
}

export const youtube = new YouTubeAdapter();
