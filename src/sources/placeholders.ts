import type { SourceId } from '../types';
import type { SourceAdapter } from './types';

/**
 * Slots for services that aren't wired up yet. They register with the player
 * so mixed playlists already understand them; tracks from these sources are
 * skipped until the real adapter replaces the placeholder.
 */
function placeholder(id: SourceId, name: string, color: string, note: string): SourceAdapter {
  const notReady = () => {
    throw new Error(`${name} isn't connected yet`);
  };
  return {
    id,
    name,
    color,
    status: () => 'coming-soon',
    statusNote: () => note,
    play: async () => notReady(),
    pause: () => {},
    resume: () => {},
    seek: () => {},
    stop: () => {},
  };
}

export const apple = placeholder(
  'apple',
  'Apple Music',
  '#fa243c',
  'Parked for now. Needs an Apple Developer account to switch on.',
);

export const nugs = placeholder(
  'nugs',
  'nugs.net',
  '#e85d2a',
  'No official API, so this needs a small server that signs in for each person. Can break when nugs changes things.',
);

export const youtube = placeholder(
  'youtube',
  'YouTube',
  '#ff0033',
  'IFrame player. The video has to stay visible and it won’t play with the phone locked.',
);
