/**
 * Weekly picks: Setlist runs the curator prompt itself through Claude with
 * web search, and stores the picks for the group's apps to turn into the
 * "Week of …" playlist. Lives inside the Group Durable Object (its SQLite
 * and its alarm, which doubles as the weekly schedule).
 */

export interface WeeklyConfig {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday, in New York time. */
  day: number;
  hour: number;
  /** Bands checked every week; anything else great in the recap listings is fair game too. */
  watchlist: string[];
  /** Total picks to aim for. */
  picks: number;
  /** Most jams from one band in a week. */
  maxPerBand: number;
  /** Per-band caps that override maxPerBand, e.g. { "Goose": 1 }. */
  bandLimits: Record<string, number>;
  /** Only shows from the last N days. */
  windowDays: number;
  newArtists: number;
  autoPublish: boolean;
  /**
   * The curator instructions. Placeholders: {{today}}, {{windowStart}},
   * {{watchlist}}, {{picks}}, {{maxPerBand}}, {{bandLimits}}, {{newArtists}}, {{already}}.
   */
  prompt: string;
  /** Bumped when the default prompt changes, so old saved copies upgrade. */
  promptVersion: number;
  model: string;
}

export interface WeeklyPick {
  kind: 'show' | 'new_artist';
  artist: string;
  date: string | null;
  venue: string | null;
  highlight: string | null;
  why: string;
  links: string[];
  caveats?: string | null;
}

export const DEFAULT_PROMPT_V1 = `Today is {{today}}. You are curating a weekly listen list of standout live music for a small group of friends.

1. Check JamBase, nugs.net, Phish.net, kglw.net, Westword, Live For Live Music, Relix and similar fan/review sites for recent concert reviews and setlists from: {{bands}}. Identify recent shows (roughly the last 8 weeks) that fans or critics call standout, "best of tour", or otherwise exceptional. Pick up to {{showsPerBand}} per band. For each show, name the single standout song (the jam people are talking about) when the coverage makes that clear.

2. Find up to {{newArtists}} new or emerging artists worth discovering, in jam/rock-adjacent territory broadly defined: jamgrass/bluegrass, psychedelic rock, classic-rock/jam-revival acts (in the lineage of the Grateful Dead, Allman Brothers, etc.), and electronic/dance acts with jam or improvisational sensibilities. Use Jambase, Live For Live Music, NPR Music and relevant genre press. Be very selective: only genuinely strong fits, never a padded list. Zero is fine.

3. Every pick must include at least one confirmed, working way to listen right now: a nugs.net or LivePhish page, a free YouTube upload, a taper/archive site (archive.org, phish.in, relisten.net, tapes.kglw.net), or Bandcamp. If a great show or artist has no listenable source, leave it out. Include direct listening links, and add the best review/recap link too.

Do not repeat these shows from previous weeks: {{already}}`;

