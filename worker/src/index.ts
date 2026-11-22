/**
 * Setlist nugs.net relay (Cloudflare Worker).
 *
 * nugs.net has no public API and its servers don't allow calls from web
 * pages, so the Setlist web app talks to this relay instead. It is stateless:
 * it stores nothing. Each person's nugs tokens live in their own browser and
 * ride along on every request.
 *
 * Endpoints are modeled on how the official nugs Android app talks to nugs,
 * as documented by open-source projects (e.g. orpheusdl-nugs). Expect to fix
 * this file when nugs changes their app.
 */

export { Group } from './group';

interface Env {
  GROUP: DurableObjectNamespace;
  ANTHROPIC_API_KEY?: string;
}

const AUTH = 'https://id.nugs.net';
const API = 'https://streamapi.nugs.net';
const SUBS = 'https://subscriptions.nugs.net/api/v1/me/subscriptions/';
const CLIENT_ID = 'Eg7HuH873H65r5rt325UytR5429';
const SCOPE = 'roles email profile openid nugsnet:api nugsnet:legacyapi offline_access';
const APP_UA = 'NugsNet/3.16.1.682 (Android; 12; Google; Pixel 6)';
const WEB_UA =
  'Mozilla/5.0 (Linux; Android 12; Google Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

const ALLOWED_ORIGINS = [
  'https://bfrish-glitch.github.io',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
];

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin') ?? '';
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Setlist-Token',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // Only the Setlist site may use this relay.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Origin not allowed' }, 403);

    const url = new URL(req.url);

    // Group + shared playlists live in a single Durable Object.
    if (url.pathname.startsWith('/api/')) {
      const stub = env.GROUP.get(env.GROUP.idFromName('main'));
      const r = await stub.fetch(req);
      const out = new Response(r.body, r);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }

    try {
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /':
        case 'GET /health':
          return json({ ok: true, service: 'setlist-nugs' });
        case 'POST /nugs/login':
          return json(await login(await req.json()));
        case 'POST /nugs/refresh':
          return json(await refresh(await req.json()));
        case 'GET /nugs/me':
          return json(await me(bearer(req)));
        case 'GET /nugs/search':
          return json(await search(bearer(req), url.searchParams.get('q') ?? ''));
        case 'GET /nugs/find':
          return json(await findShow(bearer(req), need(url, 'artist'), need(url, 'date')));
        case 'GET /nugs/artist':
          return json(await artistShows(bearer(req), need(url, 'id'), Number(url.searchParams.get('offset') ?? 1)));
        case 'GET /nugs/show':
          return json(await show(bearer(req), need(url, 'id')));
        case 'GET /resolve/youtube':
          return json(await youtubeMeta(need(url, 'id')));
        case 'GET /resolve/archive':
          return json(await cached(req, () => archiveItem(need(url, 'id'))));
        case 'GET /resolve/archive-search':
          return json(await cached(req, () => archiveSearch(url.searchParams)));
        case 'GET /resolve/gizztapes':
          return json(await cached(req, () => gizzTapes(need(url, 'date'))));
        case 'GET /nugs/stream':
          return json(await stream(bearer(req), url.searchParams));
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      return json({ error: e instanceof Error ? e.message : 'Relay error' }, 502);
    }
  },
};

/* ------------------------------------------------------------------ */

function bearer(req: Request) {
  const h = req.headers.get('Authorization') ?? '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in to nugs');
  return h.slice(7);
}

function need(url: URL, key: string) {
  const v = url.searchParams.get(key);
  if (!v) throw new HttpError(400, `Missing ${key}`);
  return v;
}

