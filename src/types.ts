export type SourceId = 'relisten' | 'nugs' | 'spotify' | 'apple' | 'youtube';

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
}

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
  updatedAt: number;
}

export const newKey = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
