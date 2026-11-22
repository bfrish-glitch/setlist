import { useState } from 'react';
import { appUrl, setOwnSpotifyClientId, usingOwnSpotifyApp } from '../config';
import { sources } from '../sources';

/** Walks a friend through registering their own Spotify app, past the shared app's 5-person cap. */
export function OwnSpotify({ toast }: { toast: (m: string) => void }) {
  const [id, setId] = useState('');
  const own = usingOwnSpotifyApp();
  const redirect = appUrl();

  const apply = async (next: string | null) => {
    // A sign-in belongs to one app, so switching apps signs out of Spotify here.
    await Promise.resolve(sources.spotify.disconnect?.()).catch(() => {});
    setOwnSpotifyClientId(next);
    setId('');
    toast(next ? 'Saved. Now tap Connect on Spotify.' : 'Back on the shared Spotify app. Tap Connect.');
  };

  return (
    <details className="own-spotify">
      <summary className="sub">{own ? 'Using your own Spotify app' : 'Spotify full? Use your own Spotify app (free, about 3 minutes)'}</summary>
      <ol className="sub wrap">
        <li>
          Open{' '}
          <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
            developer.spotify.com/dashboard
          </a>
          , sign in with your Spotify account (needs Premium) and tap <b>Create app</b>.
        </li>
        <li>
          Name it anything. For <b>Redirect URI</b>, paste exactly:
          <span className="copy-row">
            <code>{redirect}</code>
            <button className="link small-link" type="button" onClick={() => navigator.clipboard.writeText(redirect).then(() => toast('Copied'), () => {})}>
              Copy
            </button>
          </span>
        </li>
        <li>
          Tick <b>Web API</b> and <b>Web Playback SDK</b>, agree to the terms, and save.
        </li>
        <li>Open the app’s Settings, copy the <b>Client ID</b>, and paste it here:</li>
      </ol>
      <form
        className="own-form"
        onSubmit={(e) => {
          e.preventDefault();
          const v = id.trim();
          if (!/^[0-9a-f]{32}$/i.test(v)) return toast('That doesn’t look like a Client ID (32 letters and numbers).');
          void apply(v);
        }}
      >
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Client ID" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button className="small primary" disabled={!id.trim()}>
          Save
        </button>
      </form>
      {own && (
        <button className="link small-link" onClick={() => void apply(null)}>
          Go back to the shared app
        </button>
      )}
    </details>
  );
}
