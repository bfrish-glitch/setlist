export type SourceId = 'relisten' | 'nugs' | 'spotify' | 'apple' | 'youtube' | 'archive';

/**
 * A playable track from any service. Everything the player needs to show and
 * start the track lives here, so a saved playlist works without re-fetching.
 */
export interface Track {
  /** Unique per playlist entry (the same song can appear twice). */
  key: string;
  source: SourceId;
  /** The service's own id: Relisten track uuid, Spotify URI, Apple catalog id, etc. */
  sourceId: string;
  title: string;
  artist: string;
  /** Secondary line, e.g. "1977-05-08 · Barton Hall, Ithaca, NY". */
  subtitle?: string;
  durationSec?: number;
  artworkUrl?: string;
  /** Direct audio URL, for sources that expose one (Relisten). */
  streamUrl?: string;
  /** Play only part of the source (a jam inside a full-show YouTube video). */
  startSec?: number;
  endSec?: number;
  /**
   * Other services carrying the same performance. The player uses the first
   * of [primary, ...alts] that this listener can play.
   */
  alts?: SourceRef[];
  /** The full show this song comes from, on each service that has it. */
  shows?: ShowRef[];
  /** One-line note from the curator ("the 20-min one, peaks at 14:00"). */
  note?: string;
  /** Shared playlists: who added it. */
  addedBy?: string;
  /** Shared playlists: member ids who 🔥'd / listened, and the comment count. */
  social?: { fire: string[]; listened: string[]; comments: number };
}

/**
 * A whole show on one service, so "play the full show" works from any song.
 * relisten: "<artist-slug>/<yyyy-mm-dd>", nugs: container id,
 * archive: identifier, youtube: video id (a full-show upload).
 */
export interface ShowRef {
  source: SourceId;
  id: string;
}

/** Another place the same performance can play. */
export interface SourceRef {
  source: SourceId;
  sourceId: string;
  streamUrl?: string;
  durationSec?: number;
  startSec?: number;
  endSec?: number;
}

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  /** Shared playlists only. */
  createdBy?: string;
  createdById?: string;
  kind?: string;
  createdAt: number;
  updatedAt: number;
}

export const newKey = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
