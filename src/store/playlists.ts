import { useSyncExternalStore } from 'react';
import { newKey, type Playlist, type Track } from '../types';

/**
 * Playlists live in this browser for now. Export/import JSON is how you share
 * one with family until there's a small backend for shared playlists.
 */
const KEY = 'setlist.playlists.v1';

function load(): Playlist[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Playlist[]) : [];
  } catch {
    return [];
  }
}

let state: Playlist[] = load();
const listeners = new Set<() => void>();

function commit(next: Playlist[]) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked; keep working in memory */
  }
  listeners.forEach((l) => l());
}

const touch = (p: Playlist): Playlist => ({ ...p, updatedAt: Date.now() });
const update = (id: string, fn: (p: Playlist) => Playlist) =>
  commit(state.map((p) => (p.id === id ? touch(fn(p)) : p)));

export const playlists = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  all: () => state,
  get: (id: string) => state.find((p) => p.id === id),

  create(name: string, tracks: Track[] = []): Playlist {
    const now = Date.now();
    const p: Playlist = { id: newKey(), name: name.trim() || 'Untitled', tracks, createdAt: now, updatedAt: now };
    commit([p, ...state]);
    return p;
  },
  rename: (id: string, name: string) => update(id, (p) => ({ ...p, name: name.trim() || p.name })),
  remove: (id: string) => commit(state.filter((p) => p.id !== id)),

  addTracks: (id: string, tracks: Track[]) =>
    // fresh keys so the same song can sit in a playlist twice
    update(id, (p) => ({ ...p, tracks: [...p.tracks, ...tracks.map((t) => ({ ...t, key: newKey() }))] })),
  removeTrack: (id: string, key: string) =>
    update(id, (p) => ({ ...p, tracks: p.tracks.filter((t) => t.key !== key) })),
  moveTrack: (id: string, from: number, to: number) =>
    update(id, (p) => {
      if (to < 0 || to >= p.tracks.length) return p;
      const tracks = [...p.tracks];
      const [t] = tracks.splice(from, 1);
      tracks.splice(to, 0, t);
      return { ...p, tracks };
    }),

  exportJson: (id: string) => {
    const p = state.find((x) => x.id === id);
    return p ? JSON.stringify({ setlist: 1, name: p.name, tracks: p.tracks }, null, 2) : '';
  },
  importJson(text: string): Playlist {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.tracks)) throw new Error('Not a Setlist playlist file');
    const tracks: Track[] = data.tracks
      .filter((t: Partial<Track>) => t && t.source && t.sourceId && t.title)
      .map((t: Track) => ({ ...t, key: newKey() }));
    return playlists.create(String(data.name ?? 'Imported'), tracks);
  },
};

export function usePlaylists() {
  return useSyncExternalStore(playlists.subscribe, playlists.all);
}
