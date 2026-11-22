import { useSyncExternalStore } from 'react';
import { SERVER, appUrl } from '../config';

/**
 * The friends group: who you are, who else is in, and the invite link.
 * Your member token lives in this browser only.
 */

export interface Member {
  id: string;
  name: string;
  role: 'owner' | 'member';
  lastSeen?: number;
}

interface Session {
  token: string;
  me: Member;
  members: Member[];
  invite: string | null;
}

const KEY = 'setlist.group.v1';

let session: Session | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
})();

const listeners = new Set<() => void>();
function set(next: Session | null) {
  session = next;
  if (next) localStorage.setItem(KEY, JSON.stringify(next));
  else localStorage.removeItem(KEY);
  listeners.forEach((l) => l());
}

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${SERVER}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(session ? { 'X-Setlist-Token': session.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Can’t reach the Setlist server. Check your connection.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && session) set(null); // removed from the group, or token wiped
  if (!r.ok) throw new ApiError(j.error || `Server error ${r.status}`, r.status);
  return j as T;
}

type MeInfo = { me: Member; members: Member[]; invite: string | null };

export const group = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => session,
  signedIn: () => session !== null,

  inviteUrl() {
    return session?.invite ? `${appUrl()}#join=${session.invite}` : null;
  },

  status: () => api<{ initialized: boolean }>('/status'),

  async create(name: string) {
    const r = await api<MeInfo & { token: string }>('/group/create', { name });
    set({ token: r.token, me: r.me, members: r.members, invite: r.invite });
  },

  async join(invite: string, name: string) {
    const r = await api<MeInfo & { token: string }>('/join', { invite, name });
    set({ token: r.token, me: r.me, members: r.members, invite: r.invite });
  },

  async refresh() {
    if (!session) return;
    const r = await api<MeInfo>('/me');
    if (session) set({ ...session, ...r });
  },

  async rename(name: string) {
    const r = await api<MeInfo>('/me/rename', { name });
    if (session) set({ ...session, ...r });
  },

  async rotateInvite() {
    const r = await api<MeInfo>('/invite/rotate', {});
    if (session) set({ ...session, ...r });
  },

  async removeMember(id: string) {
    const r = await api<MeInfo>('/members/remove', { id });
    if (session) set({ ...session, ...r });
  },

  leave() {
    set(null);
  },
};

export function useGroup() {
  return useSyncExternalStore(group.subscribe, group.get);
}

/** Invite code from a link like …/setlist/#join=abc123, removed from the URL once read. */
export function takeInviteFromUrl(): string | null {
  const m = /[#&]join=([\w-]+)/.exec(window.location.hash);
  if (!m) return null;
  window.history.replaceState(null, '', appUrl());
  return m[1];
}
