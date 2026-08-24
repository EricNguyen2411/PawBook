# PawBook

A photo timeline, weight tracker, and memory book for your dog(s) — installs
to your phone's home screen and works fully offline.

## What it does

- **Timeline** — log photos, notes, or milestones with a date, caption, and
  tags. Grouped by month, with an "On this day" callout for entries from
  past years.
- **Weight** — log weigh-ins in kg, see a trend chart, current weight, and
  all-time range.
- **Profile** — name, breed, birthday (age shown automatically), and a
  collected view of milestones + favorited entries.
- Supports multiple dogs, switchable from the top bar.
- Installable as a home-screen app (PWA) and fully usable with no internet
  connection once installed.

## How it stores your data

Everything is stored **locally on your phone**, in the browser's IndexedDB —
there's no server, no account, and no data leaves your device. This means:

- It's private by construction.
- If you get a new phone, this data does **not** come with you automatically —
  there's no sync. If that becomes important later, this can be added (e.g.
  with Firebase) without changing the app's structure much.
- Photos are stored as two versions: a small thumbnail (for grids/lists) and
  a capped-resolution version (for full-screen viewing) — not the original
  camera file — to keep things fast and keep you well under browser storage
  limits.

## Getting it onto your phone

The simplest path is free static hosting via GitHub Pages:

1. Create a new GitHub repo and upload all the files in this folder
   (`index.html`, `styles.css`, `app.js`, `db.js`, `helpers.js`, `media.js`,
   `manifest.json`, `service-worker.js`, and the `icons/` folder).
2. In the repo's Settings → Pages, enable Pages from the main branch.
3. Open the resulting `https://yourname.github.io/reponame/` URL on your
   iPhone in **Safari** (must be Safari, not Chrome, for "Add to Home
   Screen" to install a proper standalone app on iOS).
4. Tap the Share icon → **Add to Home Screen**.
5. Open it from the home screen icon from now on — that's the installed app.

Any other static host (Netlify, Vercel, Cloudflare Pages, etc.) works the
same way — it just needs to serve these files over HTTPS.

## What I verified vs. what needs your eyes

Being direct about this, per how I approach builds like this:

**Actually tested, with real code execution:**
- Date/timezone handling — confirmed local dates don't shift across
  timezones (a very common silent bug).
- Age calculation, "on this day" matching, kg↔lb conversion — unit tested
  against hand-computed expected values.
- Weight chart math — tested including edge cases (single data point, all
  weights identical) that are easy to accidentally divide-by-zero on.
- The full IndexedDB data layer — run against a real IndexedDB
  implementation (not just read), including a two-dog scenario confirming
  entries never leak across dogs, sort order, and delete behavior.
- HTML structure — checked for duplicate IDs and correct script load order.
- The app icon — actually rendered to PNG and viewed, not just assumed
  correct from the SVG code.
- One real platform gotcha caught and fixed: I'd initially added a
  `capture` attribute to the photo input, which I confirmed (via
  documented iOS Safari behavior) forces the camera directly and hides
  the "Photo Library" option — removed, since picking existing photos is
  the main flow.

**Not tested — I don't have a real browser here, so please check these on
your phone once installed:**
- The actual look and feel, animations, and layout on a real screen.
- The full add-photo → save → see it in the timeline flow end to end.
- Install behavior and offline behavior after a real "Add to Home Screen."

If anything looks off once you've got it installed, tell me specifically
what you're seeing (what you tapped, what happened vs. what you expected)
and I'll fix it — that kind of concrete report is much more useful to me
than "the timeline is broken."

## Known simplifications (easy to extend later)

- No per-dog profile photo yet (shows initials instead) — the data model
  already has a slot for it, just needs a small UI addition.
- Single unit (kg) for weight input; lb is shown as a converted reference
  only.
- No search/filter across entries yet.
