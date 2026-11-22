import { useState } from 'react';
import { group } from '../group/group';
import { playlists } from '../store/playlists';

/** Shown when someone opens an invite link, or when the first person sets up the group. */
export function JoinSheet({ invite, onClose }: { invite: string | null; onClose: (msg?: string) => void }) {
  const creating = invite === null;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLocal = playlists.all().some((p) => p.tracks.length > 0) && !playlists.isShared();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (creating) await group.create(name);
      else await group.join(invite!, name);
      const moved = hasLocal ? await playlists.migrateLocal() : 0;
      onClose(
        creating
          ? 'Group created. Share the invite link from Services.'
          : `Welcome in, ${name.trim()}${moved ? `. Moved your ${moved} playlist${moved > 1 ? 's' : ''} into the group` : ''}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <form className="sheet form-sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="sheet-title">{creating ? 'Start your Setlist group' : 'Join the Setlist group'}</div>
        <div className="form-body">
          <p className="fine">
            {creating
              ? 'You’ll be the owner. Afterward you get an invite link to send your friends.'
              : 'Pick the name your friends will see next to the songs you add.'}
          </p>
          <input
            autoFocus
            placeholder="Your name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {hasLocal && (
            <p className="fine">The playlists on this phone will move into the group so everyone can see them.</p>
          )}
          {error && <div className="form-error">{error}</div>}
          <button className="primary pill-btn" disabled={busy || !name.trim()}>
            {busy ? 'One sec…' : creating ? 'Create group' : 'Join'}
          </button>
        </div>
      </form>
    </div>
  );
}
