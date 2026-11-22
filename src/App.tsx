import { useEffect, useState } from 'react';
import type { Track } from './types';
import { Browse } from './components/Browse';
import { Playlists } from './components/Playlists';
import { Queue } from './components/Queue';
import { Services } from './components/Services';
import { NowPlaying } from './components/NowPlaying';
import { AddToPlaylist } from './components/AddToPlaylist';
import { handleSpotifyRedirect, spotify } from './sources/spotify';
import { youtube } from './sources/youtube';
import { NugsLogin } from './components/NugsLogin';
import { JoinSheet } from './components/GroupSheets';
import { takeInviteFromUrl } from './group/group';

type Tab = 'browse' | 'playlists' | 'queue' | 'services';
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'browse', label: 'Browse', icon: '◉' },
  { id: 'playlists', label: 'Playlists', icon: '≣' },
  { id: 'queue', label: 'Queue', icon: '☰' },
  { id: 'services', label: 'Services', icon: '⚙' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('browse');
  const [adding, setAddingState] = useState<{ tracks: Track[]; name?: string } | null>(null);
  const setAdding = (tracks: Track[], name?: string) => setAddingState({ tracks, name });
  const [toast, setToast] = useState<string | null>(null);
  const [nugsLogin, setNugsLogin] = useState(false);
  const openNugsLogin = () => setNugsLogin(true);
  // undefined = closed, null = creating the group, string = joining with that invite code
  const [joining, setJoining] = useState<string | null | undefined>(() => takeInviteFromUrl() ?? undefined);

  // Finish a Spotify login if we just came back from accounts.spotify.com.
  useEffect(() => {
    void handleSpotifyRedirect().then((msg) => {
      if (msg) {
        setToast(msg);
        if (msg === 'Spotify connected') setTab('browse');
      }
      void spotify.warmUp();
    });
    // Load the YouTube player in the background so the first video starts fast.
    const t = setTimeout(() => youtube.warmUp(), 3000);
    return () => clearTimeout(t);
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
        {tab === 'services' && <Services onNugsLogin={openNugsLogin} onStartGroup={() => setJoining(null)} toast={setToast} />}
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
          tracks={adding.tracks}
          suggestedName={adding.name}
          onClose={(msg) => {
            setAddingState(null);
            if (msg) setToast(msg);
          }}
        />
      )}
      {joining !== undefined && (
        <JoinSheet
          invite={joining}
          onClose={(msg) => {
            setJoining(undefined);
            if (msg) {
              setToast(msg);
              setTab(joining === null ? 'services' : 'playlists');
            }
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