interface TokenOut {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenCall(body: Record<string, string>): Promise<TokenOut> {
  const r = await fetch(`${AUTH}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': WEB_UA },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const text = await r.text();
  let j: Record<string, string> = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  if (!r.ok) {
    const err = j.error ?? '';
    if (err === 'invalid_grant') throw new HttpError(401, 'Wrong email or password', 'invalid_grant');
    if (err === 'unsupported_grant_type' || err === 'unauthorized_client')
      throw new HttpError(400, 'nugs has turned off password sign-in for this app', 'password_grant_disabled');
    throw new HttpError(r.status === 400 ? 400 : 502, j.error_description || err || `nugs sign-in failed (${r.status})`, err);
  }
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: Number(j.expires_in ?? 3600) };
}

async function login(body: { email?: string; password?: string }) {
  if (!body.email || !body.password) throw new HttpError(400, 'Email and password required');
  // The password passes through to nugs and is never stored or logged here.
  return tokenCall({ grant_type: 'password', username: body.email, password: body.password, scope: SCOPE });
}

async function refresh(body: { refresh_token?: string }) {
  if (!body.refresh_token) throw new HttpError(400, 'Missing refresh_token');
  return tokenCall({ grant_type: 'refresh_token', refresh_token: body.refresh_token });
}

async function nugsGet(token: string, url: string) {
  const r = await fetch(url, {
    headers: { 'User-Agent': APP_UA, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (r.status === 401) throw new HttpError(401, 'nugs session expired', 'expired');
  if (!r.ok) throw new HttpError(502, `nugs returned ${r.status}`);
  return r.json<Record<string, unknown>>();
}

async function catalog(token: string, params: Record<string, string>) {
  const j = await nugsGet(token, `${API}/api.aspx?${new URLSearchParams(params)}`);
  if (j.responseAvailabilityCode !== undefined && j.responseAvailabilityCode !== 0)
    throw new HttpError(502, String(j.responseAvailabilityCodeStr ?? 'nugs catalog unavailable'));
  return (j.Response ?? {}) as Record<string, unknown>;
}

/** "MM/DD/YYYY HH:MM:SS" (UTC) → unix seconds */
function stamp(s: unknown) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s ?? ''));
  if (!m) return '';
  return String(Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]) / 1000);
}

async function me(token: string) {
  const [user, sub] = await Promise.all([
    nugsGet(token, `${AUTH}/connect/userinfo`),
    nugsGet(token, SUBS).catch(() => null),
  ]);
  const s = (Array.isArray(sub) ? sub[0] : sub) as Record<string, any> | null;
  return {
    userId: String(user.sub ?? ''),
    name: String(user.name ?? user.email ?? ''),
    subscribed: !!s?.legacySubscriptionId,
    sub: s
      ? {
          subscriptionID: String(s.legacySubscriptionId ?? ''),
          subCostplanIDAccessList: String(s.promo?.plan?.id ?? s.plan?.id ?? ''),
          startDateStamp: stamp(s.startedAt),
          endDateStamp: stamp(s.endsAt),
        }
      : null,
  };
}

/* ---- catalog normalization ---------------------------------------- */

const IMG = (img: any) => (img?.url ? `https://secure.livedownloads.com${img.url}` : undefined);

/** Show date as YYYY-MM-DD from whichever date field nugs filled in. */
function isoDate(c: Record<string, any>): string {
  const p2 = (n: string | number) => String(n).padStart(2, '0');
  for (const k of ['performanceDate', 'performanceDateFormatted', 'performanceDateShortYearFirst', 'performanceDateYMD', 'releaseDate']) {
    const v = String(c[k] ?? '').trim();
    if (!v) continue;
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(v); // 2026-10-10, 2026/10/10
    if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v); // 10/10/2026
    if (m) return `${m[3]}-${p2(m[1])}-${p2(m[2])}`;
    m = /^(\d{2})[-/.](\d{2})[-/.](\d{2})$/.exec(v); // 26/10/10 ("short year first")
    if (m && k === 'performanceDateShortYearFirst') return `20${m[1]}-${m[2]}-${m[3]}`;
  }
  return '';
}

function normShow(c: Record<string, any>) {
  return {
    id: String(c.containerID),
    artistId: c.artistID != null ? String(c.artistID) : undefined,
    artist: c.artistName ?? '',
    title: c.containerInfo ?? c.containerName ?? '',
    date: isoDate(c) || (c.performanceDateShortYearFirst ?? c.performanceDate ?? c.releaseDateFormatted ?? ''),
    venue: [c.venueName ?? c.venue, c.venueCity, c.venueState].filter(Boolean).join(', '),
    artwork: IMG(c.img),
  };
}

/** Walk any JSON and collect objects that satisfy `pick`. Search results nest unpredictably. */
function collect(node: unknown, pick: (o: Record<string, any>) => boolean, out: Record<string, any>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => collect(n, pick, out));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (pick(o)) out.push(o);
    else Object.values(o).forEach((v) => collect(v, pick, out));
  }
  return out;
}

