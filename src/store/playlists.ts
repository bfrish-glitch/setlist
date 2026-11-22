import { useSyncExternalStore } from 'react';
import { newKey, type Playlist, type Track } from '../types';
import { api, group } from '../group/group';

/**
 * Playlists, in one of two modes:
 * - Signed into the group: shared on the server. Changes apply on screen
 *   right away, then the server's copy replaces them; other people's changes
 *   arrive through a refresh every 20s and whenever the app comes back.
 * - Not signed in: kept in this browser only (the original behavior).
 */
const LOCAL_KEY = 'setlist.playlists.v1';

function loadLocal(): Playlist[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as Playlist[]) : [];
  } catch {
    return [];
  }
}

const shared = () => group.signedIn();

let state: Playlist[] = shared() ? [] : loadLocal();
let loaded = !shared();
let lastError: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function commit(next: Playlist[]) {
  state = next;
  if (!shared()) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
    } catch {
      /* storage full or blocked */
    }
  }
  emit();
}

const replace = (p: Playlist) => commit(state.some((x) => x.id === p.id) ? state.map((x) => (x.id === p.id ? p : x)) : [p, ...state]);
const localUpdate = (id: string, fn: (p: Playlist) => Playlist) =>
  commit(state.map((p) => (p.id === id ? { ...fn(p), updatedAt: Date.now() } : p)));

/** Apply a change locally now, then sync it; on failure, reload the truth from the server. */
async function sharedOp(tempOrId: string, optimistic: (p: Playlist) => Playlist, path: string, body: unknown) {
  const id = await resolveId(tempOrId);
  localUpdate(id, optimistic);
  try {
    const fresh = await api<Playlist>(`/playlists/${id}/${path}`, body);
    replace(fresh);
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Sync failed';
    void playlists.refresh();
    throw e;
  }
}

export const playlists = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  all: () => state,
  get: (id: string) => state.find((p) => p.id === id),
  isShared: shared,
  isLoaded: () => loaded,
  lastError: () => lastError,

  /** Pull the latest shared playlists from the server. */
  async refresh() {
    if (!shared()) {
      state = loadLocal();
      loaded = true;
      emit();
      return;
    }
    try {
      state = await api<Playlist[]>('/playlists');
      loaded = true;
      lastError = null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'Couldn’t load playlists';
    }
    emit();
  },

  /** After joining: copy this browser's playlists into the group, then clear them locally. */
  async migrateLocal(): Promise<number> {
    const local = loadLocal().filter((p) => p.tracks.length > 0);
    for (const p of local) {
      await api<Playlist>('/playlists', { name: p.name, tracks: p.tracks, createdAt: p.createdAt });
    }
    localStorage.removeItem(LOCAL_KEY);
    await playlists.refresh();
    return local.length;
  },

  create(name: string, tracks: Track[] = []): Playlist {
    const now = Date.now();
    const p: Playlist = {
      id: newKey(),
      name: name.trim() || 'Untitled',
      tracks: tracks.map((t) => ({ ...t, key: newKey() })),
      createdAt: now,
      updatedAt: now,
      createdBy: group.get()?.me.name,
      createdById: group.get()?.me.id,
    };
    commit([p, ...state]);
    if (shared()) {
      // Server assigns the real id; swap it in when it answers.
      const payload = tracks.map(({ key: _k, addedBy: _a, ...t }) => t);
      const pending = api<Playlist>('/playlists', { name: p.name, tracks: payload })
        .then((fresh) => {
          pendingIds.set(p.id, fresh.id);
          state = state.map((x) => (x.id === p.id ? fresh : x));
          emit();
          return fresh.id;
        })
        .catch((e) => {
          lastError = e instanceof Error ? e.message : 'Couldn’t create playlist';
          commit(state.filter((x) => x.id !== p.id));
          throw e;
        });
      pendingCreates.set(p.id, pending);
      pending.catch(() => {}).finally(() => pendingCreates.delete(p.id));
    }
    return p;
  },

  /** Follows a temporary id to the server id once the create has synced. */
  currentId: (id: string) => pendingIds.get(id) ?? id,

  rename(id: string, name: string) {
    const n = name.trim();
    if (!n) return;
    if (!shared()) return localUpdate(id, (p) => ({ ...p, name: n }));
    void sharedOp(id, (p) => ({ ...p, name: n }), 'rename', { name: n }).catch(() => {});
  },

  async remove(tempOrId: string) {
    if (!shared()) return commit(state.filter((p) => p.id !== tempOrId));
    const id = await resolveId(tempOrId);
    await api(`/playlists/${id}/delete`, {});
    commit(state.filter((p) => p.id !== id));
  },

  addTracks(id: string, tracks: Track[]) {
    const fresh = tracks.map((t) => ({ ...t, key: newKey(), addedBy: group.get()?.me.name }));
    const add = (p: Playlist) => ({ ...p, tracks: [...p.tracks, ...fresh] });
    if (!shared()) return localUpdate(id, add);
    // Strip per-listener fields before sending.
    const payload = tracks.map(({ key: _k, addedBy: _a, ...t }) => t);
    void sharedOp(id, add, 'add', { tracks: payload }).catch(() => {});
  },

  removeTrack(id: string, key: string) {
    const rm = (p: Playlist) => ({ ...p, tracks: p.tracks.filter((t) => t.key !== key) });
    if (!shared()) return localUpdate(id, rm);
    void sharedOp(id, rm, 'remove', { key }).catch(() => {});
  },

  moveTrack(id: string, from: number, to: number) {
    const mv = (p: Playlist) => {
      if (to < 0 || to >= p.tracks.length) return p;
      const tracks = [...p.tracks];
      const [t] = tracks.splice(from, 1);
      tracks.splice(to, 0, t);
      return { ...p, tracks };
    };
    if (!shared()) return localUpdate(id, mv);
    void sharedOp(id, mv, 'move', { from, to }).catch(() => {});
  },

  exportJson: (id: string) => {
    const p = state.find((x) => x.id === id);
    if (!p) return '';
    const tracks = p.tracks.map(({ addedBy: _a, ...t }) => t);
    return JSON.stringify({ setlist: 1, name: p.name, tracks }, null, 2);
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

const pendingIds = new Map<string, string>();
const pendingCreates = new Map<string, Promise<string>>();
/** Wait for a just-created playlist's server id, if it's still syncing. */
async function resolveId(id: string): Promise<string> {
  return pendingIds.get(id) ?? (await pendingCreates.get(id)) ?? id;
}

// Keep shared playlists fresh: on sign-in changes, every 20s while open, and on return.
group.subscribe(() => {
  loaded = !shared();
  void playlists.refresh();
});
if (typeof window !== 'undefined') {
  setInterval(() => {
    if (shared() && document.visibilityState === 'visible') void playlists.refresh();
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (shared() && document.visibilityState === 'visible') void playlists.refresh();
  });
  void playlists.refresh();
}

export function usePlaylists() {
  return useSyncExternalStore(playlists.subscribe, playlists.all);
}
