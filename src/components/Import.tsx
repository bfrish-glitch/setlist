import { PlayIcon } from './Icons';
import { bestJamIndex } from '../resolve/text';
import { useState, type ReactNode } from 'react';
import type { Track } from '../types';
import { resolvePick, type Pick } from '../resolve/resolve';
import { splitInput } from '../resolve/text';
import { player, usePlayer } from '../player/engine';
import { Header, SourceBadge, TrackRow } from './common';
import { ensureFreeSource } from '../sources/ytsearch';

/**
 * Paste anything (one link, several, a whole email, or "Phish 7/30/25")
 * and get back picks matched across services, with a highlight per show.
 */

type Choice = number | 'all'; // song index, or the full show

/** Longest song in the show: for jam bands that's almost always the big jam. */
const longest = (p: Pick) => bestJamIndex(p.tracks);

/**
 * What goes in the playlist when nobody picked: the song the email names,
 * else the longest song. Never the full show by default; that's a choice.
 */
function defaultChoice(p: Pick): Choice {
  if (p.single) return 0;
  return p.focus ?? longest(p);
}

function chosenTracks(p: Pick, c: Choice | undefined): Track[] {
  if (p.status !== 'ok' || !p.tracks.length) return [];
  const pickNote = p.note;
  const choice = c ?? defaultChoice(p);
  if (choice === 'all') return p.tracks.map((t, i) => (i === 0 && pickNote ? { ...t, note: pickNote } : t));
  const t = p.tracks[choice];
  return t ? [{ ...t, note: t.note ?? pickNote }] : [];
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>, each: (r: R, i: number) => void) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        each(await fn(items[i], i), i);
      }
    }),
  );
}

