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

### Phase 1: Group accounts + shared playlists
- Cloudflare D1 database on the existing Cloudflare account (free tier), served by the existing Worker.
- Invite link sign-in: one private link, pick a name, the device remembers you. Revocable.
- Playlists move from each browser into the database. Existing local playlists migrate on first sign-in.
- Track model upgraded to multi-source performances (above).

### Phase 2: YouTube + archive.org sources
- **YouTube** (IFrame player): needed for new-artist picks. The video has to stay visible and won't play with the phone locked, so YouTube tracks get flagged as "screen on."
- **archive.org**: play any archive.org recording directly from its link, for tapes Relisten hasn't indexed yet.
- **phish.in**: Relisten already uses it; links resolve straight to Relisten.
- **LivePhish**: parked. Separate subscription, and Relisten/phish.in covers the same Phish shows within about a day. Revisit if the group wants official soundboards.

### Phase 3: Link resolver + fallback matcher
- Paste any listen link (nugs, YouTube, archive.org, phish.in, Relisten) and get a playable show with its setlist.
- Then look for the same show on the *other* services by artist + date, so it plays for everyone.
- Fallback: when there's no link or it's dead, search by artist + date + venue.
- Review screen: everything that resolved, and a short "needs a fix" list with one-tap alternatives.

### Phase 4: Weekly email → This Week (automation)
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
