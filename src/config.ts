/**
 * Public app config. Nothing here is secret: a Spotify client ID is designed
 * to ship in browser code (PKCE login, no client secret).
 */
// Paste the Client ID from developer.spotify.com/dashboard here.
const SPOTIFY_CLIENT_ID_DEFAULT = '';
export const SPOTIFY_CLIENT_ID: string = import.meta.env.VITE_SPOTIFY_CLIENT_ID || SPOTIFY_CLIENT_ID_DEFAULT;

/** Where Spotify sends people back after login. Must match the dashboard exactly. */
export const appUrl = () => new URL(import.meta.env.BASE_URL, window.location.origin).toString();
