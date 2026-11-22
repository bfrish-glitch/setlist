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

/**
 * Split pasted text (one link, a list, or a whole email) into picks.
 * Paragraphs are read on their own: text lines attach to the next link as
 * its context (the curator's reason), and dated lines with no link become
 * text searches ("Goose 11/14/25 Chicago").
 */
export function splitInput(raw: string): { link?: string; text: string }[] {
  const out: { link?: string; text: string }[] = [];
  const seen = new Set<string>();
  const clean = (s: string) => s.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();

  for (const block of raw.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim());
    let pending: string[] = [];
    let last: { link?: string; text: string } | null = null;
    for (const line of lines) {
      const links = (line.match(URL_RE) ?? []).map((l) => l.replace(/[.,;:!?]+$/, ''));
      if (!links.length) {
        pending.push(line);
        continue;
      }
      const context = clean([...pending, line].join(' '));
      pending = [];
      for (const link of links) {
        if (seen.has(link)) continue;
        seen.add(link);
        last = { link, text: context };
        out.push(last);
      }
    }
    // Lines after the last link: dated ones are their own picks, the rest add context.
    for (const line of pending) {
      if (findDate(line) && line.trim().length < 200) out.push({ text: line.trim() });
      else if (last) last.text = clean(`${last.text} ${line}`);
    }
  }
  return out;
}
