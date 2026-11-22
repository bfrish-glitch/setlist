import { useEffect, useState } from 'react';
import type { Track } from '../types';
import { useGroup } from '../group/group';
import { addComment, deleteComment, loadComments, names, toggleFire, EMPTY_SOCIAL, type Comment } from '../social/social';

const Flame = ({ filled }: { filled: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 1 1 2 2 3 2 0-2-1-4 0-6z" />
  </svg>
);
const Bubble = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </svg>
);
const Ear = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
    <path d="M21 15a2 2 0 0 1-2 2h-1v-5h3zM3 15a2 2 0 0 0 2 2h1v-5H3z" />
  </svg>
);

const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' & ') : `${xs.slice(0, 2).join(', ')} +${xs.length - 2}`);

/** 🔥 / comments / listened row under a song in a shared playlist. */
export function SocialBar({ track, onComments }: { track: Track; onComments: () => void }) {
  const g = useGroup();
  if (!g || !track.social) return null;
  const s = track.social ?? EMPTY_SOCIAL;
  const mine = s.fire.includes(g.me.id);
  const fireNames = names(s.fire);
  const heard = names(s.listened);
  return (
    <div className="social">
      <button
        className={`social-btn ${mine ? 'on' : ''}`}
        onClick={() => void toggleFire(track)}
        aria-pressed={mine}
        aria-label={mine ? 'Remove your fire' : 'Fire this jam'}
      >
        <Flame filled={mine} />
        {s.fire.length > 0 && <span>{s.fire.length}</span>}
      </button>
      <button className="social-btn" onClick={onComments} aria-label={`Comments (${s.comments})`}>
        <Bubble />
        {s.comments > 0 && <span>{s.comments}</span>}
      </button>
      <span className="social-who">
        {fireNames.length > 0 && <span>{list(fireNames)} 🔥</span>}
        {heard.length > 0 && (
          <span className="heard" title={`Listened: ${heard.join(', ')}`}>
            <Ear /> {heard.length}
          </span>
        )}
      </span>
    </div>
  );
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

export function CommentsSheet({ track, onClose }: { track: Track; onClose: () => void }) {
  const g = useGroup();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadComments(track.key).then(setComments, (e) => setError(e.message));
  }, [track.key]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      setComments(await addComment(track.key, text));
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t post that');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet comments-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          {track.title}
          <div className="sub">
            {track.artist}
            {track.subtitle ? ` · ${track.subtitle}` : ''}
          </div>
        </div>
        <div className="comments">
          {!comments && !error && <div className="empty">Loading…</div>}
          {error && <div className="empty error">{error}</div>}
          {comments?.length === 0 && <div className="empty">No comments yet. Be the first: where does it peak?</div>}
          {comments?.map((c) => (
            <div key={c.id} className="comment">
              <span className="avatar">{c.name.slice(0, 1).toUpperCase()}</span>
              <div className="comment-body">
                <div className="comment-head">
                  <b>{c.memberId === g?.me.id ? 'You' : c.name}</b>
                  <span className="sub">{ago(c.at)}</span>
                  {(c.memberId === g?.me.id || g?.me.role === 'owner') && (
                    <button
                      className="link small-link"
                      onClick={async () => {
                        if (confirm('Delete this comment?')) setComments(await deleteComment(track.key, c.id));
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
                <div className="comment-text">{c.text}</div>
              </div>
            </div>
          ))}
        </div>
        <form className="comment-form" onSubmit={send}>
          <input
            placeholder="Add a comment… (“peaks at 14:00”)"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            aria-label="Your comment"
          />
          <button className="primary small" disabled={busy || !text.trim()}>
            Post
          </button>
        </form>
      </div>
    </div>
  );
}