export const DEFAULT_PROMPT = `Today is {{today}}. Curate a weekly listen list of the best live jam-band and bluegrass/jamgrass performances played between {{windowStart}} and {{today}} (inclusive). Nothing outside that window.

BUDGET: at most 8 web searches and 8 page fetches. Fetch before you search.

STEP 1: Fetch these listing pages first (they are fresher than search):
- https://www.jambase.com/collection/reviews-recaps
- https://liveforlivemusic.com/news/recap/
- https://elgoose.net/reviews/ (fan reviews, including critical ones)
- https://ryanstorm.substack.com/archive
- https://phish.net/ (only if Phish or Trey Anastasio Band played in the window)
From these, list the window's candidate shows. Fetch at most 3 individual recaps or reviews, choosing the most promising.

STEP 2: Use searches only to (a) check watchlist acts with no coverage above: {{watchlist}}, and (b) find independent or critical takes on your top candidates (fan reviews, Substacks, phish.net reviews, kglw.net). Skip any act that did not play in the window. Never search for ticket pages.

STEP 3: Score each candidate.
Strong: 2+ independent sources praise the same show or jam; fan reviews say "best of tour"; a reviewer singles out a jam over about 18 minutes; jam-chart inclusion.
Medium: notable segues or sandwiches, a bust-out after a gap of more than about 100 shows, a debut, a meaningful guest.
Weak: one descriptive press recap, band PR, livestream promotion.
Negative: "flat", "sloppy", "choppy", "lacked direction", "didn't go deep", "cover-heavy", a cut set. Downgrade the show, or use only its praised segment.
Prefer consensus over hype. If a show is notable only for a rarity, say "curio" in the why.

STEP 4: Choose up to {{picks}} picks: at most {{maxPerBand}} per band{{bandLimits}}; at least 1 bluegrass/jamgrass pick when one qualifies; and up to {{newArtists}} emerging artist backed by two sources. For each pick name ONE highlight song (the specific jam the sources praise), explain why in one or two sentences crediting the sources, note any critical remarks as caveats, include the best review URL, and name the likely listen source (nugs/LivePhish, archive.org/Relisten, phish.in, tapes.kglw.net, YouTube, Bandcamp). Don't spend searches verifying listen links. Fewer picks is fine. Never pad.

Do not repeat these shows from previous weeks: {{already}}`;

const OUTPUT_RULES = `

When you're done researching, reply with ONLY a JSON object inside <picks></picks> tags, no other text, in exactly this shape:
<picks>{"picks":[{"kind":"show","artist":"Phish","date":"2026-10-06","venue":"Allianz Amphitheater, Richmond, VA","highlight":"Life Saving Gun","why":"One or two sentences on why it stands out, crediting sources.","caveats":"Any critical remarks, or null","links":["https://listen-link-if-known","https://best-review-link"]},{"kind":"new_artist","artist":"Band Name","date":null,"venue":null,"highlight":"Song title or null","why":"Why they fit.","caveats":null,"links":["https://youtube-or-bandcamp-link"]}]}</picks>
Rules: date is YYYY-MM-DD or null; highlight is the exact song title as it appears on setlists, or null; put the most directly playable link first, then the review link.`;

export const PROMPT_VERSION = 2;

export const DEFAULT_CONFIG: WeeklyConfig = {
  enabled: true,
  day: 1,
  hour: 8,
  watchlist: [
    'Phish',
    'Billy Strings',
    'King Gizzard & the Lizard Wizard',
    'Goose',
    'Trey Anastasio Band',
    'Dead & Company',
    "Joe Russo's Almost Dead",
    'Widespread Panic',
    "Umphrey's McGee",
    'String Cheese Incident',
    'Greensky Bluegrass',
  ],
  picks: 8,
  maxPerBand: 2,
  bandLimits: { Goose: 1 },
  windowDays: 14,
  newArtists: 1,
  autoPublish: true,
  prompt: DEFAULT_PROMPT,
  promptVersion: PROMPT_VERSION,
  model: 'claude-sonnet-5-5',
};

/** Bring a saved config up to date: v1 settings (bands/showsPerBand) and the v1 default prompt. */
export function upgradeConfig(saved: Partial<WeeklyConfig> & { bands?: string[]; showsPerBand?: number }): WeeklyConfig {
  const cfg = { ...DEFAULT_CONFIG, ...saved } as WeeklyConfig & { bands?: string[]; showsPerBand?: number };
  if (!saved.promptVersion || saved.promptVersion < PROMPT_VERSION) {
    // Keep a prompt the owner wrote themselves; replace an untouched old default.
    if (!saved.prompt || saved.prompt === DEFAULT_PROMPT_V1) cfg.prompt = DEFAULT_PROMPT;
    cfg.promptVersion = PROMPT_VERSION;
  }
  delete cfg.bands;
  delete cfg.showsPerBand;
  return cfg;
}