async function search(token: string, q: string) {
  if (q.trim().length < 2) return { artists: [], shows: [] };
  const r = await catalog(token, { method: 'catalog.search', searchStr: q.trim() });
  const groups = (r.catalogSearchTypeContainers ?? []) as Record<string, any>[];
  const byType = (t: number) => groups.filter((g) => g.matchType === t);

  const artists = new Map<string, { id: string; name: string }>();
  for (const a of collect(byType(1), (o) => o.artistID != null || (o.matchedStr && o.artistName))) {
    const id = a.artistID != null ? String(a.artistID) : '';
    if (id && !artists.has(id)) artists.set(id, { id, name: a.artistName ?? a.matchedStr });
  }

  const shows = new Map<string, ReturnType<typeof normShow>>();
  for (const c of collect([...byType(6), ...byType(2)], (o) => o.containerID != null)) {
    const s = normShow(c);
    if (!shows.has(s.id)) shows.set(s.id, s);
    if (s.artistId && !artists.has(s.artistId) && byType(1).length === 0)
      artists.set(s.artistId, { id: s.artistId, name: s.artist });
  }
  return { artists: [...artists.values()].slice(0, 10), shows: [...shows.values()].slice(0, 40) };
}

async function artistShows(token: string, artistId: string, offset: number) {
  const r = await catalog(token, {
    method: 'catalog.containersAll',
    artistList: artistId,
    startOffset: String(offset),
    limit: '100',
    vdisp: '1',
    availType: '1',
  });
  const containers = ((r.containers ?? []) as Record<string, any>[]).filter(
    (c) => c.containerType === undefined || c.containerType === 1,
  );
  return { shows: containers.map(normShow), total: Number(r.totalMatchedRecords ?? containers.length) };
}

async function show(token: string, id: string) {
  const c = await catalog(token, { method: 'catalog.container', containerID: id, vdisp: '1' });
  const songs = ((c.songs ?? []) as Record<string, any>[]).map((s) => ({
    trackId: String(s.trackID),
    title: s.songTitle ?? '',
    durationSec: Number(s.totalRunningTime ?? 0) || undefined,
    set: s.setNum ?? s.discNum ?? 1,
    position: s.trackNum ?? 0,
  }));
  return { ...normShow(c as Record<string, any>), songs };
}

/* ---- streams -------------------------------------------------------- */

// Formats a browser can play, best first. ALAC/MQA/360 and HLS are skipped.
const PLAYABLE = [
  { marker: '.flac16/', format: 'FLAC' },
  { marker: '.aac150/', format: 'AAC' },
];

