# Setlist roadmap

## The goal

A friend's Claude routine emails the week's best live music: one or two standout shows each from **Billy Strings, Phish and King Gizzard & the Lizard Wizard**, plus one or two **new artists**, each with a one-line reason and a working listen link (nugs.net, YouTube, archive.org, LivePhish).

Setlist turns that email into a shared **This Week** playlist for a small group of friends:

- The email gets forwarded to Setlist, which builds the week automatically.
- By default the playlist holds the **highlight jam** from each pick. Tap a show to play the whole thing.
- Everyone signs in with their own Setlist name and connects whichever services they have. Each song plays from the best source *that person* can use, so friends with no subscriptions can still play nearly everything through Relisten.

## Decisions so far

| Question | Decision |
|---|---|
| Playlist contents | Highlight jam per pick, full show one tap away |
| How picks arrive | Now: paste the email into Browse → 🔗 Links. Next: Setlist finds the picks itself every week (Phase 4), no email needed |
| Sign-in | Private invite link + pick a name, no passwords |
| Curation | Auto-publish the email's picks; friends can add their own finds |
| Group size | No hard assumption. Spotify's 5-person cap barely matters since most of this music isn't on Spotify |

## Core idea: a song is a performance, not a service

Today a playlist entry points at exactly one service. Going forward, an entry is the **performance**, for example *Phish, Tweezer, 2025-07-30, MSG*, with every playable source attached:

```
{ artist, title, date, venue,
  sources: [ {relisten…}, {nugs…}, {youtube…}, {archive…} ] }
```

Each listener's player picks the first source they can play, in their own preferred order. This one change is what makes a shared playlist work for a group with mixed subscriptions.

## Phases

### Phase 1: Group accounts + shared playlists ✅
- Cloudflare D1 database on the existing Cloudflare account (free tier), served by the existing Worker.
- Invite link sign-in: one private link, pick a name, the device remembers you. Revocable.
- Playlists move from each browser into the database. Existing local playlists migrate on first sign-in.
- Track model upgraded to multi-source performances (above).

### Phase 2: YouTube + archive.org sources ✅
- **YouTube** (IFrame player): needed for new-artist picks. The video has to stay visible and won't play with the phone locked, so YouTube tracks get flagged as "screen on."
- **archive.org**: play any archive.org recording directly from its link, for tapes Relisten hasn't indexed yet.
- **phish.in**: Relisten already uses it; links resolve straight to Relisten.
- **Add from link** (Browse → 🔗 Link): paste YouTube, archive.org, phish.in, Relisten or nugs links. A head start on Phase 3.
- **LivePhish**: parked. Separate subscription, and Relisten/phish.in covers the same Phish shows within about a day. Revisit if the group wants official soundboards.

### Phase 3: Link resolver + fallback matcher ✅
- Paste any listen link (nugs, YouTube, archive.org, phish.in, Relisten) and get a playable show with its setlist.
- Then look for the same show on the *other* services by artist + date, so it plays for everyone.
- Fallback: when there's no link or it's dead, search by artist + date + venue.
- Review screen: everything that resolved, and a short "needs a fix" list with one-tap alternatives.
- Built: Browse → 🔗 Links takes one link, many, a whole email, or text like "Phish 7/30/25". Highlight jam comes from the link (phish.in/…/tweezer) or the curator's text ("the 30-minute Tweezer"); a picker overrides it. Songs carry every source found; dated YouTube uploads play from the matched audio (Relisten/nugs) with the video as backup. Playlist songs get a ≣ Full show button and show the curator's note.
- Note for Phase 4: nugs matching uses the importing person's nugs sign-in. A server-side import can match Relisten/archive/YouTube on its own; nugs alternates get added when someone with nugs opens the week.

### Phase 3.5: More sources so fewer songs go missing (research done Nov 21)
Research findings: Relisten already matches phish.in for Phish (new shows in about 2 days). Billy Strings tapes reach archive.org within 1–3 days but not every show gets one (10/10 Everett exists only on nugs). KGLW tapes take 1–2 weeks.
1. **archive.org search** (S): find tapes by collection + date (`BillyStrings`, `KingGizzardAndTheLizardWizard`) or `creator:` for other bands, before Relisten indexes them.
2. **Gizz Tapes API** (S): `tapes.kglw.net/api/v1/shows/<date>.json`. More KGLW recordings than Relisten, labeled SBD/AUD, clean setlists. Prefer recordings whose ID contains the show date (one mislabeled item seen).
3. **YouTube search** (M): YouTube Data API v3, 100 searches/day free. Search once at import time, cache the video, and review matches. This catches nugs-only shows and emerging artists. Needs a Google API key, kept on the server.
4. **Bandcamp embed** (S–M): for emerging bands and KGLW official bootlegs. Play-only iframe (no auto-advance control).
- Skipped: phish.in direct (same as Relisten), LivePhish (subscription, no API), SoundCloud/Mixcloud/Audiomack (no jam content, closed APIs), keyless YouTube scraping (against ToS).
- Reality: a show that exists only on nugs plays only for people with nugs, unless a YouTube copy exists.

### Phase 4: Setlist curates the week itself (replaces the email)
The friend's prompt moves into Setlist. Once a week the server researches the week's standout shows and new artists, then builds **Week of <date>** with the highlight jams. Nobody pastes anything.

- **Weekly schedule:** a Cloudflare cron trigger on the existing Worker (e.g. Monday 8am ET).
- **The research:** Claude API with web search, using the friend's prompt as the starting point. It asks for **structured output** (artist, date, venue, highlight song, why, listen links) instead of an email, so nothing has to be parsed.
- **Matching:** the picks run through the same resolver as the Links screen (Relisten, nugs, archive.org, YouTube, plus whatever the sources research adds), so each song carries every source found.
- **Editable prompt:** an owner-only screen in the app to edit the prompt, the band list ("Phish, Billy Strings, King Gizzard"), how many new artists, and the day it runs. Refine it over time without touching code.
- **Draft vs publish:** default is auto-publish. Optional "draft first" setting so the owner can glance at the picks before the group sees them.
- **Run now:** a button to generate this week's list on demand (handy while tuning the prompt).
- **Needs:** an Anthropic API key, stored as a Cloudflare secret, never in the repo. Rough cost: well under $1 a week (a few dozen web searches plus model usage). Estimate to confirm once built.
- **Open design question:** the resolver runs in the browser today, and nugs matching needs a person's nugs login. Options: run Relisten/archive/YouTube matching on the server and let the owner's phone add nugs sources the next time it opens, or store the owner's nugs refresh token on the server. Decide when we build it.
- Paste-the-email stays as a manual fallback.

### Phase 5: The friends layer
- Home screen built around **This Week**, with past weeks archived below.
- The curator's one-liner shown on each pick.
- 🔥 reactions and short comments per song; "who's listened."
- "New week is up" push notification (works on iPhone for home-screen web apps).
- Running **All-time favorites** built from reactions.
- Friends' own adds, tagged with who added them.

### Later
- Spotify artist and album pages (search is songs-only today, capped at 10 results).
- Cross-service search box.
- Apple Music (needs an Apple Developer account, $99/yr).
- LivePhish adapter.

## Open questions
1. **Anthropic API key** for Phase 4 (pay-as-you-go at console.anthropic.com).
2. **nugs on the server** for Phase 4: owner's phone fills in nugs sources, or store a nugs token server-side?
3. **Prompt v2:** refine the friend's prompt once the in-app version runs (more bands? fewer picks? song-level highlights required).
