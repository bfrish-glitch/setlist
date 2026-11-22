/**
 * Step 1 of the weekly picks: gather every candidate show in the window
 * with plain code, so Claude only has to judge them, not find them.
 *
 *  - Recap headlines from music sites' RSS feeds and listing pages.
 *  - Shows each watchlist band played in the window, from Relisten
 *    (tapes on archive.org / phish.in).
 *
 * Every source is optional: a site that's down or changed just shows up as
 * "0 found" in the run's report.
 */

export interface Article {
  source: string;
  title: string;
  url: string;
  published?: string; // YYYY-MM-DD
  snippet?: string;
}

export interface ShowRow {
  artist: string;
  date: string;
  venue: string;
}

export interface SourceReport {
  name: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface Candidates {
  articles: Article[];
  shows: ShowRow[];
  sources: SourceReport[];
}

const UA = 'Mozilla/5.0 (compatible; SetlistBot/1.0; +https://bfrish-glitch.github.io/setlist/)';

const FEEDS: { name: string; url: string; all?: boolean }[] = [
  { name: 'Live For Live Music', url: 'https://liveforlivemusic.com/feed/' },
  { name: 'Glide Magazine', url: 'https://glidemagazine.com/feed/' },
  { name: 'Relix', url: 'https://relix.com/feed/' },
  { name: 'Grateful Web', url: 'https://www.gratefulweb.net/rss.xml' },
  { name: 'Ryan Storm (Substack)', url: 'https://ryanstorm.substack.com/feed', all: true },
  { name: 'JamBase', url: 'https://www.jambase.com/feed' },
];

// Headlines that look like coverage of a specific show.
const SHOW_WORDS =
  /\b(recap|review|reviewed|setlist|debut|debuts|bust[- ]?out|sit[s]?[- ]in|joins?|welcomes?|covers?|jam|jams|night|nights|show|shows|concert|run|stream|watch|video|audio|plays?|played|opens?|closes?|tour|encore|segue|premiere)\b/i;

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#822[01];|&[lr]dquo;|&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&#8230;|&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
};

const isoDay = (d: string | undefined) => {
  if (!d) return undefined;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
};

async function get(url: string) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function readFeed(feed: (typeof FEEDS)[number], since: string): Promise<Article[]> {
  const xml = await get(feed.url);
  const items = xml.split(/<item[\s>]/i).slice(1);
  const out: Article[] = [];
  for (const raw of items) {
    const item = raw.split(/<\/item>/i)[0];
    const title = tag(item, 'title');
    const url = tag(item, 'link') || (/<guid[^>]*>(https?:[^<]+)<\/guid>/i.exec(item)?.[1] ?? '');
    const published = isoDay(tag(item, 'pubDate') || tag(item, 'dc:date'));
    if (!title || !url) continue;
    if (published && published < since) continue;
    if (!feed.all && !SHOW_WORDS.test(title)) continue;
    const snippet = tag(item, 'description').slice(0, 220);
    out.push({ source: feed.name, title: title.slice(0, 200), url, published, snippet: snippet || undefined });
  }
  return out.slice(0, 40);
}

/** JamBase's reviews & recaps page (no dates on the page, newest first). */
async function readJamBaseListing(): Promise<Article[]> {
  const html = await get('https://www.jambase.com/collection/reviews-recaps');
  const out: Article[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="((?:https:\/\/www\.jambase\.com)?\/article\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m; (m = re.exec(html)) && out.length < 30; ) {
    const url = m[1].startsWith('http') ? m[1] : `https://www.jambase.com${m[1]}`;
    const title = decode(m[2]);
    if (!title || title.length < 12 || seen.has(url)) continue;
    seen.add(url);
    out.push({ source: 'JamBase recaps', title: title.slice(0, 200), url });
  }
  return out;
}

export const normName = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/\bthe\b/g, '').replace(/[^a-z0-9]+/g, '');

/** Shows each watchlist band played in the window, from Relisten's tape catalog. */
async function readRelisten(watchlist: string[], days: number): Promise<ShowRow[]> {
  const artists = JSON.parse(await get('https://api.relisten.net/api/v2/artists')) as { name: string; slug: string }[];
  const wanted = watchlist
    .map((w) => {
      const k = normName(w);
      return artists.find((a) => normName(a.name) === k) ?? artists.find((a) => normName(a.name).startsWith(k) || k.startsWith(normName(a.name)));
    })
    .filter((a): a is { name: string; slug: string } => !!a);
  const lists = await Promise.all(
    wanted.slice(0, 15).map(async (a) => {
      try {
        type Row = { display_date: string; venue?: { name?: string; location?: string } | null };
        const body = JSON.parse(await get(`https://api.relisten.net/api/v2/artists/${a.slug}/shows/recently-performed?days=${days + 2}`)) as
          | Row[]
          | { shows?: Row[] };
        const cutoff = new Date(Date.now() - (days + 2) * 864e5).toISOString().slice(0, 10);
        const shows = (Array.isArray(body) ? body : body.shows ?? []).filter((s) => s.display_date && s.display_date >= cutoff);
        return shows.map((s) => ({
          artist: a.name,
          date: s.display_date,
          venue: [s.venue?.name, s.venue?.location].filter(Boolean).join(', '),
        }));
      } catch {
        return [];
      }
    }),
  );
  return lists.flat().sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 60);
}

export async function gatherCandidates(watchlist: string[], windowDays: number): Promise<Candidates> {
  const since = new Date(Date.now() - (windowDays + 2) * 864e5).toISOString().slice(0, 10);
  const sources: SourceReport[] = [];
  const track = async <T>(name: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      const rows = await fn();
      sources.push({ name, ok: true, count: rows.length });
      return rows;
    } catch (e) {
      sources.push({ name, ok: false, count: 0, error: e instanceof Error ? e.message.slice(0, 80) : 'failed' });
      return [];
    }
  };
  const [feeds, listing, shows] = await Promise.all([
    Promise.all(FEEDS.map((f) => track(f.name, () => readFeed(f, since)))),
    track('JamBase recaps page', readJamBaseListing),
    track('Relisten (tapes by band)', () => readRelisten(watchlist, windowDays)),
  ]);
  // Same article from a feed and a listing: keep one.
  const seen = new Set<string>();
  const articles = [...feeds.flat(), ...listing].filter((a) => {
    const k = a.url.replace(/[?#].*$/, '').replace(/\/$/, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { articles: articles.slice(0, 120), shows, sources };
}

/** The candidate list as plain text for the prompt. */
export function candidatesText(c: Candidates): string {
  const lines: string[] = [];
  lines.push('RECAP AND REVIEW HEADLINES (source | published | title | url):');
  if (!c.articles.length) lines.push('(none found)');
  for (const a of c.articles) lines.push(`- ${a.source} | ${a.published ?? '?'} | ${a.title} | ${a.url}`);
  lines.push('');
  lines.push('SHOWS WATCHLIST BANDS PLAYED (from tape archives; artist | date | venue):');
  if (!c.shows.length) lines.push('(none found)');
  for (const s of c.shows) lines.push(`- ${s.artist} | ${s.date} | ${s.venue}`);
  return lines.join('\n');
}
