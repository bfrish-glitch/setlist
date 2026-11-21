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
  async fetch(req: Request): Promise<Response> {
    const origin = req.headers.get('Origin') ?? '';
    const cors: Record<string, string> = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // Only the Setlist site may use this relay.
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Origin not allowed' }, 403);

    const url = new URL(req.url);
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
        case 'GET /nugs/artist':
          return json(await artistShows(bearer(req), need(url, 'id'), Number(url.searchParams.get('offset') ?? 1)));
        case 'GET /nugs/show':
          return json(await show(bearer(req), need(url, 'id')));
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

function normShow(c: Record<string, any>) {
  return {
    id: String(c.containerID),
    artistId: c.artistID != null ? String(c.artistID) : undefined,
    artist: c.artistName ?? '',
    title: c.containerInfo ?? c.containerName ?? '',
    date: c.performanceDateShortYearFirst ?? c.performanceDate ?? c.releaseDateFormatted ?? '',
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
