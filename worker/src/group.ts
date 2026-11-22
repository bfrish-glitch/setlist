import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_CONFIG,
  DEFAULT_PROMPT,
  DEFAULT_DISCOVERY,
  curate,
  discover,
  nextRunAt,
  upgradeConfig,
  type DiscoveryConfig,
  type WeeklyConfig,
} from './weekly';
import { candidatesText, gatherCandidates, normName, type Candidates } from './candidates';
import { generateVapid, sendPush, type VapidKeys } from './push';

type RunKind = 'weekly' | 'discovery' | 'test';

export interface GroupEnv {
  ANTHROPIC_API_KEY?: string;
  /** Only for local testing against a fake Claude. */
  ANTHROPIC_BASE_URL?: string;
}

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

export class Group extends DurableObject<GroupEnv> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: GroupEnv) {
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
      CREATE TABLE IF NOT EXISTS reactions (
        item_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (item_id, member_id, kind)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL, member_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comments_by_item ON comments(item_id, created_at);
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_codes (
        code TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, trigger TEXT NOT NULL, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, picks TEXT, raw TEXT, error TEXT,
        searches INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        claimed_by TEXT, claimed_at INTEGER, playlist_id TEXT, missed TEXT
      );
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY, member_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ref_shows (
        id TEXT PRIMARY KEY, artist TEXT NOT NULL, date TEXT NOT NULL, venue TEXT, rating INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS examples (
        id TEXT PRIMARY KEY, artist TEXT NOT NULL, date TEXT, venue TEXT, song TEXT,
        why TEXT, link TEXT, added_by TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  }

  private migrated = false;
  /** Columns added after the first release. */
  private migrate() {
    if (this.migrated) return;
    this.migrated = true;
    const cols = this.sql.exec<{ name: string }>('PRAGMA table_info(runs)').toArray().map((c) => c.name);
    if (!cols.includes('dropped')) this.sql.exec('ALTER TABLE runs ADD COLUMN dropped TEXT');
    if (!cols.includes('kind')) this.sql.exec("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'weekly'");
    if (!cols.includes('candidates')) this.sql.exec('ALTER TABLE runs ADD COLUMN candidates TEXT');
    if (!cols.includes('considered')) this.sql.exec('ALTER TABLE runs ADD COLUMN considered TEXT');
    if (!cols.includes('label')) this.sql.exec('ALTER TABLE runs ADD COLUMN label TEXT');
  }

  async fetch(req: Request): Promise<Response> {
    this.migrate();
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
    if (method === 'POST' && path === '/device/redeem') return this.redeemDevice(String(body.code ?? ''));

    // ---- everything else needs a member token ----
    const me = await this.auth(req);
    if (method === 'GET' && path === '/me') return this.meInfo(me);
    if (method === 'POST' && path === '/me/rename') {
      this.sql.exec('UPDATE members SET name = ? WHERE id = ?', cleanName(body.name), me.id);
      return this.meInfo({ ...me, name: cleanName(body.name) });
    }
    if (method === 'POST' && path === '/device/link') return this.deviceLink(me);
    if (method === 'POST' && path === '/invite/rotate') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can reset the invite link');
      this.setMeta('invite', rid(10));
      return this.meInfo(me);
    }
    if (method === 'POST' && path === '/members/remove') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can remove people');
      if (body.id === me.id) throw new ApiError(400, 'You can’t remove yourself');
      this.sql.exec('DELETE FROM members WHERE id = ?', String(body.id));
      this.sql.exec('DELETE FROM tokens WHERE member_id = ?', String(body.id));
      return this.meInfo(me);
    }

    if (method === 'GET' && path === '/weekly') return this.weeklyInfo(me);
    if (method === 'POST' && path === '/weekly/config') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can change the weekly picks');
      return this.saveConfig(body, me);
    }
    if (method === 'POST' && path === '/weekly/run') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can run the weekly picks');
      if (body.kind === 'test' && !this.refMeta()) throw new ApiError(400, 'Make a reference week first');
      return this.requestRun(me, body.kind === 'discovery' ? 'discovery' : body.kind === 'test' ? 'test' : 'weekly');
    }
    if (path.startsWith('/ref')) {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can use the reference week');
      if (method === 'GET' && path === '/ref') return this.refInfo();
      if (method === 'POST' && path === '/ref/create') return this.createRef();
      if (method === 'POST' && path === '/ref/rate') {
        const r = body.rating === null ? null : Number(body.rating);
        if (r !== null && ![0, 1, 2].includes(r)) throw new ApiError(400, 'Rating is 0, 1 or 2');
        this.sql.exec('UPDATE ref_shows SET rating = ? WHERE id = ?', r, String(body.id));
        return { ok: true };
      }
      if (method === 'POST' && path === '/ref/add') {
        const artist = typeof body.artist === 'string' ? body.artist.trim().slice(0, 100) : '';
        const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : '';
        if (!artist || !date) throw new ApiError(400, 'Need a band and a date (YYYY-MM-DD)');
        this.addRefShow(artist, date, typeof body.venue === 'string' ? body.venue.slice(0, 120) : null, 2);
        return this.refInfo();
      }
      if (method === 'POST' && path === '/ref/delete') {
        this.sql.exec('DELETE FROM ref_shows WHERE id = ?', String(body.id));
        return this.refInfo();
      }
      throw new ApiError(404, 'Not found');
    }
    if (method === 'POST' && path === '/weekly/missed') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can teach the weekly picks');
      return this.addExample(me, body);
    }
    if (method === 'POST' && path === '/weekly/examples/delete') {
      if (me.role !== 'owner') throw new ApiError(403, 'Only the group owner can change the weekly picks');
      this.sql.exec('DELETE FROM examples WHERE id = ?', String(body.id));
      return { ok: true, examples: this.examples() };
    }
    if (method === 'GET' && path === '/push/key') return { publicKey: (await this.vapid()).publicKey, subscribed: this.mySubs(me).length };
    if (method === 'POST' && path === '/push/subscribe') return this.subscribe(me, body);
    if (method === 'POST' && path === '/push/unsubscribe') {
      this.sql.exec('DELETE FROM push_subs WHERE endpoint = ? AND member_id = ?', String(body.endpoint ?? ''), me.id);
      return { ok: true };
    }
    if (method === 'POST' && path === '/push/test') {
      const sent = await this.notify({ title: 'Setlist notifications are on', body: 'You’ll get a ping when a new week goes up.', tag: 'test' }, { only: me.id });
      return { ok: true, sent };
    }
    if (method === 'GET' && path === '/weekly/pending') return this.pendingRun(me);
    if (method === 'POST' && path === '/weekly/claim') return this.claimRun(me, String(body.id));
    if (method === 'POST' && path === '/weekly/publish') return this.publishRun(me, body);

    // ---- reactions, comments, listens on a playlist song ----
    const item = /^\/items\/([\w-]+)\/(fire|listened|comments)$/.exec(path);
    if (item) {
      const [, itemId, what] = item;
      this.mustHaveItem(itemId);
      if (what === 'fire' && method === 'POST') {
        const had = this.sql.exec("SELECT 1 FROM reactions WHERE item_id = ? AND member_id = ? AND kind = 'fire'", itemId, me.id).toArray().length;
        if (had) this.sql.exec("DELETE FROM reactions WHERE item_id = ? AND member_id = ? AND kind = 'fire'", itemId, me.id);
        else this.sql.exec("INSERT INTO reactions (item_id, member_id, kind, created_at) VALUES (?, ?, 'fire', ?)", itemId, me.id, now());
        return this.social(itemId);
      }
      if (what === 'listened' && method === 'POST') {
        this.sql.exec(
          "INSERT OR IGNORE INTO reactions (item_id, member_id, kind, created_at) VALUES (?, ?, 'listened', ?)",
          itemId,
          me.id,
          now(),
        );
        return this.social(itemId);
      }
      if (what === 'comments' && method === 'GET') return this.commentsFor(itemId);
      if (what === 'comments' && method === 'POST') {
        const text = String(body.text ?? '').trim().replace(/\s+\n/g, '\n').slice(0, 500);
        if (!text) throw new ApiError(400, 'Say something first');
        this.sql.exec('INSERT INTO comments (id, item_id, member_id, text, created_at) VALUES (?, ?, ?, ?, ?)', rid(8), itemId, me.id, text, now());
        return this.commentsFor(itemId);
      }
    }
    const delComment = /^\/comments\/([\w-]+)\/delete$/.exec(path);
    if (delComment && method === 'POST') {
      const c = this.sql.exec<{ item_id: string; member_id: string }>('SELECT item_id, member_id FROM comments WHERE id = ?', delComment[1]).toArray()[0];
      if (!c) throw new ApiError(404, 'Comment already deleted');
      if (c.member_id !== me.id && me.role !== 'owner') throw new ApiError(403, 'You can only delete your own comments');
      this.sql.exec('DELETE FROM comments WHERE id = ?', delComment[1]);
      return this.commentsFor(c.item_id);
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
          for (const it of this.sql.exec<{ id: string }>('SELECT id FROM items WHERE playlist_id = ?', id).toArray()) {
            this.sql.exec('DELETE FROM reactions WHERE item_id = ?', it.id);
            this.sql.exec('DELETE FROM comments WHERE item_id = ?', it.id);
          }
          this.sql.exec('DELETE FROM items WHERE playlist_id = ?', id);
          this.sql.exec('DELETE FROM playlists WHERE id = ?', id);
          return { deleted: id };
        }
        case 'add':
          this.addItems(id, me, (body.tracks as TrackIn[]) ?? []);
          break;
        case 'remove':
          this.sql.exec('DELETE FROM items WHERE playlist_id = ? AND id = ?', id, String(body.key));
          this.sql.exec('DELETE FROM reactions WHERE item_id = ?', String(body.key));
          this.sql.exec('DELETE FROM comments WHERE item_id = ?', String(body.key));
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

  /** This group's VAPID signing key, made on first use. */
  private async vapid(): Promise<VapidKeys> {
    const saved = this.getMeta('vapid');
    if (saved) return JSON.parse(saved) as VapidKeys;
    const keys = await generateVapid();
    this.setMeta('vapid', JSON.stringify(keys));
    return keys;
  }

  private mySubs(me: Member) {
    return this.sql.exec<{ endpoint: string }>('SELECT endpoint FROM push_subs WHERE member_id = ?', me.id).toArray();
  }

  private subscribe(me: Member, body: Record<string, unknown>) {
    const endpoint = String(body.endpoint ?? '');
    const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
    if (!/^(https:\/\/|http:\/\/127\.0\.0\.1:)/.test(endpoint) || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string')
      throw new ApiError(400, 'That subscription looks wrong');
    this.sql.exec(
      'INSERT INTO push_subs (endpoint, member_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth',
      endpoint.slice(0, 1000),
      me.id,
      keys.p256dh.slice(0, 200),
      keys.auth.slice(0, 100),
      now(),
    );
    return { ok: true };
  }

  /** Push to every subscribed device (or one member's), dropping dead subscriptions. */
  private async notify(msg: { title: string; body: string; tag?: string; url?: string }, opts: { only?: string; except?: string } = {}) {
    const subs = this.sql
      .exec<{ endpoint: string; member_id: string; p256dh: string; auth: string }>('SELECT * FROM push_subs ORDER BY created_at DESC LIMIT 25')
      .toArray()
      .filter((x) => (!opts.only || x.member_id === opts.only) && x.member_id !== opts.except);
    if (!subs.length) return 0;
    const keys = await this.vapid();
    const results = await Promise.all(subs.map((x) => sendPush(x, { url: '/setlist/', ...msg }, keys)));
    results.forEach((r, i) => r === 'gone' && this.sql.exec('DELETE FROM push_subs WHERE endpoint = ?', subs[i].endpoint));
    return results.filter((r) => r === 'ok').length;
  }

  /** "This Week is up" text for a finished run. */
  private runMessage(kind: RunKind, picks: { artist: string }[]) {
    const bands = [...new Set(picks.map((p) => p.artist))];
    const list = bands.slice(0, 3).join(', ') + (bands.length > 3 ? ' & more' : '');
    return kind === 'discovery'
      ? { title: 'Side B: New to Your Radar', body: `${bands.length} new band${bands.length === 1 ? '' : 's'} to check out: ${list}`, tag: 'side-b' }
      : { title: 'This Week is up', body: `${picks.length} jam${picks.length === 1 ? '' : 's'}: ${list}`, tag: 'side-a' };
  }

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
    const hash = await sha256(token);
    const row = this.sql
      .exec<{ id: string; name: string; role: Member['role'] }>(
        `SELECT id, name, role FROM members WHERE token_hash = ?1
         OR id = (SELECT member_id FROM tokens WHERE token_hash = ?1)`,
        hash,
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

  /* ---- social: fires, listens, comments ------------------------------ */

  private mustHaveItem(id: string) {
    if (!this.sql.exec('SELECT 1 FROM items WHERE id = ?', id).toArray().length) throw new ApiError(404, 'That song was removed');
  }

  /** Who fired / listened to a song (member ids) and how many comments it has. */
  private social(itemId: string) {
    const rows = this.sql.exec<{ member_id: string; kind: string }>('SELECT member_id, kind FROM reactions WHERE item_id = ?', itemId).toArray();
    const comments = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE item_id = ?', itemId).one().n;
    return {
      fire: rows.filter((r) => r.kind === 'fire').map((r) => r.member_id),
      listened: rows.filter((r) => r.kind === 'listened').map((r) => r.member_id),
      comments,
    };
  }

  private commentsFor(itemId: string) {
    const names = this.memberNames();
    const list = this.sql
      .exec<{ id: string; member_id: string; text: string; created_at: number }>(
        'SELECT id, member_id, text, created_at FROM comments WHERE item_id = ? ORDER BY created_at',
        itemId,
      )
      .toArray()
      .map((c) => ({ id: c.id, memberId: c.member_id, name: names.get(c.member_id) ?? 'someone', text: c.text, at: c.created_at }));
    return { comments: list, social: this.social(itemId) };
  }

  /* ---- your other devices ------------------------------------------- */

  /** A one-time code (good for 15 minutes) that signs another device in as you. */
  private deviceLink(me: Member) {
    this.sql.exec('DELETE FROM device_codes WHERE expires_at < ?', now());
    const code = rid(12);
    this.sql.exec('INSERT INTO device_codes (code, member_id, expires_at) VALUES (?, ?, ?)', code, me.id, now() + 15 * 60000);
    return { code, expiresAt: now() + 15 * 60000 };
  }

  private async redeemDevice(code: string) {
    const row = this.sql
      .exec<{ member_id: string; expires_at: number }>('SELECT member_id, expires_at FROM device_codes WHERE code = ?', code)
      .toArray()[0];
    this.sql.exec('DELETE FROM device_codes WHERE code = ?', code); // one use only
    if (!row || row.expires_at < now()) throw new ApiError(403, 'That device link expired or was already used. Make a new one.');
    const member = this.sql
      .exec<{ id: string; name: string; role: Member['role'] }>('SELECT id, name, role FROM members WHERE id = ?', row.member_id)
      .toArray()[0];
    if (!member) throw new ApiError(403, 'That member was removed from the group');
    const token = rid(24);
    this.sql.exec('INSERT INTO tokens (token_hash, member_id, created_at) VALUES (?, ?, ?)', await sha256(token), member.id, now());
    return { token, ...this.meInfo(member) };
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
      const json = JSON.stringify({ ...t, key, addedBy: undefined, social: undefined, addedAt: undefined });
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
      'INSERT INTO playlists (id, name, created_by, kind, week, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      cleanName(body.name ?? 'Untitled', 80),
      me.id,
      body.kind === 'weekly' ? 'weekly' : 'normal',
      typeof body.week === 'string' ? body.week.slice(0, 10) : null,
      typeof body.note === 'string' ? body.note.slice(0, 500) : null,
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
      .map((r) => ({
        ...JSON.parse(r.track),
        key: r.id,
        addedBy: names.get(r.added_by) ?? 'someone',
        addedAt: r.added_at,
        social: this.social(r.id),
      }));
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

  /* ---- weekly picks: Side A (jams, Mondays) + Side B (new bands, Thursdays) ---- */

  private config(): WeeklyConfig {
    const raw = this.getMeta('weekly_config');
    if (!raw) return DEFAULT_CONFIG;
    try {
      return upgradeConfig(JSON.parse(raw));
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  private discoveryConfig(): DiscoveryConfig {
    const raw = this.getMeta('discovery_config');
    if (!raw) return DEFAULT_DISCOVERY;
    try {
      return { ...DEFAULT_DISCOVERY, ...JSON.parse(raw) };
    } catch {
      return DEFAULT_DISCOVERY;
    }
  }

  private cfgFor(kind: RunKind) {
    return kind === 'discovery' ? this.discoveryConfig() : this.config();
  }

  // ---- reference week: a frozen week you rate once, for scoring prompt changes ----

  private refMeta(): { today: number; createdAt: number; fromRun: string; candidates: string } | null {
    const m = this.getMeta('ref');
    return m ? JSON.parse(m) : null;
  }

  private addRefShow(artist: string, date: string, venue: string | null, rating: number | null = null) {
    const key = normName(artist);
    const dup = this.sql
      .exec<{ id: string; artist: string; rating: number | null }>('SELECT id, artist, rating FROM ref_shows WHERE date = ?', date)
      .toArray()
      .find((r) => normName(r.artist) === key);
    if (dup) {
      if (rating != null && dup.rating == null) this.sql.exec('UPDATE ref_shows SET rating = ? WHERE id = ?', rating, dup.id);
      return;
    }
    this.sql.exec('INSERT INTO ref_shows (id, artist, date, venue, rating, created_at) VALUES (?, ?, ?, ?, ?, ?)', rid(8), artist, date, venue, rating, now());
  }

  private refInfo() {
    const ref = this.refMeta();
    const shows = this.sql
      .exec<Record<string, any>>('SELECT * FROM ref_shows ORDER BY date DESC, artist')
      .toArray()
      .map((r) => ({ id: r.id, artist: r.artist, date: r.date, venue: r.venue, rating: r.rating ?? null }));
    const tests = this.sql
      .exec<Record<string, any>>("SELECT * FROM runs WHERE kind = 'test' ORDER BY started_at DESC LIMIT 10")
      .toArray()
      .map((r) => ({ ...this.runRow(r), label: r.label ?? null }));
    return { ref: ref ? { today: ref.today, createdAt: ref.createdAt } : null, shows, tests, running: !!this.runningRun() };
  }

  /** Freeze the latest run's candidate list and every show the runs considered. */
  private createRef() {
    const run = this.sql
      .exec<Record<string, any>>("SELECT * FROM runs WHERE kind = 'weekly' AND candidates IS NOT NULL ORDER BY started_at DESC LIMIT 1")
      .toArray()[0];
    if (!run) throw new ApiError(400, 'Run Side A once first, so there’s a candidate list to freeze');
    const cands = JSON.parse(run.candidates) as Candidates;
    const today = Number(run.started_at);
    const end = new Date(today).toISOString().slice(0, 10);
    const windowStart = new Date(today - (this.config().windowDays + 1) * 864e5).toISOString().slice(0, 10);
    const inWindow = (d: string | null | undefined): d is string => !!d && d >= windowStart && d <= end;
    this.sql.exec('DELETE FROM ref_shows');
    this.setMeta('ref', JSON.stringify({ today, createdAt: now(), fromRun: run.id, candidates: candidatesText(cands) }));
    const runs = this.sql
      .exec<Record<string, any>>("SELECT picks, considered FROM runs WHERE kind = 'weekly' AND started_at > ? ORDER BY started_at DESC LIMIT 20", today - 2 * 864e5)
      .toArray();
    // Shows you added by hand were musts by definition.
    for (const e of this.examples()) if (inWindow(e.date)) this.addRefShow(e.artist, e.date, e.venue, 2);
    for (const r of runs) {
      for (const p of (r.picks ? JSON.parse(r.picks) : []) as { artist: string; date: string | null; venue?: string | null }[])
        if (inWindow(p.date)) this.addRefShow(p.artist, p.date, p.venue ?? null);
      for (const c of (r.considered ? JSON.parse(r.considered) : []) as { artist: string; date: string | null }[])
        if (inWindow(c.date) && !c.artist.includes('/')) this.addRefShow(c.artist, c.date, null);
    }
    for (const sh of cands.shows) if (inWindow(sh.date)) this.addRefShow(sh.artist, sh.date, sh.venue || null);
    return this.refInfo();
  }

  private nextFor(kind: RunKind, from = Date.now()) {
    if (kind === 'test') return null;
    const c = this.cfgFor(kind);
    return c.enabled ? nextRunAt(c, from) : null;
  }

  private requested(): RunKind[] {
    return (this.getMeta('run_requested') ?? '').split(',').filter((k): k is RunKind => k === 'weekly' || k === 'discovery' || k === 'test');
  }

  /** One alarm drives both schedules and any "Run now": set it to whichever comes first. */
  private async schedule() {
    if (this.runningRun()) return; // the alarm handler reschedules when it finishes
    const times = [this.requested().length ? Date.now() + 500 : null, this.nextFor('weekly'), this.nextFor('discovery')].filter(
      (t): t is number => t != null,
    );
    if (!times.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const want = Math.min(...times);
    const have = await this.ctx.storage.getAlarm();
    if (have == null || Math.abs(have - want) > 60000) await this.ctx.storage.setAlarm(want);
  }

  private runningRun() {
    return this.sql
      .exec<{ id: string; started_at: number }>("SELECT id, started_at FROM runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
      .toArray()
      .find((r) => now() - r.started_at < 20 * 60000); // a run stuck >20 min counts as dead
  }

  private runRow(r: Record<string, any>, full = false) {
    return {
      id: r.id,
      kind: (r.kind ?? 'weekly') as RunKind,
      trigger: r.trigger,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      picks: r.picks ? JSON.parse(r.picks) : [],
      error: r.error,
      searches: r.searches,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      playlistId: r.playlist_id,
      missed: r.missed ? JSON.parse(r.missed) : [],
      dropped: r.dropped ? JSON.parse(r.dropped) : [],
      considered: r.considered ? JSON.parse(r.considered) : [],
      ...(full ? { raw: r.raw, candidates: r.candidates ? JSON.parse(r.candidates) : null } : {}),
    };
  }

  private async weeklyInfo(me: Member) {
    await this.schedule();
    const cfg = this.config();
    const disc = this.discoveryConfig();
    const owner = me.role === 'owner';
    const runs = this.sql
      .exec<Record<string, any>>("SELECT * FROM runs WHERE kind != 'test' ORDER BY started_at DESC LIMIT 10")
      .toArray()
      .map((r) => this.runRow(r, owner));
    return {
      config: owner ? cfg : { ...cfg, prompt: undefined },
      discovery: owner ? disc : { ...disc, prompt: undefined },
      nextRun: this.nextFor('weekly'),
      nextDiscovery: this.nextFor('discovery'),
      hasKey: !!this.env.ANTHROPIC_API_KEY,
      runs,
      ...(owner ? { examples: this.examples() } : {}),
    };
  }

  /** Shows the owner said a run missed. They calibrate future prompts. */
  private examples() {
    return this.sql
      .exec<Record<string, any>>('SELECT * FROM examples ORDER BY created_at DESC LIMIT 40')
      .toArray()
      .map((r) => ({ id: r.id, artist: r.artist, date: r.date, venue: r.venue, song: r.song, why: r.why, link: r.link, createdAt: r.created_at }));
  }

  private addExample(me: Member, body: Record<string, unknown>) {
    const str = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    const artist = str(body.artist, 100);
    if (!artist) throw new ApiError(400, 'Which band?');
    const date = str(body.date, 10);
    this.sql.exec(
      'INSERT INTO examples (id, artist, date, venue, song, why, link, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      rid(8),
      artist,
      date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      str(body.venue, 120),
      str(body.song, 120),
      str(body.why, 400),
      str(body.link, 400),
      me.id,
      now(),
    );
    return { ok: true, examples: this.examples() };
  }

  private async saveConfig(body: Record<string, unknown>, me: Member) {
    const num = (v: unknown, lo: number, hi: number, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
    };
    const prompt = (cur: string) => (typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.slice(0, 8000) : cur);
    const model = (cur: string) => (typeof body.model === 'string' && /^claude-[\w.-]+$/.test(body.model) ? body.model : cur);

    if (body.kind === 'discovery') {
      const cur = this.discoveryConfig();
      const next: DiscoveryConfig = {
        ...cur,
        enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
        day: num(body.day ?? cur.day, 0, 6, cur.day),
        hour: num(body.hour ?? cur.hour, 0, 23, cur.hour),
        bands: num(body.bands ?? cur.bands, 1, 3, cur.bands),
        songsPerBand: num(body.songsPerBand ?? cur.songsPerBand, 1, 5, cur.songsPerBand),
        autoPublish: body.autoPublish === undefined ? cur.autoPublish : !!body.autoPublish,
        prompt: body.resetPrompt ? DEFAULT_DISCOVERY.prompt : prompt(cur.prompt),
        model: model(cur.model),
      };
      this.setMeta('discovery_config', JSON.stringify(next));
    } else {
      const cur = this.config();
      const list = (v: unknown, d: string[]) =>
        Array.isArray(v) ? (v as unknown[]).map((b) => String(b).trim()).filter(Boolean).slice(0, 30) : d;
      const limits = (v: unknown, d: Record<string, number>) => {
        if (!v || typeof v !== 'object') return d;
        const out: Record<string, number> = {};
        for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
          const name = String(k).trim().slice(0, 60);
          if (name) out[name] = num(n, 0, 5, 1);
        }
        return out;
      };
      const next: WeeklyConfig = {
        ...cur,
        enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
        day: num(body.day ?? cur.day, 0, 6, cur.day),
        hour: num(body.hour ?? cur.hour, 0, 23, cur.hour),
        watchlist: list(body.watchlist, cur.watchlist),
        picks: num(body.picks ?? cur.picks, 3, 15, cur.picks),
        maxPerBand: num(body.maxPerBand ?? cur.maxPerBand, 1, 3, cur.maxPerBand),
        bandLimits: limits(body.bandLimits, cur.bandLimits),
        windowDays: num(body.windowDays ?? cur.windowDays, 3, 60, cur.windowDays),
        newArtists: num(body.newArtists ?? cur.newArtists, 0, 3, cur.newArtists),
        autoPublish: body.autoPublish === undefined ? cur.autoPublish : !!body.autoPublish,
        prompt: body.resetPrompt ? DEFAULT_CONFIG.prompt : prompt(cur.prompt),
        model: model(cur.model),
      };
      this.setMeta('weekly_config', JSON.stringify(next));
    }
    await this.ctx.storage.deleteAlarm();
    await this.schedule();
    return this.weeklyInfo(me);
  }

  private async requestRun(me: Member, kind: RunKind) {
    if (!this.env.ANTHROPIC_API_KEY) throw new ApiError(400, 'No Anthropic API key on the server yet');
    if (this.runningRun()) throw new ApiError(409, 'A run is already going. Give it a few minutes.');
    const req = new Set(this.requested());
    req.add(kind);
    this.setMeta('run_requested', [...req].join(','));
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return this.weeklyInfo(me);
  }

  /** The alarm: runs whatever is due (scheduled or "Run now"), then sets the next alarm. */
  async alarm() {
    this.migrate();
    const manual = this.requested();
    this.sql.exec("DELETE FROM meta WHERE key = 'run_requested'");
    const due = new Set<RunKind>(manual);
    // A scheduled time that came due in the last 10 minutes.
    for (const k of ['weekly', 'discovery'] as RunKind[]) {
      const t = this.nextFor(k, Date.now() - 10 * 60000);
      if (t != null && t <= Date.now() + 60000) due.add(k);
    }
    if (this.env.ANTHROPIC_API_KEY && !this.runningRun()) {
      for (const k of due) await this.runOne(k, manual.includes(k) ? 'manual' : 'weekly');
    }
    await this.schedule();
  }

  private async runOne(kind: RunKind, trigger: string) {
    const id = rid(8);
    this.sql.exec("INSERT INTO runs (id, kind, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)", id, kind, trigger, now());
    try {
      const past = this.sql
        // Only earlier weeks count as "already featured". Re-runs this week (and unpublished runs) don't.
        .exec<{ picks: string }>(
          "SELECT picks FROM runs WHERE picks IS NOT NULL AND kind = ? AND status = 'published' AND started_at < ? ORDER BY started_at DESC LIMIT 6",
          kind,
          now() - 4 * 864e5,
        )
        .toArray()
        .flatMap((r) => JSON.parse(r.picks) as { artist: string; date: string | null }[]);
      const base = this.env.ANTHROPIC_BASE_URL || undefined;
      let cands: Candidates | null = null;
      if (kind === 'weekly') {
        // Step 1: gather every candidate show with plain code, so Claude judges instead of hunting.
        const cfg = this.config();
        cands = await gatherCandidates(cfg.watchlist, cfg.windowDays).catch(() => null);
        if (cands) this.sql.exec('UPDATE runs SET candidates = ? WHERE id = ?', JSON.stringify(cands), id);
      }
      if (kind === 'test') {
        // Replay the frozen reference week with today's prompt. Never published, never notifies.
        const ref = this.refMeta();
        if (!ref) throw new Error('No reference week');
        const cfg = this.config();
        const end = new Date(ref.today).toISOString().slice(0, 10);
        const start = new Date(ref.today - (cfg.windowDays + 1) * 864e5).toISOString().slice(0, 10);
        // Hand-added shows from that same week would hand it the answers.
        const examples = this.examples().filter((e) => !e.date || e.date < start || e.date > end).slice(0, 12);
        const custom = cfg.prompt !== DEFAULT_PROMPT;
        this.sql.exec('UPDATE runs SET label = ? WHERE id = ?', custom ? `custom prompt (v${cfg.promptVersion})` : `prompt v${cfg.promptVersion}`, id);
        const t = await curate(this.env.ANTHROPIC_API_KEY!, cfg, [], base, ref.candidates, examples, ref.today);
        this.sql.exec(
          "UPDATE runs SET status = 'ready', finished_at = ?, picks = ?, dropped = ?, considered = ?, raw = ?, searches = ?, input_tokens = ?, output_tokens = ? WHERE id = ?",
          now(),
          JSON.stringify(t.picks),
          JSON.stringify(t.dropped),
          JSON.stringify(t.considered ?? []),
          t.raw,
          t.searches,
          t.inputTokens,
          t.outputTokens,
          id,
        );
        return;
      }
      const res =
        kind === 'discovery'
          ? await discover(this.env.ANTHROPIC_API_KEY!, this.discoveryConfig(), this.config().watchlist, [...new Set(past.map((p) => p.artist))], base)
          : await curate(
              this.env.ANTHROPIC_API_KEY!,
              this.config(),
              [
                ...new Set([
                  ...past.filter((p) => p.date).map((p) => `${p.artist} ${p.date}`),
                  // Missed shows added in earlier weeks are already in a playlist too.
                  ...this.examples()
                    .filter((e) => e.date && e.createdAt < now() - 4 * 864e5)
                    .map((e) => `${e.artist} ${e.date}`),
                ]),
              ],
              base,
              cands ? candidatesText(cands) : '',
              this.examples().slice(0, 12),
            );
      if (res.considered) this.sql.exec('UPDATE runs SET considered = ? WHERE id = ?', JSON.stringify(res.considered), id);
      this.sql.exec(
        "UPDATE runs SET status = 'ready', finished_at = ?, picks = ?, dropped = ?, raw = ?, searches = ?, input_tokens = ?, output_tokens = ? WHERE id = ?",
        now(),
        JSON.stringify(res.picks),
        JSON.stringify(res.dropped),
        res.raw,
        res.searches,
        res.inputTokens,
        res.outputTokens,
        id,
      );
      // Scheduled runs that publish themselves ping everyone now; tapping the
      // notification opens the app, which builds the playlist. Manual test runs stay quiet.
      if (trigger === 'weekly' && this.cfgFor(kind).autoPublish && res.picks.length)
        await this.notify(this.runMessage(kind, res.picks)).catch(() => 0);
    } catch (e) {
      this.sql.exec(
        "UPDATE runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
        now(),
        e instanceof Error ? e.message.slice(0, 500) : 'Run failed',
        id,
      );
    }
  }

  /** Finished runs that haven't become playlists yet: the newest per side. */
  private pendingRun(me: Member) {
    const runs = (['weekly', 'discovery'] as RunKind[])
      .map((k) => this.sql.exec<Record<string, any>>("SELECT * FROM runs WHERE status = 'ready' AND kind = ? ORDER BY started_at DESC LIMIT 1", k).toArray()[0])
      .filter(Boolean)
      .map((r) => ({ ...this.runRow(r), autoPublish: this.cfgFor((r.kind ?? 'weekly') as RunKind).autoPublish }));
    const first = runs[0];
    return {
      runs,
      // older clients read these two
      run: first ?? null,
      autoPublish: first?.autoPublish,
      isOwner: me.role === 'owner',
    };
  }

  /** One phone at a time turns a run into the playlist. A claim expires after 10 minutes. */
  private claimRun(me: Member, id: string) {
    const r = this.sql.exec<Record<string, any>>("SELECT * FROM runs WHERE id = ? AND status = 'ready'", id).toArray()[0];
    if (!r) return { ok: false };
    if (!this.cfgFor((r.kind ?? 'weekly') as RunKind).autoPublish && me.role !== 'owner') return { ok: false };
    if (r.claimed_by && r.claimed_by !== me.id && now() - Number(r.claimed_at) < 10 * 60000) return { ok: false };
    this.sql.exec('UPDATE runs SET claimed_by = ?, claimed_at = ? WHERE id = ?', me.id, now(), id);
    return { ok: true };
  }

  private async publishRun(me: Member, body: Record<string, unknown>) {
    const id = String(body.id);
    const r = this.sql.exec<Record<string, any>>("SELECT * FROM runs WHERE id = ? AND status = 'ready'", id).toArray()[0];
    if (!r) throw new ApiError(404, 'That run was already published');
    if (r.claimed_by && r.claimed_by !== me.id && me.role !== 'owner') throw new ApiError(409, 'Someone else is publishing this week');
    this.sql.exec(
      "UPDATE runs SET status = 'published', playlist_id = ?, missed = ? WHERE id = ?",
      String(body.playlistId ?? ''),
      JSON.stringify(Array.isArray(body.missed) ? body.missed.slice(0, 20) : []),
      id,
    );
    // A scheduled run the owner reviewed by hand: tell everyone else once it's out.
    const kind = (r.kind ?? 'weekly') as RunKind;
    if (r.trigger === 'weekly' && !this.cfgFor(kind).autoPublish)
      await this.notify(this.runMessage(kind, r.picks ? JSON.parse(r.picks) : []), { except: me.id }).catch(() => 0);
    return { ok: true };
  }
}
