# PawBook

A photo timeline, health tracker, and memory book for your dog(s) — installs
to your phone's home screen and works fully offline.

## What it does

- **Timeline** — log photos, notes, milestones, walks, vet visits, or
  vaccinations. Grouped by month, searchable, filterable by type, with an
  "On this day" callout for entries from past years.
- **Care reminders** — a banner surfaces any vaccination that's overdue or
  due within 30 days, based on the "next due date" you set when logging it.
  This is a passive, in-app reminder (checked whenever you open the app) —
  not a push notification, since that would need a backend PawBook
  intentionally doesn't have.
- **Weight** — log weigh-ins in kg, see a trend chart, current weight, and
  all-time range.
- **Profile** — name, breed, birthday (age shown automatically), a profile
  photo, walk stats (this week / all-time), a Health section for vet and
  vaccination history, and a "Year in review" recap.
- **Year in review** — pick any year and see total entries, walks, weight
  change, favorites, and milestones for that dog.
- **Backup & restore** — export everything (dogs, entries, weights, photos)
  to a single JSON file you keep yourself, and restore it later. Since
  storage is local-only, this is the only way your data survives a lost or
  replaced phone. Re-importing the same backup is safe and never duplicates.
- Supports multiple dogs, switchable from the top bar.
- Installable as a home-screen app (PWA), fully usable offline.

## How it stores your data

Everything lives **locally on your phone**, in the browser's IndexedDB —
no server, no account, nothing leaves your device unless you tap Export.
Photos are stored as a small thumbnail (grids/lists) plus a
capped-resolution version (full-screen view) rather than the original
camera file, to stay fast and well under storage limits.

**Because there's no sync, back up regularly** — especially before getting
a new phone. The Backup tab handles this in one tap.

## Getting it onto your phone

1. Create a new GitHub repo and upload all the files in this folder
   (`index.html`, `styles.css`, `app.js`, `db.js`, `helpers.js`, `media.js`,
   `backup.js`, `manifest.json`, `service-worker.js`, and the `icons/`
   folder).
2. In the repo's Settings → Pages, enable Pages from the main branch.
3. Open the resulting URL on your iPhone in **Safari** (must be Safari, not
   Chrome, for "Add to Home Screen" to install a proper standalone app on
   iOS).
4. Tap the Share icon → **Add to Home Screen**.
5. Open it from the home screen icon from now on.

If you already installed an earlier version, the update needs everyone's
open tab/instance of the app to be **fully closed** (not just backgrounded)
before the new version takes over — that's intentional, so an update never
interrupts something mid-use. Replace the files in your host, then fully
close and reopen the app.

Any static host (Netlify, Vercel, Cloudflare Pages, etc.) works the same
way — it just needs to serve these files over HTTPS.

## What I verified vs. what needs your eyes

**Actually tested, with real code execution — including one bug this
caught:**
- Every pure calculation (dates/timezones, ages, weight-chart math, care
  reminder windows, search/filter, walk totals, year-in-review aggregation)
  unit tested against hand-computed expected values, including edge cases
  (year boundaries, flat/single-point charts, overdue-vs-soon reminders).
- The full IndexedDB data layer run against a real IndexedDB implementation,
  including multi-dog isolation and sort order.
- The backup/restore pipeline run end-to-end — export, wipe the database
  (simulating a new phone), restore, and confirm every field and every
  photo's bytes come back byte-for-byte identical. Also confirmed
  re-importing the same backup twice doesn't duplicate anything.
- A full simulated-browser run through the actual app code (not a
  reimplementation): added a dog, logged an overdue vaccination and a walk,
  and confirmed the care banner, entry cards, search, type filters, profile
  stats, and year-in-review sheet all rendered correctly from real data.
  **This caught a real bug** — the database layer was silently dropping the
  walk/vaccination-specific fields (distance, duration, next-due-date) on
  save, because the original save function only knew about the original
  five field names. Fixed and re-verified.
- Also caught in review (not by a failing test, but by checking): the
  service worker's offline file list was missing two of the app's own
  script files since the first build, which would have broken offline use
  after install. Fixed.

**Not tested — no real browser/phone here, so please check on your device:**
- Actual look, feel, and layout on a real screen.
- Install behavior and offline behavior after a real "Add to Home Screen."
- The dog-profile photo picker's real-world feel (camera roll access, etc.)

If anything looks off, tell me specifically what you tapped and what
happened, and I'll fix it.

## Known simplifications

- No push notifications for care reminders — only shown when you open the
  app (see "Care reminders" above for why).
- Weight input is kg-only; lb shown as a converted reference.
- No search across dogs at once — search/filter is per-dog.
