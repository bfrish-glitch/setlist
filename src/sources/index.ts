import type { SourceId } from '../types';
import type { SourceAdapter } from './types';
import { relisten } from './relisten';
import { spotify } from './spotify';
import { apple, nugs, youtube } from './placeholders';

export const sources: Record<SourceId, SourceAdapter> = {
  relisten,
  apple,
  spotify,
  nugs,
  youtube,
};

export const sourceOrder: SourceId[] = ['relisten', 'spotify', 'apple', 'nugs', 'youtube'];

export const canPlay = (id: SourceId) => sources[id].status() === 'ready';