/* ---- schedule (New York time, DST-safe) ---------------------------- */

function nyOffsetMinutes(at: Date): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value; // "GMT-5"
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(part ?? '');
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : -300;
}

/** The next time it's `day` at `hour`:00 in New York, after `from`. */
export function nextRunAt(cfg: WeeklyConfig, from = Date.now()): number {
  for (let d = 0; d <= 8; d++) {
    const probe = new Date(from + d * 864e5);
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(probe)
      .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(ymd.weekday);
    if (weekday !== cfg.day) continue;
    const guess = Date.UTC(+ymd.year, +ymd.month - 1, +ymd.day, cfg.hour, 0, 0);
    const at = guess - nyOffsetMinutes(new Date(guess)) * 60000;
    if (at > from + 60000) return at;
  }
  return from + 7 * 864e5;
}

/* ---- the Claude call ----------------------------------------------- */

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

export interface CurateResult {
  picks: WeeklyPick[];
  raw: string;
  tool?: string;
  searches: number;
  inputTokens: number;
  outputTokens: number;
}

const nyToday = () =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());

const nyDate = (ms: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ms));

export function buildPrompt(cfg: WeeklyConfig, already: string[]) {
  const limits = Object.entries(cfg.bandLimits ?? {})
    .filter(([, n]) => n >= 0)
    .map(([band, n]) => `${band}: at most ${n}`)
    .join('; ');
  return (
    cfg.prompt
      .replaceAll('{{today}}', nyToday())
      .replaceAll('{{windowStart}}', nyDate(Date.now() - cfg.windowDays * 864e5))
      .replaceAll('{{watchlist}}', cfg.watchlist.join(', '))
      .replaceAll('{{picks}}', String(cfg.picks))
      .replaceAll('{{maxPerBand}}', String(cfg.maxPerBand))
      .replaceAll('{{bandLimits}}', limits ? ` (${limits})` : '')
      .replaceAll('{{newArtists}}', String(cfg.newArtists))
      // v1 placeholders, in case an owner kept an old custom prompt
      .replaceAll('{{bands}}', cfg.watchlist.join(', '))
      .replaceAll('{{showsPerBand}}', String(cfg.maxPerBand))
      .replaceAll('{{already}}', already.length ? already.join('; ') : '(none yet)') + OUTPUT_RULES
  );
}

// Ticket and listing spam that crowds out real reviews in search results.
const BLOCKED = [
  'seatgeek.com', 'stereoboard.com', 'eventticketscenter.com', 'tickpick.com', 'songkick.com', 'concerts50.com',
  'concertfix.com', 'concertarchives.org', 'eventworld.co', 'ticketx.com', 'gigora.com', 'livenation.com',
  'ticketmaster.com', 'stubhub.com', 'vividseats.com', 'axs.com', 'bandsintown.com',
];

// Newest tools first: they filter pages before the model reads them (far fewer tokens).
// Older versions are fallbacks if this account or model rejects the newer ones.
const TOOL_TIERS = [
  { search: 'web_search_20260318', fetch: 'web_fetch_20260318' },
  { search: 'web_search_20260209', fetch: 'web_fetch_20260209' },
  { search: 'web_search_20250305', fetch: 'web_fetch_20250910' },
];

/** Normalize band names so "King Gizzard & The Lizard Wizard" and "king gizzard and the lizard wizard" match. */
const bandKey = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, '');