async function stream(token: string, p: URLSearchParams) {
  const base: Record<string, string> = { app: '1' };
  for (const k of ['trackID', 'subscriptionID', 'subCostplanIDAccessList', 'nn_userID', 'startDateStamp', 'endDateStamp']) {
    const v = p.get(k);
    if (!v) throw new HttpError(400, `Missing ${k}`);
    base[k] = v;
  }
  const preferAac = p.get('prefer') === 'aac';
  const found: { url: string; format: string }[] = [];
  // nugs picks the format from platformID; these are the values the Android app uses.
  for (const platformID of ['2', '5', '9', '8', '']) {
    const q = new URLSearchParams(platformID ? { ...base, platformID } : base);
    const j = await nugsGet(token, `${API}/bigriver/subPlayer.aspx?${q}`).catch(() => null);
    const link = typeof j?.streamLink === 'string' ? j.streamLink : '';
    const hit = PLAYABLE.find((f) => link.includes(f.marker));
    if (hit && !link.includes('.m3u8')) {
      found.push({ url: link, format: hit.format });
      if (hit.format === (preferAac ? 'AAC' : 'FLAC')) break;
    }
  }
  if (!found.length) throw new HttpError(404, 'No browser-playable stream for this track', 'no_stream');
  found.sort((a, b) => (a.format === (preferAac ? 'AAC' : 'FLAC') ? -1 : 0) - (b.format === (preferAac ? 'AAC' : 'FLAC') ? -1 : 0));
  return found[0];
}

/* ---- link lookups (no login needed) --------------------------------- */

async function youtubeMeta(id: string) {
  if (!/^[\w-]{11}$/.test(id)) throw new HttpError(400, 'Not a YouTube video id');
  const r = await fetch(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
  );
  if (r.status === 401 || r.status === 403) throw new HttpError(403, 'This video doesn’t allow playing outside YouTube', 'no_embed');
  if (!r.ok) throw new HttpError(404, 'YouTube video not found');
  const j = await r.json<{ title: string; author_name: string; thumbnail_url: string }>();
  return { id, title: j.title, channel: j.author_name, thumbnail: j.thumbnail_url };
}

function parseLength(v: unknown): number | undefined {
  if (v == null) return undefined;
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

async function archiveItem(id: string) {
  if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, 'Not an archive.org identifier');
  const r = await fetch(`https://archive.org/metadata/${id}`);
  if (!r.ok) throw new HttpError(502, `archive.org returned ${r.status}`);
  const j = await r.json<{ metadata?: Record<string, any>; files?: Record<string, any>[] }>();
  if (!j.metadata) throw new HttpError(404, 'archive.org item not found');
  const m = j.metadata;
  const files = j.files ?? [];
  const pick = (fmt: (f: string) => boolean) => files.filter((f) => fmt(String(f.format ?? '')));
  let audio = pick((f) => f === 'VBR MP3');
  if (!audio.length) audio = pick((f) => /MP3/i.test(f));
  if (!audio.length) audio = pick((f) => /^Flac$/i.test(f));
  const tracks = audio
    .map((f) => ({
      file: String(f.name),
      title: String(f.title ?? String(f.name).replace(/\.[^.]+$/, '')),
      track: parseInt(String(f.track ?? ''), 10) || undefined,
      durationSec: parseLength(f.length),
      url: `https://archive.org/download/${id}/${String(f.name).split('/').map(encodeURIComponent).join('/')}`,
    }))
    .sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || a.file.localeCompare(b.file, undefined, { numeric: true }));
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  return {
    id,
    title: String(first(m.title) ?? id),
    artist: String(first(m.creator) ?? ''),
    date: String(first(m.date) ?? ''),
    venue: [first(m.venue), first(m.coverage)].filter(Boolean).join(', '),
    tracks,
  };
}

/* ---- caching for public lookups (archive.org / Gizz Tapes) ----------- */

