import { api, group } from '../group/group';
import { playlists } from '../store/playlists';
import { player } from '../player/engine';
import type { Track } from '../types';

/** 🔥s, comments and "who's listened" on songs in shared playlists. */

type Social = NonNullable<Track['social']>;

export interface Comment {
  id: string;
  memberId: string;
  name: string;
  text: string;
  at: number;
}

export const EMPTY_SOCIAL: Social = { fire: [], listened: [], comments: 0 };

export async function toggleFire(t: Track) {
  const me = group.get()?.me.id;
  if (!me) return;
  // Flip it on screen right away; the server's answer replaces it.
  const cur = t.social ?? EMPTY_SOCIAL;
  const fire = cur.fire.includes(me) ? cur.fire.filter((x) => x !== me) : [...cur.fire, me];
  playlists.setSocial(t.key, { ...cur, fire });
  try {
    playlists.setSocial(t.key, await api<Social>(`/items/${t.key}/fire`, {}));
  } catch {
    playlists.setSocial(t.key, cur);
  }
}

export async function loadComments(key: string) {
  const r = await api<{ comments: Comment[]; social: Social }>(`/items/${key}/comments`);
  playlists.setSocial(key, r.social);
  return r.comments;
}

export async function addComment(key: string, text: string) {
  const r = await api<{ comments: Comment[]; social: Social }>(`/items/${key}/comments`, { text });
  playlists.setSocial(key, r.social);
  return r.comments;
}

export async function deleteComment(key: string, id: string) {
  const r = await api<{ comments: Comment[]; social: Social }>(`/comments/${id}/delete`, {});
  playlists.setSocial(key, r.social);
  return r.comments;
}

/** Member id → display name, for "Sam and Jess 🔥'd this". */
export function names(ids: string[]) {
  const all = group.get()?.members ?? [];
  const me = group.get()?.me.id;
  return ids.map((id) => (id === me ? 'you' : (all.find((m) => m.id === id)?.name ?? 'someone')));
}

/**
 * Mark a shared song as listened once someone has played 45 seconds of it
 * (or it ended). Runs for the whole app; reports each song once per session.
 */
const reported = new Set<string>();
export function startListenTracking() {
  let lastKey: string | null = null;
  return player.subscribe(() => {
    const s = player.get();
    const t = s.queue[s.index];
    if (!t) return;
    if (t.key !== lastKey) lastKey = t.key;
    const enough = s.positionSec >= 45 || (s.durationSec > 0 && s.durationSec < 60 && s.positionSec >= s.durationSec - 2);
    if (!enough || reported.has(t.key) || !group.signedIn() || !playlists.isSharedTrack(t.key)) return;
    reported.add(t.key);
    const me = group.get()!.me.id;
    if (t.social?.listened.includes(me)) return;
    void api<Social>(`/items/${t.key}/listened`, {}).then(
      (social) => playlists.setSocial(t.key, social),
      () => reported.delete(t.key),
    );
  });
}
