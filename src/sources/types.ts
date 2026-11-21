import type { SourceId, Track } from '../types';

export type SourceStatus =
  | 'ready' // can play right now
  | 'needs-login' // implemented, user hasn't connected their account
  | 'coming-soon'; // not built yet

export interface PlaybackEvents {
  onTime: (positionSec: number, durationSec: number) => void;
  onEnded: () => void;
  onError: (message: string) => void;
  onPlayingChange: (playing: boolean) => void;
}

/**
 * Every service plugs into the player through this interface. The player
 * never talks to a service directly: when the queue moves to a track, it looks
 * up the adapter for track.source and hands control to it.
 */
export interface SourceAdapter {
  id: SourceId;
  name: string;
  /** Short color used for the source badge on each track. */
  color: string;
  status(): SourceStatus;
  /** One line explaining the status, shown on the Services screen. */
  statusNote(): string;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;

  play(track: Track, events: PlaybackEvents): Promise<void>;
  pause(): void;
  resume(): void;
  seek(positionSec: number): void;
  /** Stop and release the service's player so another source can take over. */
  stop(): void;
}
