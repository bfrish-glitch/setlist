import { DurableObject } from 'cloudflare:workers';

/**
 * The friends group: members, invite link and shared playlists.
 *
 * One Durable Object instance holds everything in its own SQLite database.
 * Every request runs one at a time inside it, so two friends adding songs at
 * the same moment can't overwrite each other.
 */

interface Member {
  id: string;
  name: string;
  role: 'owner' | 'member';
}

interface TrackIn {
  key?: string;
  [k: string]: unknown;
}

const now = () => Date.now();
const rid = (bytes = 12) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const cleanName = (raw: unknown, max = 40) => {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  if (!s) throw new ApiError(400, 'Name required');
  return s;
};

export class Group extends DurableObject<Record<string, never>> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'normal', week TEXT, note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, position INTEGER NOT NULL,
        track TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_by_playlist ON items(playlist_id, position);
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');
    try {
      const body = req.method === 'POST' ? await req.json<Record<string, unknown>>().catch(() => ({})) : {};
      const data = await this.route(req.method, path, body as Record<string, unknown>, req);
      return Response.json(data);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      return Response.json({ error: e instanceof Error ? e.message : 'Server error' }, { status });
    }
  }

  private async route(method: string, path: string, body: Record<string, unknown>, req: Request) {
    // ---- open endpoints ----
    if (method === 'GET' && path === '/status') return { initialized: this.memberCount() > 0 };
    if (method === 'POST' && path === '/group/create') return this.createGroup(body);
    if (method === 'POST' && path === '/join') return this.join(body);

    // ---- everything else needs a member token ----
    const me = await this.auth(req);
    if (method === 'GET' && path === '/me') return this.meInfo(me);
    if (method === 'POST' && path === '/me/rename') {
      this.sql.exec('UPDATE members SET name = ? WHERE id = ?', cleanName(body.name), me.id);
      return this.meInfo({ ...me, name: cleanName(body.name) });
    }
    if (method === 'POST' && path === '/invite/rotate') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can reset the invite link');
      this.setMeta('invite', rid(10));
      return this.meInfo(me);
    }
    if (method === 'POST' && path === '/members/remove') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can remove people');
      if (body.id === me.id) throw new ApiError(400, 'You can’t remove yourself');
      this.sql.exec('DELETE FROM members WHERE id = ?', String(body.id));
      return this.meInfo(me);
    }

    if (method === 'GET' && path === '/playlists') return this.allPlaylists();
    if (method === 'POST' && path === '/playlists') return this.createPlaylist(me, body);

    const m = /^\/playlists\/([\w-]+)(?:\/(\w+))?$/.exec(path);
    if (m && method === 'POST') {
      const [, id, action] = m;
      this.mustExist(id);
      switch (action) {
        case 'rename':
          this.sql.exec('UPDATE playlists SET name = ? WHERE id = ?', cleanName(body.name, 80), id);
          break;
        case 'delete': {
          const p = this.sql.exec<{ created_by: string }>('SELECT created_by FROM playlists WHERE id = ?', id).one();
          if (me.role !== 'owner' && p.created_by !== me.id)
            throw new ApiError(403, 'Only whoever made this playlist can delete it');
          this.sql.exec('DELETE FROM items WHERE playlist_id = ?', id);
          this.sql.exec('DELETE FROM playlists WHERE id = ?', id);
          return { deleted: id };
        }
        case 'add':
          this.addItems(id, me, (body.tracks as TrackIn[]) ?? []);
          break;
        case 'remove':
          this.sql.exec('DELETE FROM items WHERE playlist_id = ? AND id = ?', id, String(body.key));
          this.renumber(id);
          break;
        case 'move':
          this.move(id, Number(body.from), Number(body.to));
          break;
        default:
          throw new ApiError(404, 'Unknown action');
      }
      this.touch(id);
      return this.playlist(id);
    }
    throw new ApiError(404, 'Not found');
  }

  /* ---- members ------------------------------------------------------ */

  private memberCount() {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM members').one().n;
  }
  private getMeta(key: string) {
    return this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }
  private setMeta(key: string, value: string) {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  private async addMember(name: string, role: Member['role']) {
    const token = rid(24);
    const id = rid(8);
    this.sql.exec(
      'INSERT INTO members (id, name, token_hash, role, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      name,
      await sha256(token),
      role,
      now(),
      now(),
    );
    return { token, member: { id, name, role } as Member };
  }

  /** First person in creates the group and becomes its owner. Closed after that. */
  private async createGroup(body: Record<string, unknown>) {
    if (this.memberCount() > 0) throw new ApiError(409, 'This group already exists. Ask for the invite link.');
    const name = cleanName(body.name);
    this.setMeta('invite', rid(10));
    const out = await this.addMember(name, 'owner');
    return { ...out, ...this.meInfo(out.member) };
  }

  private async join(body: Record<string, unknown>) {
    const invite = this.getMeta('invite');
    if (!invite || String(body.invite ?? '') !== invite)
      throw new ApiError(403, 'That invite link isn’t valid anymore. Ask for a new one.');
    const out = await this.addMember(cleanName(body.name), 'member');
    return { ...out, ...this.meInfo(out.member) };
  }

  private async auth(req: Request): Promise<Member> {
    const token = req.headers.get('X-Setlist-Token');
    if (!token) throw new ApiError(401, 'Not signed in to the group');
    const row = this.sql
      .exec<{ id: string; name: string; role: Member['role'] }>(
        'SELECT id, name, role FROM members WHERE token_hash = ?',
        await sha256(token),
      )
      .toArray()[0];
    if (!row) throw new ApiError(401, 'Your group sign-in was removed or expired');
    this.sql.exec('UPDATE members SET last_seen = ? WHERE id = ?', now(), row.id);
    return row;
  }

  private meInfo(me: Member) {
    const members = this.sql
      .exec<{ id: string; name: string; role: string; last_seen: number }>(
        'SELECT id, name, role, last_seen FROM members ORDER BY created_at',
      )
      .toArray()
      .map((r) => ({ id: r.id, name: r.name, role: r.role, lastSeen: r.last_seen }));
    return { me, members, invite: this.getMeta('invite') };
  }

  /* ---- playlists ---------------------------------------------------- */

  private memberNames() {
    const map = new Map<string, string>();
    for (const r of this.sql.exec<{ id: string; name: string }>('SELECT id, name FROM members')) map.set(r.id, r.name);
    return map;
  }

  private mustExist(id: string) {
    if (!this.sql.exec('SELECT 1 FROM playlists WHERE id = ?', id).toArray().length)
      throw new ApiError(404, 'That playlist was deleted');
  }

  private touch(id: string) {
    this.sql.exec('UPDATE playlists SET updated_at = ? WHERE id = ?', now(), id);
  }

  private addItems(id: string, me: Member, tracks: TrackIn[]) {
    if (!Array.isArray(tracks) || tracks.length > 500) throw new ApiError(400, 'Bad track list');
    let pos =
      this.sql.exec<{ p: number | null }>('SELECT MAX(position) AS p FROM items WHERE playlist_id = ?', id).one().p ?? -1;
    for (const t of tracks) {
      if (!t || typeof t !== 'object' || !t.title) continue;
      const key = rid(8);
      const json = JSON.stringify({ ...t, key, addedBy: undefined });
      if (json.length > 8000) continue;
      this.sql.exec(
        'INSERT INTO items (id, playlist_id, position, track, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)',
        key,
        id,
        ++pos,
        json,
        me.id,
        now(),
      );
    }
  }

  private renumber(id: string) {
    const rows = this.sql.exec<{ id: string }>('SELECT id FROM items WHERE playlist_id = ? ORDER BY position', id).toArray();
    rows.forEach((r, i) => this.sql.exec('UPDATE items SET position = ? WHERE id = ?', i, r.id));
  }

  private move(id: string, from: number, to: number) {
    const rows = this.sql.exec<{ id: string }>('SELECT id FROM items WHERE playlist_id = ? ORDER BY position', id).toArray();
    if (!(from >= 0 && from < rows.length && to >= 0 && to < rows.length)) return;
    const [r] = rows.splice(from, 1);
    rows.splice(to, 0, r);
    rows.forEach((row, i) => this.sql.exec('UPDATE items SET position = ? WHERE id = ?', i, row.id));
  }

  private createPlaylist(me: Member, body: Record<string, unknown>) {
    const id = rid(8);
    this.sql.exec(
      'INSERT INTO playlists (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      cleanName(body.name ?? 'Untitled', 80),
      me.id,
      Number(body.createdAt) || now(),
      now(),
    );
    if (Array.isArray(body.tracks)) this.addItems(id, me, body.tracks as TrackIn[]);
    return this.playlist(id);
  }

  private playlist(id: string, names = this.memberNames()) {
    const p = this.sql
      .exec<{ id: string; name: string; created_by: string; kind: string; week: string | null; note: string | null; created_at: number; updated_at: number }>(
        'SELECT * FROM playlists WHERE id = ?',
        id,
      )
      .one();
    const tracks = this.sql
      .exec<{ id: string; track: string; added_by: string; added_at: number }>(
        'SELECT id, track, added_by, added_at FROM items WHERE playlist_id = ? ORDER BY position',
        id,
      )
      .toArray()
      .map((r) => ({ ...JSON.parse(r.track), key: r.id, addedBy: names.get(r.added_by) ?? 'someone', addedAt: r.added_at }));
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      week: p.week,
      note: p.note,
      createdBy: names.get(p.created_by) ?? 'someone',
      createdById: p.created_by,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      tracks,
    };
  }

  private allPlaylists() {
    const names = this.memberNames();
    return this.sql
      .exec<{ id: string }>('SELECT id FROM playlists ORDER BY updated_at DESC')
      .toArray()
      .map((r) => this.playlist(r.id, names));
  }
}