export function Import({ onAdd, switcher }: { onAdd: (t: Track[], suggestedName?: string) => void; switcher: ReactNode }) {
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<(Pick | null)[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const read = async (value = text) => {
    const inputs = splitInput(value);
    if (!inputs.length) {
      setNote('No links or dated shows found. Paste a link, or text like “Phish 7/30/25”.');
      return;
    }
    setNote(null);
    setBusy(true);
    setChoices({});
    setPicks(inputs.map(() => null));
    await pool(inputs, 3, (inp) => resolvePick(inp), (r, i) =>
      setPicks((prev) => {
        const next = [...prev];
        next[i] = r;
        return next;
      }),
    );
    setBusy(false);
  };

  const fix = async (index: number, input: string) => {
    const inp = splitInput(input)[0];
    if (!inp) return;
    setPicks((prev) => prev.map((p, i) => (i === index ? null : p)));
    const prev = picks[index];
    // Keep the email's heading/blurb so a bare link or date still knows the artist.
    const r = await resolvePick({ ...inp, text: `${prev?.context ?? ''} ${inp.text}`.trim(), note: prev?.note ?? inp.note });
    setPicks((prev) => prev.map((p, i) => (i === index ? r : p)));
  };

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setText(t);
      void read(t);
    } catch {
      /* clipboard blocked */
    }
  };

  const ok = picks.filter((p): p is Pick => p?.status === 'ok');
  const pending = picks.filter((p) => p === null).length;
  const selected = ok.flatMap((p) => chosenTracks(p, choices[p.id]));
  const failed = picks.filter((p) => p?.status === 'error').length;
  const dates = ok.map((p) => p.date).filter(Boolean).sort() as string[];
  const weekName = `Week of ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  return (
    <>
      <Header title="Add from links" />
      {switcher}
      <div className="import-box">
        <textarea
          placeholder={'Paste a link, a list of links, or a whole email.\nText like “Phish 7/30/25 MSG” works too.'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={picks.length ? 3 : 6}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="btns">
          <button type="button" onClick={paste}>
            Paste
          </button>
          <button className="primary" disabled={busy || !text.trim()} onClick={() => read()}>
            {busy ? 'Reading…' : 'Read'}
          </button>
          {picks.length > 0 && !busy && (
            <button
              onClick={() => {
                setPicks([]);
                setText('');
              }}
            >
              Clear
            </button>
          )}
        </div>
        {note && <div className="warn">{note}</div>}
      </div>

      {picks.length > 0 && (
        <div className="import-summary">
          <span>
            {pending ? `Looking up ${pending} more… · ` : ''}
            {ok.length} of {picks.length} found{failed ? ` · ${failed} need a fix` : ''}
            {selected.length ? ` · ${selected.length} song${selected.length > 1 ? 's' : ''} selected` : ''}
          </span>
          <div className="btns">
            <button className="primary" disabled={!selected.length || pending > 0} onClick={() => player.playQueue(selected, 0)}>
              <PlayIcon size={14} /> Play
            </button>
            <button
              disabled={!selected.length || pending > 0}
              onClick={async () => {
                // Songs only on nugs/Spotify get a YouTube backup so the whole group can play them.
                const withBackups = await Promise.all(selected.map((t) => ensureFreeSource(t)));
                onAdd(withBackups, dates.length ? weekName : undefined);
              }}
            >
              {pending ? 'Wait for all cards…' : `+ Add ${selected.length} song${selected.length === 1 ? '' : 's'} to playlist`}
            </button>
          </div>
        </div>
      )}

      {picks.map((p, i) =>
        p === null ? (
          <div key={i} className="pick loading">Looking it up…</div>
        ) : (
          <PickCard
            key={p.id}
            pick={p}
            choice={choices[p.id]}
            onChoose={(c) => setChoices((prev) => ({ ...prev, [p.id]: c }))}
            onFix={(input) => fix(i, input)}
          />
        ),
      )}
    </>
  );
}

function PickCard(props: { pick: Pick; choice?: Choice; onChoose: (c: Choice) => void; onFix: (input: string) => void }) {
  const { pick: p } = props;
  const [open, setOpen] = useState(false);
  const [fixText, setFixText] = useState('');
  const { queue, index } = usePlayer();
  const now = queue[index]?.key;

  if (p.status === 'error') {
    return (
      <div className="pick error">
        <div className="pick-head">
          <span className="status-dot bad" />
          <span className="track-text">
            <span className="title">Needs a fix</span>
            <span className="sub wrap">{p.error}</span>
          </span>
        </div>
        <div className="sub wrap mono">{p.input}</div>
        {p.note && <div className="pick-note">“{p.note}”</div>}
        <form
          className="fix-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (fixText.trim()) props.onFix(fixText);
          }}
        >
          <input placeholder="Another link, or “Artist M/D/YY”" value={fixText} onChange={(e) => setFixText(e.target.value)} />
          <button className="small" disabled={!fixText.trim()}>
            Try
          </button>
        </form>
      </div>
    );
  }

  const choice: Choice = props.choice ?? defaultChoice(p);
  const guessed = p.focus == null && !p.single;
  const reach = new Set(p.foundOn);

  return (
    <div className="pick">
      <div className="pick-head">
        <span className={`status-dot ${reach.has('relisten') || reach.has('archive') || reach.has('youtube') ? 'good' : 'mid'}`} />
        <span className="track-text">
          <span className="title">
            {p.artist}
            {p.date ? ` · ${p.date}` : ''}
          </span>
          <span className="sub">
            {p.foundOn.map((s) => (
              <SourceBadge key={s} track={{ source: s }} />
            ))}{' '}
            {p.single ? p.tracks[0]?.title : p.venue}
          </span>
        </span>
      </div>
      {p.note && <div className="pick-note">“{p.note}”</div>}
      {!reach.has('relisten') && !reach.has('archive') && !reach.has('youtube') && (
        <div className="warn">Only on {p.foundOn.join(', ')}, so friends without it will skip this one.</div>
      )}
      {!p.single && (
        <div className="pick-choose">
          <label>In playlist:</label>
          <select value={String(choice)} onChange={(e) => props.onChoose(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">Full show ({p.tracks.length} songs)</option>
            {p.tracks.map((t, i) => (
              <option key={t.key} value={i}>
                {i === p.focus ? '★ ' : guessed && i === longest(p) ? '☆ ' : ''}
                {t.title}
                {guessed && i === longest(p) ? ' (longest, a guess)' : ''}
              </option>
            ))}
          </select>
          <button className="link" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Setlist'}
          </button>
        </div>
      )}
      {guessed && props.choice == null && (
        <div className="sub wrap">The email doesn’t name a song, so this is the longest jam. Change it if you know better.</div>
      )}
      {(open || p.single) && (
        <div className="list">
          {p.tracks.map((t, i) => (
            <TrackRow
              key={t.key}
              track={t}
              index={p.single ? undefined : i}
              active={now === t.key || (choice !== 'all' && i === choice)}
              onPlay={() => player.playQueue(p.tracks, i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
