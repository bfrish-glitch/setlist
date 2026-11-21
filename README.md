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
    spotify.ts           PKCE login, Web API, Web Playback SDK + Spotify-app fallback
    placeholders.ts      Apple Music, Spotify, nugs.net, YouTube slots
    index.ts             Registry the player looks up by track.source
  player/engine.ts       Queue, next/prev, cross-source handoff, lock-screen controls
  store/playlists.ts     Playlists in localStorage + JSON export/import for sharing
  components/            Browse, Playlists, Queue, Services, Now Playing
```

Tracks from a service you haven't connected show dimmed and get skipped, so a shared playlist still plays for someone who only has some of the services.

## Status

| Service | Status | Notes |
|---|---|---|
| Relisten | ✅ Working | Open API, no login. Streams from archive.org / phish.in. |
| Apple Music | Parked | MusicKit JS. Needs an Apple Developer account ($99/yr) to sign tokens. Anyone with a subscription can use it. |
| Spotify | ✅ Built | Search, Liked Songs, your playlists. Plays in the browser via the Web Playback SDK; if that can't start (some iPhones), it drives the Spotify app instead. Premium required. Dev-mode apps are capped at **5 allowlisted users**, added in the Spotify dashboard under User Management. |
| nugs.net | Planned | No public API. Needs a small server that signs in for each person and fetches stream URLs. Against their ToS and can break when they change things. |
| YouTube | Maybe | IFrame player. The video has to stay visible and won't play with the phone locked. |

## Roadmap

1. **Spotify artist & album pages.** Tap into an artist (top songs, albums) or an album from search, then play or add the whole thing. Search is songs-only today, capped at 10 results by Spotify's dev mode.
2. **Cross-service search.** One search box that queries every connected service and shows results tagged by source.
3. **Shared playlists.** Move playlists from the browser into a small database so family members see the same lists. Until then, use *Share* to send a playlist file.
4. **nugs.net adapter** on the same small server.
5. **Auto-match.** When a track's service isn't connected, look up the same song on one you do have.
6. **YouTube** as a fallback for rare tracks.

**Parked:** **Apple Music.** Needs an Apple Developer account ($99/yr). Add a tiny serverless function (Cloudflare Worker or Vercel) that signs the MusicKit developer token, so the private key never lives in this repo.

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

Every push to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

**Never commit secrets.** Spotify client IDs are fine to publish. The Apple Music private key (`.p8`) and any nugs credentials go in server environment variables only.
