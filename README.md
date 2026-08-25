# PawBook

A photo timeline, health tracker, and memory book for your dog(s) — installs
to your phone's home screen and works fully offline.

## What it does

- **Timeline** — log photos, notes, milestones, walks, vet visits, or
  vaccinations. Grouped by month, searchable, filterable by type, with an
  "On this day" callout for entries from past years.
- **Edit & delete entries** — tap any entry to edit it (date, caption, tags,
  photos, type-specific details) or delete it entirely. Deleting cleans up
  its photos from storage too.
- **Full-screen photo viewer** — tap any photo to see it at full resolution;
  swipe between photos in the same entry, with the image tracking your
  finger as you drag.
- **Auto date & location from photos** — when you add a photo, PawBook reads
  its embedded capture date and (if present) GPS location automatically.
  You can still edit the date yourself — once you do, it won't be
  overwritten. Location shows as a small 📍 that opens the spot in Maps.
- **Bulk import** — tap Import on the Timeline, pick a big batch of photos at
  once, and PawBook groups them into one entry per day automatically, with
  a review step before anything is saved.
- **Tag browser** — on the Profile tab, every tag you've used shows as a
  chip with a count; tap one to jump to the Timeline filtered to it.
- **Stats dashboard** — a dedicated tab showing entries logged per month
  (last 12 months), your longest daily logging streak, totals, and a
  breakdown by entry type.
- **Care reminders** — a banner surfaces any vaccination that's overdue or
  due within 30 days. Passive and in-app only (checked when you open the
  app) — not a push notification, since that needs a backend PawBook
  intentionally doesn't have.
- **Puppy vaccination schedule suggestions** — for a dog under ~2 years old
  with a birthday set, Profile offers a generic starting-point vaccination
  schedule calculated from their birthday. It is explicitly labeled as not
  veterinary advice, and every date is editable or skippable before
  anything is added.
- **Weight** — log weigh-ins in kg, see a trend chart, current weight, and
  all-time range.
- **Profile** — name, breed, birthday (age shown automatically), a profile
  photo, walk stats, a Health section, tag browser, and a "Year in review"
  recap.
- **Dark mode** — System / Light / Dark, in the Backup tab. "System" follows
  your OS setting live, including if you change it while the app is open.
- **Backup & restore** — export everything to a single JSON file you keep
  yourself, and restore it later. Since storage is local-only, this is the
  only way your data survives a lost or replaced phone. Re-importing the
  same backup never duplicates anything.
- Supports multiple dogs, switchable from the top bar.
- Installable as a home-screen app (PWA), fully usable offline.

## About photo formats (HEIC) and the date/location feature

iPhones shoot HEIC by default. Safari can decode HEIC, but only through a
specific API (`createImageBitmap`) — PawBook uses that path, with a fallback
for older browsers, so photos from your camera roll should process normally.

Separately, the EXIF *metadata* reader (date/GPS) only understands the JPEG
format specifically — this is a different thing from the HEIC photo-decoding
fix above. If a photo has no readable EXIF (HEIC that wasn't converted, a
screenshot, a re-saved image with metadata stripped), PawBook falls back to
the photo file's own last-modified date, and location just won't show.
Nothing is sent anywhere to read this — it's on-device only.

## How it stores your data

Everything lives **locally on your phone**, in the browser's IndexedDB — no
server, no account, nothing leaves your device unless you tap Export. Photos
are stored as a small thumbnail (grids/lists) plus a capped-resolution
version (full-screen view), not the original camera file.

**Because there's no sync, back up regularly** — especially after a big
bulk import. The Backup tab handles this in one tap.

## Getting it onto your phone

1. Create a new GitHub repo and upload all the files in this folder
   (`index.html`, `styles.css`, `app.js`, `db.js`, `helpers.js`, `media.js`,
   `exif.js`, `backup.js`, `manifest.json`, `service-worker.js`, and the
   `icons/` folder).
2. In the repo's Settings → Pages, enable Pages from the main branch.
3. Open the resulting URL on your iPhone in **Safari** (not Chrome — "Add to
   Home Screen" needs Safari for a proper standalone install on iOS).
4. Tap the Share icon → **Add to Home Screen**.
5. Open it from the home screen icon from now on.

If you already installed an earlier version: replace the files in your
host, then **fully close** every open instance of the app (not just
background it) and reopen it — updates deliberately wait for a clean
restart so they never interrupt something mid-use.

## What I verified vs. what needs your eyes

**Actually tested, with real code execution:**
- All new calculation logic (tag counting, monthly bucketing for the bar
  chart, longest-streak calculation, vaccination schedule date math) unit
  tested against hand-computed expected values, including edge cases (ties
  in tag counts, duplicate-day entries in the streak calculation, a 12-month
  window correctly excluding older entries).
- A full simulated-browser run through the actual app code exercising every
  new feature: added and then edited an entry (confirmed it updates in
  place rather than duplicating), deleted an entry, opened the full-screen
  photo viewer by tapping a photo (and confirmed that tap correctly does
  *not* also trigger the edit sheet — a real risk given both handlers live
  on overlapping elements), tapped a tag chip and confirmed it filters the
  timeline correctly, rendered the stats dashboard and confirmed the
  12-month bar chart, walked through the vaccination schedule sheet
  (skipped one of four suggested items, confirmed the other three were
  added with correct due dates and none more), and toggled dark mode and
  confirmed both the visual state and the saved preference.
- Re-checked ID references and confirmed no duplicate element IDs anywhere
  across the now-larger set of sheets/screens.

**Not tested — no real browser/phone here, so please check on your device:**
- The actual feel of the swipe gesture in the photo viewer — the logic is
  tested, but real touch physics (velocity, momentum) only show up on a
  real screen.
- Dark mode's actual visual appearance and contrast on a real display.
- Whether the puppy vaccination schedule's age cutoff (roughly under 2
  years) matches when you'd actually find it useful — easy to adjust if not.

## Known simplifications

- No push notifications for care reminders — only shown when you open the
  app.
- Weight input is kg-only; lb shown as a converted reference.
- Search/filter and the tag browser are per-dog, not across all dogs.
- Bulk import groups strictly by calendar day.
- The puppy vaccination schedule is a generic template (4 commonly-cited
  milestones), not tailored to breed, region, or vaccine brand — always
  meant to be adjusted against your actual vet's plan, not followed as-is.
