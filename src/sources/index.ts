import type { SourceId, Track } from '../types';
import type { SourceAdapter } from './types';
import { relisten } from './relisten';
import { spotify } from './spotify';
import { nugs } from './nugs';
import { apple, youtube } from './placeholders';

export const sources: Record<SourceId, SourceAdapter> = {
  relisten,
  apple,
  spotify,
  nugs,
  youtube,
};

export const sourceOrder: SourceId[] = ['relisten', 'nugs', 'spotify', 'apple', 'youtube'];

export const canPlay = (id: SourceId) => sources[id].status() === 'ready';

/**
 * The version of `track` this listener can actually play: the primary source
 * if they have it, otherwise the first alternate they do. Null if none.
 */
export function resolve(track: Track): Track | null {
  if (canPlay(track.source)) return track;
  for (const alt of track.alts ?? []) {
    if (canPlay(alt.source))
      return { ...track, source: alt.source, sourceId: alt.sourceId, streamUrl: alt.streamUrl, durationSec: alt.durationSec ?? track.durationSec };
  }
  return null;
}

export const playable = (track: Track) => resolve(track) !== null;
