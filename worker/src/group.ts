import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_CONFIG, curate, nextRunAt, type WeeklyConfig } from './weekly';

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
      return this.requestRun(me);
    }
    if (method === 'GET' && path === '/weekly/pending') return this.pendingRun(me);
    if (method === 'POST' && path === '/weekly/claim') return this.claimRun(me, String(body.id));
    if (method === 'POST' && path === '/weekly/publish') return this.publishRun(me, body);

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

  /* ---- weekly picks ------------------------------------------------- */

  private config(): WeeklyConfig {
    const raw = this.getMeta('weekly_config');
    if (!raw) return DEFAULT_CONFIG;
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  /** Make sure the weekly alarm is set (or cleared) to match the config. */
  private async schedule() {
    const cfg = this.config();
    if (this.runningRun()) return; // the alarm handler reschedules when it finishes
    if (!cfg.enabled) {
      if (!this.getMeta('run_requested')) await this.ctx.storage.deleteAlarm();
      return;
    }
    const want = nextRunAt(cfg);
    const have = await this.ctx.storage.getAlarm();
    if (have == null || (!this.getMeta('run_requested') && Math.abs(have - want) > 60000)) await this.ctx.storage.setAlarm(want);
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
      ...(full ? { raw: r.raw } : {}),
    };
  }

  private async weeklyInfo(me: Member) {
    await this.schedule();
    const cfg = this.config();
    const runs = this.sql
      .exec<Record<string, any>>('SELECT * FROM runs ORDER BY started_at DESC LIMIT 6')
      .toArray()
      .map((r) => this.runRow(r, me.role === 'owner'));
    return {
      config: me.role === 'owner' ? cfg : { ...cfg, prompt: undefined },
      nextRun: cfg.enabled ? nextRunAt(cfg) : null,
      hasKey: !!this.env.ANTHROPIC_API_KEY,
      runs,
    };
  }

  private async saveConfig(body: Record<string, unknown>, me: Member) {
    const cur = this.config();
    const num = (v: unknown, lo: number, hi: number, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
    };
    const next: WeeklyConfig = {
      enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
      day: num(body.day ?? cur.day, 0, 6, cur.day),
      hour: num(body.hour ?? cur.hour, 0, 23, cur.hour),
      bands: Array.isArray(body.bands)
        ? (body.bands as unknown[]).map((b) => String(b).trim()).filter(Boolean).slice(0, 10)
        : cur.bands,
      showsPerBand: num(body.showsPerBand ?? cur.showsPerBand, 1, 3, cur.showsPerBand),
      newArtists: num(body.newArtists ?? cur.newArtists, 0, 5, cur.newArtists),
      autoPublish: body.autoPublish === undefined ? cur.autoPublish : !!body.autoPublish,
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.slice(0, 8000) : cur.prompt,
      model: typeof body.model === 'string' && /^claude-[\w.-]+$/.test(body.model) ? body.model : cur.model,
    };
    if (body.resetPrompt) next.prompt = DEFAULT_CONFIG.prompt;
    this.setMeta('weekly_config', JSON.stringify(next));
    await this.ctx.storage.deleteAlarm();
    await this.schedule();
    return this.weeklyInfo(me);
  }

  private async requestRun(me: Member) {
    if (!this.env.ANTHROPIC_API_KEY) throw new ApiError(400, 'No Anthropic API key on the server yet');
    if (this.runningRun()) throw new ApiError(409, 'A run is already going. Give it a few minutes.');
    this.setMeta('run_requested', 'manual');
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return this.weeklyInfo(me);
  }

  /** The alarm: either the weekly schedule or a "Run now". */
  async alarm() {
    const trigger = this.getMeta('run_requested') ? 'manual' : 'weekly';
    this.sql.exec("DELETE FROM meta WHERE key = 'run_requested'");
    const cfg = this.config();
    if ((trigger === 'weekly' && !cfg.enabled) || !this.env.ANTHROPIC_API_KEY || this.runningRun()) {
      await this.schedule();
      return;
    }
    const id = rid(8);
    this.sql.exec("INSERT INTO runs (id, trigger, status, started_at) VALUES (?, ?, 'running', ?)", id, trigger, now());
    try {
      // Shows already picked in earlier weeks, so the list doesn't repeat itself.
      const already = new Set<string>();
      for (const r of this.sql.exec<{ picks: string }>("SELECT picks FROM runs WHERE picks IS NOT NULL ORDER BY started_at DESC LIMIT 8")) {
        for (const p of JSON.parse(r.picks) as { artist: string; date: string | null }[])
          if (p.date) already.add(`${p.artist} ${p.date}`);
      }
      const res = await curate(this.env.ANTHROPIC_API_KEY, cfg, [...already], this.env.ANTHROPIC_BASE_URL || undefined);
      this.sql.exec(
        "UPDATE runs SET status = 'ready', finished_at = ?, picks = ?, raw = ?, searches = ?, input_tokens = ?, output_tokens = ? WHERE id = ?",
        now(),
        JSON.stringify(res.picks),
        res.raw,
        res.searches,
        res.inputTokens,
        res.outputTokens,
        id,
      );
    } catch (e) {
      this.sql.exec(
        "UPDATE runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
        now(),
        e instanceof Error ? e.message.slice(0, 500) : 'Run failed',
        id,
      );
    }
    await this.schedule();
  }

  /** The newest finished run that hasn't become a playlist yet. */
  private pendingRun(me: Member) {
    const r = this.sql
      .exec<Record<string, any>>("SELECT * FROM runs WHERE status = 'ready' ORDER BY started_at DESC LIMIT 1")
      .toArray()[0];
    if (!r) return { run: null };
    const cfg = this.config();
    return { run: this.runRow(r), autoPublish: cfg.autoPublish, canPublish: cfg.autoPublish || me.role === 'owner' };
  }

  /** One phone at a time turns a run into the playlist. A claim expires after 10 minutes. */
  private claimRun(me: Member, id: string) {
    const cfg = this.config();
    if (!cfg.autoPublish && me.role !== 'owner') return { ok: false };
    const r = this.sql.exec<Record<string, any>>("SELECT * FROM runs WHERE id = ? AND status = 'ready'", id).toArray()[0];
    if (!r) return { ok: false };
    if (r.claimed_by && r.claimed_by !== me.id && now() - Number(r.claimed_at) < 10 * 60000) return { ok: false };
    this.sql.exec('UPDATE runs SET claimed_by = ?, claimed_at = ? WHERE id = ?', me.id, now(), id);
    return { ok: true };
  }

  private publishRun(me: Member, body: Record<string, unknown>) {
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
    return { ok: true };
  }
}
