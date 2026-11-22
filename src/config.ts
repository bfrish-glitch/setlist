/**
 * Public app config. Nothing here is secret: a Spotify client ID is designed
 * to ship in browser code (PKCE login, no client secret).
 */
// Paste the Client ID from developer.spotify.com/dashboard here.
const SPOTIFY_CLIENT_ID_DEFAULT = '2e15c2be1c93454d914e0499b4bea914';
export const SPOTIFY_CLIENT_ID: string = import.meta.env.VITE_SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID_DEFAULT;

/**
 * Spotify caps each developer app at 5 people, so a friend can register their
 * own app (free, a few minutes) and paste its Client ID here. Per device.
 */
const OWN_SPOTIFY_KEY = 'setlist.spotifyClientId';
const readOwn = () => {
  try {
    return localStorage.getItem(OWN_SPOTIFY_KEY) || '';
  } catch {
    return '';
  }
};
export const spotifyClientId = () => readOwn() || SPOTIFY_CLIENT_ID;
export const usingOwnSpotifyApp = () => !!readOwn();
export function setOwnSpotifyClientId(id: string | null) {
  try {
    if (id) localStorage.setItem(OWN_SPOTIFY_KEY, id.trim());
    else localStorage.removeItem(OWN_SPOTIFY_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Where Spotify sends people back after login. Must match the dashboard exactly. */
export const appUrl = () => new URL(import.meta.env.BASE_URL, window.location.origin).toString();

/**
 * Setlist's server (worker/ in this repo, deployed to Cloudflare): the nugs
 * relay plus the friends group and shared playlists.
 * Format: https://setlist-nugs.<your-subdomain>.workers.dev
 */
const NUGS_RELAY_DEFAULT = 'https://setlist-nugs.bfrish.workers.dev';
export const NUGS_RELAY: string = (import.meta.env.VITE_NUGS_RELAY || NUGS_RELAY_DEFAULT).replace(/\/$/, '');
export const SERVER = NUGS_RELAY;
