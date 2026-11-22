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
| How picks arrive | Forward the friend's email to Setlist |
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

### Phase 4: Weekly email → This Week (automation)

What the real email looks like (checked Nov 21): plain text, section headings per artist ("Phish", "Billy Strings", "King Gizzard…", "New to your radar"), one bullet per show starting with the date ("Oct 6, 2026: Venue…"), the blurb, then labelled links in parentheses. Listen links vary: LivePhish (Phish), JamBase recaps only (Billy Strings, no direct nugs URL), Gizz Tapes (tapes.kglw.net/<date>), YouTube/Bandcamp for new artists, and a trailing "Sources:" list. The importer now handles all of this: 7/7 picks on the real email, with highlights pulled from cues like "41:43", "26-minute", "is the jam highlight".

- **Needs a domain** (about $10/yr through Cloudflare). Cloudflare can only receive email on a domain you own, not on workers.dev. Bonus: the app gets a real address too.
- Friend (or Barry) auto-forwards the email to an address like `week@yourdomain`.
- The Worker pulls every listen link out of the email, plus the text next to each one (date, venue, the "why").
- It picks the highlight jam by matching song titles from the show's setlist against the "why" line. Otherwise it defaults to the full show.
- Posts **Week of <date>** and tells the group.
- Optional tweak to the friend's prompt that makes this bulletproof: add *"name the standout song for each show"* to his routine.
- Plan B if parsing his email proves flaky: switch to Setlist running its own copy of the prompt through the Claude API, asking for structured output (needs an Anthropic API key, well under $1/week).

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
1. **Domain:** OK to buy one (~$10/yr) for email forwarding? Any name in mind?
2. **Who forwards:** will the friend add a forward rule, or does the email come to Barry first?
3. **Sample email:** need one real email to build the parser against.
