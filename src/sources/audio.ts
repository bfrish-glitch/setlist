import type { PlaybackEvents } from './types';

/**
 * One shared <audio> element for every source that plays plain audio files
 * (Relisten, nugs). Reusing the same element between tracks keeps iOS's audio
 * session alive, which is what lets the next song start with the phone locked.
 */
class SharedAudio {
  private audio: HTMLAudioElement | null = null;
  private detach: (() => void) | null = null;

  private el() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
    }
    return this.audio;
  }

  /** Call synchronously inside a tap so iOS unlocks audio before any await. */
  prime() {
    const a = this.el();
    if (!a.src) {
      // An empty play() inside the gesture is enough to unlock the element.
      a.play().catch(() => {});
    }
  }

  async play(url: string, fallbackDuration: number | undefined, ev: PlaybackEvents, errorText: string) {
    const a = this.el();
    this.detach?.();
    const onTime = () => ev.onTime(a.currentTime, a.duration || fallbackDuration || 0);
    const onEnded = () => ev.onEnded();
    const onPlay = () => ev.onPlayingChange(true);
    const onPause = () => ev.onPlayingChange(false);
    const onError = () => ev.onError(errorText);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnded);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('error', onError);
    this.detach = () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('error', onError);
    };
    a.src = url;
    await a.play();
  }

  pause() {
    this.audio?.pause();
  }
  resume() {
    void this.audio?.play();
  }
  seek(sec: number) {
    if (this.audio) this.audio.currentTime = sec;
  }
  stop() {
    this.detach?.();
    this.detach = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }
}

export const sharedAudio = new SharedAudio();
