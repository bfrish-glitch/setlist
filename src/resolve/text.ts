/** Text helpers for matching shows and songs across services. */

/** Normalize a song title so "Tweezer >", "Tweezer (1)" and "tweezer" all compare equal. */
export function normTitle(s: string) {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // (1), [encore], (Live)
    .replace(/->|>|\*|#|~|%|\^/g, ' ') // segue and footnote marks
    // Track numbers: "01 ", "3. ", "d1t03 ". Leaves real titles like "46 Days" alone.
    .replace(/^\s*(0\d\s+|\d+[.)-]\s*|d\d+t\d+\s*|t\d+\s+)/i, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normArtist(s: string) {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string) {
  return new Set(s.split(' ').filter(Boolean));
}

/** 0..1 similarity between two normalized titles. */
export function titleScore(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // "Tweezer" vs "Tweezer Reprise" is close but not the same song.
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return 0.7;
  const A = tokens(a);
  const B = tokens(b);
  let both = 0;
  A.forEach((t) => B.has(t) && both++);
  return both / Math.max(A.size, B.size);
}

/**
 * Pair songs from one setlist with songs from another recording of the same
 * show. Walks both lists in order so a show with two "Tweezer"s pairs each
 * with the right one. Returns, for each `a` index, the matching `b` index.
 */
export function pairSetlists(a: string[], b: string[]): (number | null)[] {
  const na = a.map(normTitle);
  const nb = b.map(normTitle);
  const used = new Set<number>();
  let cursor = 0;
  return na.map((title) => {
    let best = -1;
    let bestScore = 0.6;
    // Prefer matches at or after the cursor (setlist order), then anywhere.
    for (const range of [
      [cursor, nb.length],
      [0, cursor],
    ]) {
      for (let j = range[0]; j < range[1]; j++) {
        if (used.has(j)) continue;
        const sc = titleScore(title, nb[j]);
        if (sc > bestScore) {
          best = j;
          bestScore = sc;
          if (sc === 1) break;
        }
      }
      if (best >= 0) break;
    }
    if (best < 0) return null;
    used.add(best);
    cursor = best + 1;
    return best;
  });
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const fullYear = (y: number) => (y < 100 ? (y > 50 ? 1900 + y : 2000 + y) : y);
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1950 && y <= 2100;

/**
 * Find a show date in free text and return it as YYYY-MM-DD.
 * Understands 2025-07-30, 2025/07/30, 7/30/25, 7.30.2025, July 30 2025, 30 Jul 2025.
 */
export function findDate(text: string): { date: string; match: string } | null {
  const t = text.toLowerCase();
  let m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t);
  if (m && valid(+m[1], +m[2], +m[3])) return { date: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, match: m[0] };
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(t);
  if (m) {
    const y = fullYear(+m[3]);
    if (valid(y, +m[1], +m[2])) return { date: `${y}-${pad(+m[1])}-${pad(+m[2])}`, match: m[0] };
  }
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1]) + 1;
    if (valid(+m[3], mo, +m[2])) return { date: `${m[3]}-${pad(mo)}-${pad(+m[2])}`, match: m[0] };
  }
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[2]) + 1;
    if (valid(+m[3], mo, +m[1])) return { date: `${m[3]}-${pad(mo)}-${pad(+m[1])}`, match: m[0] };
  }
  return null;
}

/** Normalize a date string from any service to YYYY-MM-DD, or null. */
export function toIsoDate(s: string | undefined | null): string | null {
  if (!s) return null;
  return findDate(s)?.date ?? null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export interface RawPick {
  link?: string;
  /** Everything we know in words: section heading + the line(s) about this pick. */
  text: string;
  /** Cleaned-up curator blurb to show on the song. */
  note?: string;
}

// Links we can play from, best first. Review/article links are used only for their date.
const LINK_RANK: [RegExp, number][] = [
  [/(^|\.)phish\.in$/, 1],
  [/(^|\.)relisten\.net$/, 1],
  [/(^|\.)archive\.org$/, 2],
  [/(^|\.)tapes\.kglw\.net$/, 2],
  [/(^|\.)nugs\.net$/, 3],
  [/(^|\.)livephish\.com$/, 4],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 5],
];
function linkRank(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\.|^m\./, '');
    return LINK_RANK.find(([re]) => re.test(host))?.[1] ?? 99;
  } catch {
    return 100;
  }
}

