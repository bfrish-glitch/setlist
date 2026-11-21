import type { SourceId } from '../types';
import type { SourceAdapter } from './types';
import { relisten } from './relisten';
import { apple, nugs, spotify, youtube } from './placeholders';

export const sources: Record<SourceId, SourceAdapter> = {
  relisten,
  apple,
  spotify,
  nugs,
  youtube,
};

export const sourceOrder: SourceId[] = ['relisten', 'apple', 'spotify', 'nugs', 'youtube'];

export const canPlay = (id: SourceId) => sources[id].status() === 'ready';
