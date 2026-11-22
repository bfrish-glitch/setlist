import type { Track } from '../types';
import { playlists, usePlaylists } from '../store/playlists';

export function AddToPlaylist({ tracks, onClose, suggestedName }: { tracks: Track[]; onClose: (msg?: string) => void; suggestedName?: string }) {
  const all = usePlaylists();
  const what = tracks.length === 1 ? `“${tracks[0].title}”` : `${tracks.length} tracks`;

  const addTo = (id: string, name: string) => {
    playlists.addTracks(id, tracks);
    onClose(`Added ${what} to ${name}`);
  };
  const createNew = () => {
    const name = prompt('New playlist name', suggestedName ?? '');
    if (name == null) return;
    const p = playlists.create(name, tracks);
    onClose(`Added ${what} to ${p.name}`);
  };

  return (
    <div className="sheet-backdrop" onClick={() => onClose()}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">Add {what} to…</div>
        <button className="row nav" onClick={createNew}>
          <span className="title accent">+ New playlist{suggestedName ? ` (“${suggestedName}”)` : ''}</span>
        </button>
        {all.map((p) => (
          <button key={p.id} className="row nav" onClick={() => addTo(p.id, p.name)}>
            <span className="title">{p.name}</span>
            <span className="meta">{p.tracks.length}</span>
          </button>
        ))}
        <button className="cancel" onClick={() => onClose()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