/** Cache a public lookup for an hour at Cloudflare's edge, to go easy on archive.org. */
async function cached<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(new URL(req.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit.json<T>();
  const data = await fn();
  await cache.put(key, new Response(JSON.stringify(data), { headers: { 'Cache-Control': 'max-age=3600', 'Content-Type': 'application/json' } }));
  return data;
}

/* ---- archive.org search: find tapes by band + date -------------------- */

// Bands with their own archive.org collection; everyone else is searched by creator name.
const ARCHIVE_COLLECTIONS: Record<string, string> = {
  'billy strings': 'BillyStrings',
  'king gizzard and lizard wizard': 'KingGizzardAndTheLizardWizard',
  'king gizzard': 'KingGizzardAndTheLizardWizard',
};
const normName = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim();

async function archiveSearch(p: URLSearchParams) {
  const artist = p.get('artist') ?? '';
  const date = p.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !artist.trim()) throw new HttpError(400, 'artist and date (YYYY-MM-DD) required');
  const coll = ARCHIVE_COLLECTIONS[normName(artist)];
  const who = coll ? `collection:${coll}` : `creator:("${artist.replace(/"/g, '')}")`;
  const q = `${who} AND (date:[${date} TO ${date}] OR identifier:*${date}*)`;
  const r = await fetch(
    `https://archive.org/advancedsearch.php?${new URLSearchParams({ q, rows: '25', output: 'json' })}&fl[]=identifier&fl[]=date&fl[]=title&fl[]=downloads`,
  );
  if (!r.ok) throw new HttpError(502, `archive.org search returned ${r.status}`);
  const j = await r.json<{ response?: { docs?: Record<string, any>[] } }>();
  const compact = date.replace(/-/g, '');
  const docs = (j.response?.docs ?? []).filter((d) => {
    const id = String(d.identifier);
    return id.includes(date) || id.includes(compact) || String(d.date ?? '').startsWith(date);
  });
  // Soundboards first, then 24-bit/flac sources, then the most downloaded.
  const score = (id: string) => (/sbd|soundboard/i.test(id) ? 4 : 0) + (/flac/i.test(id) ? 1 : 0);
  docs.sort((a, b) => score(String(b.identifier)) - score(String(a.identifier)) || Number(b.downloads ?? 0) - Number(a.downloads ?? 0));
  return { identifiers: docs.map((d) => String(d.identifier)) };
}

/* ---- Gizz Tapes (King Gizzard): setlist + archive.org recordings ------- */

async function gizzTapes(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const r = await fetch(`https://tapes.kglw.net/api/v1/shows/${date}.json`, { headers: { Accept: 'application/json' } });
  if (r.status === 404) throw new HttpError(404, 'Gizz Tapes has no show on that date');
  if (!r.ok) throw new HttpError(502, `Gizz Tapes returned ${r.status}`);
  const j = await r.json<Record<string, any>>();
  const show = (j.show ?? j) as Record<string, any>;
  const compact = date.replace(/-/g, '');
  const recs = ((show.recordings ?? []) as Record<string, any>[])
    .map((rec) => {
      const prefix = String(rec.files_path_prefix ?? '');
      const id = /archive\.org\/download\/([^/]+)/.exec(prefix)?.[1] ?? String(rec.identifier ?? '');
      return { rec, prefix, id };
    })
    // A recording whose archive id doesn't carry the show date is probably mislabeled.
    .filter((x) => x.prefix && (x.id.includes(date) || x.id.includes(compact)) && !x.rec.is_incomplete);
  const score = (x: { rec: Record<string, any> }) => (String(x.rec.type).toUpperCase() === 'SBD' ? 10 : 0);
  recs.sort((a, b) => score(b) - score(a) || String(b.rec.uploaded_at ?? '').localeCompare(String(a.rec.uploaded_at ?? '')));
  const setlist = ((show.sets ?? []) as Record<string, any>[]).flatMap((set) =>
    ((set.songs ?? []) as Record<string, any>[]).map((s) => String(s.song?.name ?? s.name ?? '')),
  );
  return {
    date,
    venue: [show.venue?.name, show.venue?.city ?? show.venue?.location].filter(Boolean).join(', '),
    setlist,
    recordings: recs.map(({ rec, prefix, id }) => ({
      id,
      type: String(rec.type ?? '').toUpperCase() || 'AUD',
      tracks: ((rec.files ?? []) as Record<string, any>[])
        .filter((f) => /\.(mp3|m4a|ogg|flac)$/i.test(String(f.filename ?? '')))
        .map((f) => ({
          file: String(f.filename),
          title: String(f.title ?? f.filename).replace(/\.[^.]+$/, ''),
          durationSec: parseLength(f.length),
          url: prefix.replace(/\/?$/, '/') + String(f.filename).split('/').map(encodeURIComponent).join('/'),
        })),
    })),
  };
}

