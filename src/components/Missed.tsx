import { bestJamIndex } from '../resolve/text';
import { useState } from 'react';
import type { Playlist, Track } from '../types';
import { resolvePick, type Pick } from '../resolve/resolve';
import { playlists } from '../store/playlists';
import { ensureFreeSource } from '../sources/ytsearch';
import { weeklyApi } from '../weekly/weekly';
import { fmt } from './common';

/**
 * "You missed one": the owner adds a show a run skipped. It goes into the week's
 * playlist and is saved as a calibration example for future runs.
 */
export function MissedSheet({ week, onClose }: { week: Playlist; onClose: () => void }) {
  const [show, setShow] = useState('');
  const [song, setSong] = useState('');
  const [why, setWhy] = useState('');
  const [found, setFound] = useState<Pick | null>(null);
  const [pickIdx, setPickIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    if (!show.trim()) return;
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const link = /^https?:\/\//.test(show.trim()) ? show.trim() : undefined;
      const text = [link ? '' : show, song ? `The highlight is "${song}".` : '', why].filter(Boolean).join(' ');
      const r = await resolvePick({ link, text: text || show, note: why || undefined });
      if (r.status !== 'ok' || !r.tracks.length) throw new Error(r.error || 'Couldn’t find that show. Try a link, or "Band 11/21 City".');
      setFound(r);
      setPickIdx(r.single ? 0 : (r.focus ?? longest(r.tracks)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t find that show');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!found) return;
    setBusy(true);
    setError(null);
    try {
      const t = found.tracks[pickIdx];
      const note = why.trim() || found.note || t.note;
      const track = await ensureFreeSource({ ...t, note });
      playlists.addTracks(week.id, [track]);
      await weeklyApi.missed({
        artist: found.artist,
        date: found.date ?? null,
        venue: found.venue ?? null,
        song: t.title,
        why: why.trim() || null,
        link: /^https?:\/\//.test(show.trim()) ? show.trim() : null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t add it');
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet missed-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          You missed one
          <div className="sub wrap">Adds it to {week.name} and teaches future runs what you count as a standout.</div>
        </div>
        <div className="missed-form">
          <label>
            <span>Show</span>
            <input
              value={show}
              onChange={(e) => {
                setShow(e.target.value);
                setFound(null);
              }}
              placeholder="Billy Strings 11/21 Worcester, or paste a link"
            />
          </label>
          <label>
            <span>
              Song <span className="sub">(optional)</span>
            </span>
            <input value={song} onChange={(e) => setSong(e.target.value)} placeholder="Thunder" />
          </label>
          <label>
            <span>
              Why it’s a standout <span className="sub">(this is what teaches it)</span>
            </span>
            <textarea
              rows={2}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              placeholder="Trey sat in for a 25-minute Thunder; every recap led with it"
            />
          </label>
          {error && <div className="empty error">{error}</div>}
          {found && (
            <div className="missed-found">
              <div>
                <b>{found.artist}</b>
                {found.date ? ` · ${found.date}` : ''}
                {found.venue ? ` · ${found.venue}` : ''}
              </div>
              {found.tracks.length > 1 ? (
                <select value={pickIdx} onChange={(e) => setPickIdx(+e.target.value)}>
                  {found.tracks.map((t: Track, i: number) => (
                    <option key={i} value={i}>
                      {t.title}
                      {t.durationSec ? ` (${fmt(t.durationSec)})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="sub">{found.tracks[0].title}</div>
              )}
              <div className="sub">Found on {found.foundOn.join(', ')}</div>
            </div>
          )}
          <div className="btns">
            {!found ? (
              <button className="primary" disabled={busy || !show.trim()} onClick={find}>
                {busy ? 'Looking…' : 'Find it'}
              </button>
            ) : (
              <button className="primary" disabled={busy} onClick={add}>
                {busy ? 'Adding…' : 'Add to this week'}
              </button>
            )}
            <button onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const longest = (tracks: Track[]) => bestJamIndex(tracks);