/** Strip link labels left behind once URLs are removed ("Listen on LivePhish () | JamBase review ()"). */
export function cleanNote(s: string) {
  let t = s
    .replace(URL_RE, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/^\s*[•*\-–]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop a trailing fragment that's just link labels: "…32 years. Listen on LivePhish JamBase review"
  const lastStop = Math.max(t.lastIndexOf('. '), t.lastIndexOf('." '), t.lastIndexOf('.” '));
  if (lastStop > 0) {
    const tail = t.slice(lastStop + 1).trim();
    if (tail.length < 90 && /\b(listen|stream|watch|tapes?|album|review|recap|youtube|bandcamp|nugs|livephish|link)\b/i.test(tail))
      t = t.slice(0, lastStop + 1).trim();
  }
  // The date and venue already show on the song, so don't repeat them in the note.
  t = t.replace(/^[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}:\s*[^.]{0,80}\.\s+/, '');
  return t;
}

/** Keep notes readable on a phone: whole sentences, roughly 300 characters max. */
export function shortNote(s: string | undefined, max = 300) {
  if (!s) return undefined;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('." '), cut.lastIndexOf('.” '));
  return stop > 80 ? cut.slice(0, stop + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

const isHeading = (line: string) => {
  const t = line.trim();
  return t.length > 0 && t.length <= 60 && !t.match(URL_RE) && !findDate(t) && !/[.:;!?]$/.test(t) && !/^[•*\-–]/.test(t);
};

/**
 * Split pasted text (one link, a list, or a whole email) into picks.
 * - Short lines with no date or link are section headings ("Phish") and give
 *   the following picks their artist.
 * - A line with links is one pick; the most playable link wins and review
 *   links are kept only as a fallback.
 * - A dated line with no link takes the links on the next line, or else
 *   becomes a text search ("Goose 11/14/25 Chicago").
 * - Everything after a "Sources:" line is ignored.
 */
export function splitInput(raw: string): RawPick[] {
  const out: RawPick[] = [];
  const seen = new Set<string>();
  let heading = '';
  let pendingDated: string | null = null;
  const flushPending = () => {
    if (pendingDated) out.push({ text: `${heading} ${pendingDated}`.trim(), note: cleanNote(pendingDated) });
    pendingDated = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushPending(); // a blank line ends whatever the previous pick was
      continue;
    }
    if (/^sources?:/i.test(line)) break;

    const links = (line.match(URL_RE) ?? []).map((l) => l.replace(/[.,;:!?]+$/, '')).filter((l) => !seen.has(l));
    if (!links.length) {
      if ((line.match(URL_RE) ?? []).length) continue; // only repeats of links we already used
      if (findDate(line) && line.length < 600) {
        flushPending();
        pendingDated = line;
      } else if (isHeading(line)) {
        flushPending();
        heading = line;
      } else if (pendingDated) {
        pendingDated = `${pendingDated} ${line}`; // "Why: the 30-minute Tweezer…"
      }
      continue;
    }

    links.forEach((l) => seen.add(l));
    const best = [...links].sort((a, b) => linkRank(a) - linkRank(b))[0];
    // A link line that brings no date of its own (ignoring dates inside the
    // URLs) belongs to the dated line above it.
    const lineDated = !!findDate(line.replace(URL_RE, ' '));
    const words = pendingDated && !lineDated ? `${pendingDated} ${line}` : line;
    if (pendingDated && lineDated) flushPending();
    pendingDated = null;
    out.push({ link: best, text: `${heading} ${words.replace(URL_RE, ' ')}`.replace(/\s+/g, ' ').trim(), note: cleanNote(words) });
  }
  flushPending();
  return out;
}

/** Tape filler that isn't a song: set/encore breaks, tuning, banter, crowd, intros. */
const NON_SONG =
  /\b(encore|set)\s*-?\s*break\b|^setbreak|^intermission|^tuning|banter|^crowd(\s+(noise|chatter))?$|applause|^(band\s+)?intro(duction)?s?$|^soundcheck|tape\s*(flip|change|cut)|^dead\s*air|^silence$|announcement|^pre-?show|^post-?show|^outro$|^encore$|^\W*$/i;
export const isNonSong = (title: string) => NON_SONG.test(title.trim());

/** The show's big jam when nobody named one: the longest real song; if no durations, the first real song. */
export function bestJamIndex(tracks: { title: string; durationSec?: number | null }[]) {
  let best = -1;
  tracks.forEach((t, i) => {
    if (isNonSong(t.title)) return;
    if (best < 0 || (t.durationSec ?? 0) > (tracks[best].durationSec ?? 0)) best = i;
  });
  return best < 0 ? 0 : best;
}
