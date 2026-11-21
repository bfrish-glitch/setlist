import { useEffect, useState } from 'react';
import type { Track } from './types';
import { Browse } from './components/Browse';
import { Playlists } from './components/Playlists';
import { Queue } from './components/Queue';
import { Services } from './components/Services';
import { NowPlaying } from './components/NowPlaying';
import { AddToPlaylist } from './components/AddToPlaylist';
import { handleSpotifyRedirect, spotify } from './sources/spotify';
import { NugsLogin } from './components/NugsLogin';

type Tab = 'browse' | 'playlists' | 'queue' | 'services';
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'browse', label: 'Browse', icon: '◉' },
  { id: 'playlists', label: 'Playlists', icon: '≣' },
  { id: 'queue', label: 'Queue', icon: '☰' },
  { id: 'services', label: 'Services', icon: '⚙' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('browse');
  const [adding, setAdding] = useState<Track[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [nugsLogin, setNugsLogin] = useState(false);
  const openNugsLogin = () => setNugsLogin(true);

  // Finish a Spotify login if we just came back from accounts.spotify.com.
  useEffect(() => {
    void handleSpotifyRedirect().then((msg) => {
      if (msg) {
        setToast(msg);
        if (msg === 'Spotify connected') setTab('browse');
      }
      void spotify.warmUp();
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="app">
      <main>
        {/* Keep Browse mounted so you don't lose your place when switching tabs. */}
        <div hidden={tab !== 'browse'}>
          <Browse onAdd={setAdding} onNugsLogin={openNugsLogin} />
        </div>
        {tab === 'playlists' && <Playlists />}
        {tab === 'queue' && <Queue onAdd={setAdding} />}
        {tab === 'services' && <Services onNugsLogin={openNugsLogin} />}
      </main>
      <footer>
        <NowPlaying />
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              <span className="tab-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </footer>
      {adding && (
        <AddToPlaylist
          tracks={adding}
          onClose={(msg) => {
            setAdding(null);
            if (msg) setToast(msg);
          }}
        />
      )}
      {nugsLogin && (
        <NugsLogin
          onClose={(msg) => {
            setNugsLogin(false);
            if (msg) setToast(msg);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
