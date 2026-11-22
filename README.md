# Setlist

One music player for every service you pay for (and the free ones), with playlists that mix sources song by song. Built for friends and family, not the public.

**Live app:** https://bfrish-glitch.github.io/setlist/ (on your phone, open it and use *Add to Home Screen*)

## How it works

Setlist never touches the audio from paid services. Each service plays through its own official player, and Setlist is the conductor: a playlist is just a list of `{ source, sourceId, title, … }` entries, and when one track ends the player hands off to whichever service owns the next one.

```
src/
  config.ts              Public config (Spotify client ID)
  types.ts               Track + Playlist shapes shared by everything
  sources/
    types.ts             SourceAdapter interface every service implements
    relisten.ts          Relisten API client + <audio> playback
    nugs.ts              nugs.net via the relay; tokens stay in the browser
    audio.ts             Shared <audio> element (keeps iOS playing between tracks)
    spotify.ts           PKCE login, Web API, Web Playback SDK + Spotify-app fallback
    placeholders.ts      Apple Music, Spotify, nugs.net, YouTube slots
    index.ts             Registry the player looks up by track.source
  player/engine.ts       Queue, next/prev, cross-source handoff, lock-screen controls
  store/playlists.ts     Playlists in localStorage + JSON export/import for sharing
  components/            Browse, Playlists, Queue, Services, Now Playing
worker/                  Cloudflare Worker relay for nugs.net (stateless)
```

Tracks from a service you haven't connected show dimmed and get skipped, so a shared playlist still plays for someone who only has some of the services.

## Status

| Service | Status | Notes |
|---|---|---|
| Relisten | ✅ Working | Open API, no login. Streams from archive.org / phish.in. |
| Apple Music | Parked | MusicKit JS. Needs an Apple Developer account ($99/yr) to sign tokens. Anyone with a subscription can use it. |
| Spotify | ✅ Built | Search, Liked Songs, your playlists. Plays in the browser via the Web Playback SDK; if that can't start (some iPhones), it drives the Spotify app instead. Premium required. Dev-mode apps are capped at **5 allowlisted users**, added in the Spotify dashboard under User Management. |
| nugs.net | ✅ Working | Search, artist shows, setlists, FLAC/AAC playback via the Cloudflare relay in `worker/`. Unofficial (mimics the nugs Android app), against their ToS, and will break when nugs changes things. |
| YouTube | Maybe | IFrame player. The video has to stay visible and won't play with the phone locked. |

## Roadmap

See **[ROADMAP.md](ROADMAP.md)**: the goal is a shared weekly playlist built automatically from a friend's weekly jams email.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173/setlist/
npm run build    # type-check + production build into dist/
```

### Spotify setup

1. Create an app at https://developer.spotify.com/dashboard (check **Web API** and **Web Playback SDK**).
2. Redirect URIs: `https://bfrish-glitch.github.io/setlist/` and, for local dev, `http://127.0.0.1:5173/setlist/` (Spotify rejects `localhost`; use the 127.0.0.1 address).
3. Put the Client ID in `src/config.ts`. It's public by design; there is no client secret.
4. Add each person under **User Management** (name + the email on their Spotify account). Max 5.

### nugs relay setup

The relay in `worker/` deploys to Cloudflare from `.github/workflows/worker.yml` on any change under `worker/`. It needs two repo secrets: `CLOUDFLARE_API_TOKEN` ("Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`. Its URL (`https://setlist-nugs.<subdomain>.workers.dev`) goes in `src/config.ts`. It stores nothing: passwords pass through to nugs once, and tokens live in each person's browser.

Every push to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

**Never commit secrets.** Spotify client IDs are fine to publish. The Apple Music private key (`.p8`) and any nugs credentials go in server environment variables only.