/* ---- find one show by artist + date ---------------------------------- */

/**
 * Big catalogs (Billy Strings has well over a thousand shows) don't fit in
 * one page, and nugs may list them oldest first. Page through intelligently:
 * look at the first page, figure out the sort order, then jump toward the
 * target date. At most 8 requests.
 */
async function findShow(token: string, artist: string, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const found = await search(token, artist);
  const want = norm(artist);
  const a = found.artists.find((x) => norm(x.name) === want) ?? found.artists.find((x) => norm(x.name).includes(want)) ?? found.artists[0];
  const direct = found.shows.find((s) => s.date === date && (!a || s.artistId === a.id || norm(s.artist) === want));
  if (direct) return { show: direct, via: 'search' };
  if (!a) throw new HttpError(404, `nugs doesn’t list an artist called ${artist}`, 'no_artist');

  const LIMIT = 100;
  const page = async (offset: number) => {
    const r = await catalog(token, {
      method: 'catalog.containersAll',
      artistList: a.id,
      startOffset: String(offset),
      limit: String(LIMIT),
      vdisp: '1',
      availType: '1',
    });
    const shows = ((r.containers ?? []) as Record<string, any>[]).map(normShow);
    return { shows, total: Number(r.totalMatchedRecords ?? shows.length) };
  };

  const tried: string[] = [];
  const visited = new Set<number>([1]);
  let offset = 1;
  let total = Infinity;
  for (let i = 0; i < 8 && offset >= 1 && offset <= total; i++) {
    const { shows, total: t } = await page(offset);
    total = t;
    const dates = shows.map((s) => s.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    tried.push(`${offset}:${dates[0] ?? '?'}..${dates[dates.length - 1] ?? '?'}`);
    const hit = shows.find((s) => s.date === date);
    if (hit) return { show: hit, via: 'catalog', tried };
    if (!dates.length || shows.length < LIMIT && offset === 1) break;
    const first = dates[0];
    const last = dates[dates.length - 1];
    const ascending = first <= last;
    const lo = ascending ? first : last;
    const hi = ascending ? last : first;
    if (date >= lo && date <= hi) break; // inside this page's range but missing: nugs doesn't have it
    // Is the target further down the list, or before this page?
    const further = ascending ? date > hi : date < lo;
    if (!further && offset === 1) break; // before the very first page: doesn't exist
    // Estimate how many shows away the date is from this page's edge, using
    // this page's shows-per-day, and jump straight there.
    const dayMs = 864e5;
    const span = Math.max(1, (Date.parse(hi) - Date.parse(lo)) / dayMs);
    const perDay = Math.max(dates.length - 1, 1) / span;
    const edgeDate = further ? (ascending ? hi : lo) : ascending ? lo : hi;
    const gapDays = Math.abs(Date.parse(date) - Date.parse(edgeDate)) / dayMs;
    const jump = Math.max(1, Math.round(gapDays * perDay));
    const edgeIdx = further ? offset + shows.length - 1 : offset;
    const targetIdx = further ? edgeIdx + jump : edgeIdx - jump;
    let next = Math.min(Math.max(1, targetIdx - Math.floor(LIMIT / 2)), Math.max(1, total - LIMIT + 1));
    if (next === offset) next = further ? offset + LIMIT : Math.max(1, offset - LIMIT);
    if (visited.has(next)) break;
    visited.add(next);
    offset = next;
  }
  throw new HttpError(404, `nugs doesn’t have ${a.name} on ${date}`, 'no_show');
}