/** Hard limits the prompt asked for, enforced in code too: window, per-band caps, total. */
export function enforce(picks: WeeklyPick[], cfg: WeeklyConfig, now = Date.now()): WeeklyPick[] {
  const start = new Date(now - (cfg.windowDays + 1) * 864e5).toISOString().slice(0, 10);
  const end = new Date(now + 864e5).toISOString().slice(0, 10);
  // "King Gizzard" and "King Gizzard & The Lizard Wizard" are the same band:
  // a name that starts with another known name (5+ letters) shares its count.
  const seenKeys: string[] = [];
  const canon = (name: string) => {
    const k = bandKey(name);
    const hit = seenKeys.find((s) => (k.length >= 5 && s.startsWith(k)) || (s.length >= 5 && k.startsWith(s)));
    if (hit) return hit;
    seenKeys.push(k);
    return k;
  };
  const caps = new Map<string, number>();
  for (const [b, n] of Object.entries(cfg.bandLimits ?? {})) caps.set(canon(b), n);
  const used = new Map<string, number>();
  let newOnes = 0;
  const out: WeeklyPick[] = [];
  for (const p of picks) {
    if (p.kind === 'show' && p.date && (p.date < start || p.date > end)) continue;
    if (p.kind === 'new_artist') {
      if (newOnes >= cfg.newArtists) continue;
      newOnes++;
    }
    const k = canon(p.artist);
    const cap = caps.get(k) ?? cfg.maxPerBand;
    if ((used.get(k) ?? 0) >= cap) continue;
    used.set(k, (used.get(k) ?? 0) + 1);
    out.push(p);
    if (out.length >= cfg.picks) break;
  }
  return out;
}

export async function curate(apiKey: string, cfg: WeeklyConfig, already: string[], baseUrl = 'https://api.anthropic.com'): Promise<CurateResult> {
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: buildPrompt(cfg, already) }];
  const total = { searches: 0, inputTokens: 0, outputTokens: 0 };
  let text = '';

  let tier = 0;

  // Long research turns come back as "pause_turn": send the paused message back unchanged to continue.
  for (let round = 0; round < 6; round++) {
    const send = () =>
      fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 8000,
          messages,
          tools: [
            { type: TOOL_TIERS[tier].search, name: 'web_search', max_uses: 8, blocked_domains: BLOCKED },
            { type: TOOL_TIERS[tier].fetch, name: 'web_fetch', max_uses: 8, max_content_tokens: 8000 },
          ],
        }),
      });
    let r = await send();
    while (r.status === 400 && round === 0 && tier < TOOL_TIERS.length - 1) {
      const peek = await r.clone().text();
      if (!/web_search|web_fetch|tool/i.test(peek)) break;
      tier++;
      r = await send();
    }
    const j = (await r.json()) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: Usage;
      error?: { message?: string };
    };
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${j.error?.message ?? 'request failed'}`);
    total.searches += j.usage?.server_tool_use?.web_search_requests ?? 0;
    total.inputTokens += j.usage?.input_tokens ?? 0;
    total.outputTokens += j.usage?.output_tokens ?? 0;
    text = (j.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (j.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: j.content });
  }

  const m = /<picks>([\s\S]*?)<\/picks>/.exec(text) ?? /(\{[\s\S]*"picks"[\s\S]*\})/.exec(text);
  if (!m) throw new Error('Claude finished without a picks list');
  let parsed: { picks?: unknown[] };
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    throw new Error('Claude’s picks list wasn’t valid JSON');
  }
  const picks: WeeklyPick[] = (parsed.picks ?? [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .map((p) => ({
      kind: (p.kind === 'new_artist' ? 'new_artist' : 'show') as WeeklyPick['kind'],
      artist: String(p.artist ?? '').slice(0, 120),
      date: typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : null,
      venue: p.venue ? String(p.venue).slice(0, 200) : null,
      highlight: p.highlight ? String(p.highlight).slice(0, 120) : null,
      why: String(p.why ?? '').slice(0, 600),
      links: (Array.isArray(p.links) ? p.links : []).map(String).filter((l) => /^https?:\/\//.test(l)).slice(0, 5),
      caveats: p.caveats ? String(p.caveats).slice(0, 400) : null,
    }))
    .filter((p) => p.artist);
  return { picks: enforce(picks, cfg), raw: text.slice(0, 20000), tool: TOOL_TIERS[tier].search, ...total };
}
