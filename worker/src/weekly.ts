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
  bands: string[];
  showsPerBand: number;
  newArtists: number;
  autoPublish: boolean;
  /** The curator instructions. Placeholders: {{bands}}, {{showsPerBand}}, {{newArtists}}, {{today}}, {{already}}. */
  prompt: string;
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
}

export const DEFAULT_PROMPT = `Today is {{today}}. You are curating a weekly listen list of standout live music for a small group of friends.

1. Check JamBase, nugs.net, Phish.net, kglw.net, Westword, Live For Live Music, Relix and similar fan/review sites for recent concert reviews and setlists from: {{bands}}. Identify recent shows (roughly the last 8 weeks) that fans or critics call standout, "best of tour", or otherwise exceptional. Pick up to {{showsPerBand}} per band. For each show, name the single standout song (the jam people are talking about) when the coverage makes that clear.

2. Find up to {{newArtists}} new or emerging artists worth discovering, in jam/rock-adjacent territory broadly defined: jamgrass/bluegrass, psychedelic rock, classic-rock/jam-revival acts (in the lineage of the Grateful Dead, Allman Brothers, etc.), and electronic/dance acts with jam or improvisational sensibilities. Use Jambase, Live For Live Music, NPR Music and relevant genre press. Be very selective: only genuinely strong fits, never a padded list. Zero is fine.

3. Every pick must include at least one confirmed, working way to listen right now: a nugs.net or LivePhish page, a free YouTube upload, a taper/archive site (archive.org, phish.in, relisten.net, tapes.kglw.net), or Bandcamp. If a great show or artist has no listenable source, leave it out. Include direct listening links, and add the best review/recap link too.

Do not repeat these shows from previous weeks: {{already}}`;

const OUTPUT_RULES = `

When you're done researching, reply with ONLY a JSON object inside <picks></picks> tags, no other text, in exactly this shape:
<picks>{"picks":[{"kind":"show","artist":"Phish","date":"2026-10-06","venue":"Allianz Amphitheater, Richmond, VA","highlight":"Life Saving Gun","why":"One or two sentences on why it stands out.","links":["https://listen-link","https://review-link"]},{"kind":"new_artist","artist":"Band Name","date":null,"venue":null,"highlight":"Song title or null","why":"Why they fit.","links":["https://youtube-or-bandcamp-link"]}]}</picks>
Rules: date is YYYY-MM-DD or null; highlight is the exact song title as it appears on setlists, or null; put the most directly playable link first.`;

export const DEFAULT_CONFIG: WeeklyConfig = {
  enabled: true,
  day: 1,
  hour: 8,
  bands: ['Phish', 'Billy Strings', 'King Gizzard & the Lizard Wizard'],
  showsPerBand: 2,
  newArtists: 2,
  autoPublish: true,
  prompt: DEFAULT_PROMPT,
  model: 'claude-sonnet-5-5',
};

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

export function buildPrompt(cfg: WeeklyConfig, already: string[]) {
  return (
    cfg.prompt
      .replaceAll('{{today}}', nyToday())
      .replaceAll('{{bands}}', cfg.bands.join(', '))
      .replaceAll('{{showsPerBand}}', String(cfg.showsPerBand))
      .replaceAll('{{newArtists}}', String(cfg.newArtists))
      .replaceAll('{{already}}', already.length ? already.join('; ') : '(none yet)') + OUTPUT_RULES
  );
}

export async function curate(apiKey: string, cfg: WeeklyConfig, already: string[], baseUrl = 'https://api.anthropic.com'): Promise<CurateResult> {
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: buildPrompt(cfg, already) }];
  const total = { searches: 0, inputTokens: 0, outputTokens: 0 };
  let text = '';

  // The newer search tool filters results before they reach the model (far fewer
  // input tokens). Fall back to the basic tool if this account/model rejects it.
  let toolType = 'web_search_20260209';

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
          tools: [{ type: toolType, name: 'web_search', max_uses: 15 }],
        }),
      });
    let r = await send();
    if (r.status === 400 && round === 0 && toolType !== 'web_search_20250305') {
      const peek = await r.clone().text();
      if (/web_search|tool/i.test(peek)) {
        toolType = 'web_search_20250305';
        r = await send();
      }
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
    }))
    .filter((p) => p.artist);
  return { picks, raw: text.slice(0, 20000), tool: toolType, ...total };
}
