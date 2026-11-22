import { useEffect, useState } from 'react';
import type { Track } from './types';
import { Browse } from './components/Browse';
import { ThisWeek } from './components/ThisWeek';
import { Playlists } from './components/Playlists';
import { Queue } from './components/Queue';
import { Services } from './components/Services';
import { NowPlaying } from './components/NowPlaying';
import { AddToPlaylist } from './components/AddToPlaylist';
import { handleSpotifyRedirect, spotify } from './sources/spotify';
import { youtube } from './sources/youtube';
import { NugsLogin } from './components/NugsLogin';
import { JoinSheet } from './components/GroupSheets';
import { group, takeDeviceCodeFromUrl, takeInviteFromUrl } from './group/group';
import { autoPublishIfReady } from './weekly/weekly';
import { reloadToLatest, useUpdateAvailable } from './update';

type Tab = 'week' | 'browse' | 'playlists' | 'queue' | 'services';

const Icon = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

// Queue isn't a tab any more: tap the song in the player bar to open it.
const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'week', label: 'This Week', icon: 'M4 7h16v10H4zM8 7v10M16 11h0' },
  { id: 'browse', label: 'Browse', icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4' },
  { id: 'playlists', label: 'Playlists', icon: 'M4 6h12M4 12h12M4 18h8M19 15v6M16 18h6' },
  { id: 'services', label: 'Friends', icon: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 .5 3 2.5 3 5' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('week');
  const [adding, setAddingState] = useState<{ tracks: Track[]; name?: string } | null>(null);
  const setAdding = (tracks: Track[], name?: string) => setAddingState({ tracks, name });
  const [toast, setToast] = useState<string | null>(null);
  const [nugsLogin, setNugsLogin] = useState(false);
  const updateAvailable = useUpdateAvailable();
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

  // Opened a "use on another device" link: sign this device in as that person.
  useEffect(() => {
    const code = takeDeviceCodeFromUrl();
    if (!code) return;
    void group.redeemDevice(code).then(
      (me) => {
        setToast(`Signed in as ${me.name} on this device`);
        setTab('playlists');
      },
      (e) => setToast(e instanceof Error ? e.message : 'That device link didn’t work'),
    );
  }, []);

  // When the server has finished this week's picks, the first app to open builds the playlist.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible' || !group.signedIn()) return;
      void autoPublishIfReady((m) => setToast(m)).then((m) => m && setToast(m));
    };
    const t = setTimeout(check, 2500);
    document.addEventListener('visibilitychange', check);
    const unsub = group.subscribe(check);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', check);
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="app">
      {updateAvailable && (
        <button className="update-bar" onClick={reloadToLatest}>
          A new version of Setlist is ready. Tap to update.
        </button>
      )}
      <main>
        {tab === 'week' && <ThisWeek onGoServices={() => setTab('services')} />}
        {/* Keep Browse mounted so you don't lose your place when switching tabs. */}
        <div hidden={tab !== 'browse'}>
          <Browse onAdd={setAdding} onNugsLogin={openNugsLogin} />
        </div>
        {tab === 'playlists' && <Playlists />}
        {tab === 'queue' && <Queue onAdd={setAdding} />}
        {tab === 'services' && (
          <Services
            onNugsLogin={openNugsLogin}
            onStartGroup={() => setJoining(null)}
            onJoinCode={(code) => setJoining(code)}
            toast={setToast}
          />
        )}
      </main>
      <footer>
        <NowPlaying onOpenQueue={() => setTab('queue')} />
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
              <span className="tab-icon">
                <Icon d={t.icon} />
              </span>
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
