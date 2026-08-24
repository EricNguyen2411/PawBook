# PawBook

A photo timeline, health tracker, and memory book for your dog(s) — installs
to your phone's home screen and works fully offline.

## What it does

- **Timeline** — log photos, notes, milestones, walks, vet visits, or
  vaccinations. Grouped by month, searchable, filterable by type, with an
  "On this day" callout for entries from past years.
- **Auto date & location from photos** — when you add a photo, PawBook reads
  its embedded capture date and (if present) GPS location automatically and
  fills them in for you. You can still edit the date yourself — once you do,
  it won't be overwritten. Location shows as a small 📍 on the entry that
  opens the spot in Maps.
- **Bulk import** — tap Import on the Timeline, pick a big batch of photos at
  once, and PawBook reads each one's date and groups them into one entry per
  day automatically. Review the dates (each is editable) and skip any day
  you don't want, then import them all in one go. Built for exactly the
  "I've had my dogs for years and have a lot to add" situation.
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
- **Backup & restore** — export everything (dogs, entries, weights, photos)
  to a single JSON file you keep yourself, and restore it later. Since
  storage is local-only, this is the only way your data survives a lost or
  replaced phone. Re-importing the same backup is safe and never duplicates.
- Supports multiple dogs, switchable from the top bar.
- Installable as a home-screen app (PWA), fully usable offline.

## About photo formats (HEIC)

iPhones shoot HEIC by default. Safari can actually decode HEIC, but only
through a specific API (`createImageBitmap`) — the more common approach of
loading a photo into an `<img>` tag doesn't reliably work for HEIC in
Safari even though the browser supports the format. PawBook uses the
correct path, with an automatic fallback to the older approach for browsers
that lack it, so photos straight from your camera roll should process
normally without needing to change your camera's photo format settings.

## About the photo date/location feature

This reads standard EXIF metadata that cameras and phones embed in JPEG
photos — no upload, no external service, entirely on-device. A few honest
limits:

- **EXIF date/location specifically needs JPEG.** This is a separate thing
  from the HEIC photo-decoding fix above — PawBook can now turn a HEIC photo
  into a usable thumbnail either way, but the *metadata reader* only
  understands the JPEG EXIF format. Practically, this mainly matters for
  photos edited or re-saved in a way that strips metadata, or shared from
  outside the Photos app. If a photo genuinely has no readable EXIF,
  PawBook falls back to the photo file's own last-modified date, which is
  usually close but not guaranteed exact — and it's always editable before
  you save.
- **Location only shows if the photo has it.** Many people have location
  services off for their camera, or strip it before sharing — that's normal,
  and those photos just won't show the 📍.
- Nothing is sent anywhere to read this — it's just reading bytes already in
  the file, entirely offline, the same as reading the caption you type.

## How it stores your data

Everything lives **locally on your phone**, in the browser's IndexedDB —
no server, no account, nothing leaves your device unless you tap Export.
Photos are stored as a small thumbnail (grids/lists) plus a
capped-resolution version (full-screen view) rather than the original
camera file, to stay fast and well under storage limits.

**Because there's no sync, back up regularly** — especially before getting
a new phone, and especially after a big bulk import. The Backup tab handles
this in one tap.

## Getting it onto your phone

1. Create a new GitHub repo and upload all the files in this folder
   (`index.html`, `styles.css`, `app.js`, `db.js`, `helpers.js`, `media.js`,
   `exif.js`, `backup.js`, `manifest.json`, `service-worker.js`, and the
   `icons/` folder).
2. In the repo's Settings → Pages, enable Pages from the main branch.
3. Open the resulting URL on your iPhone in **Safari** (must be Safari, not
   Chrome, for "Add to Home Screen" to install a proper standalone app on
   iOS).
4. Tap the Share icon → **Add to Home Screen**.
5. Open it from the home screen icon from now on.

If you already installed an earlier version: replace the files in your
host, then **fully close** every open instance of the app (not just
background it) and reopen it — updates deliberately wait for a clean
restart so they never interrupt something mid-use.

Any static host (Netlify, Vercel, Cloudflare Pages, etc.) works the same
way — it just needs to serve these files over HTTPS.

## What I verified vs. what needs your eyes

**Actually tested, with real code execution:**
- The EXIF parser (hand-written, no external library, so this got real
  scrutiny) run against real JPEGs with known embedded date and GPS data,
  generated with a Python EXIF-writing library — confirmed byte-exact date
  and coordinate extraction, in both big-endian and little-endian byte
  order (hand-built a little-endian test file specifically, since that
  path wasn't exercised by the standard tool's output). Also tested against
  photos with no EXIF, date-only EXIF, garbage/non-JPEG input, and a
  truncated file — all handled without throwing.
- The full bulk-import flow run through the real app code: photos with
  different dates grouped correctly into separate entries, a no-EXIF photo
  correctly fell back to its file timestamp, skipping a group during review
  cleaned up its photos from storage, confirming created exactly the right
  entries, and — importantly — cancelling a bulk import partway through
  cleans up every already-processed photo rather than leaving orphans.
- The single-entry flow's auto-fill behavior: confirmed a photo's EXIF date
  fills the date field, and confirmed that once you've typed your own date,
  a subsequently-added photo does *not* silently overwrite it.
- Re-ran the full existing test suite (dates, ages, weight chart, care
  reminders, search/filter, walk stats, year recap, the IndexedDB layer,
  and backup/restore) to confirm none of this broke anything already
  working.
- Along the way, fixed a design flaw from earlier: entry fields were being
  saved through a hand-maintained whitelist, which had already silently
  dropped new fields once before. It's now save-everything-provided by
  default, so adding `location` (and anything in the future) can't
  reintroduce that bug.

**Not tested — no real browser/phone here, so please check on your device:**
- How a real bulk import feels with genuinely large batches (dozens to
  hundreds of real phone photos) — processing time and memory behavior on
  an actual device, not just the correctness of the logic.
- The HEIC decoding fix above (switching to `createImageBitmap`) is a
  documented, well-supported fix for a known Safari limitation, and I
  verified the surrounding resize math with real numbers — but I can't
  actually run Safari or decode a real HEIC file here, so this is reasoned
  from documentation rather than confirmed on-device. If photos still fail
  to process after this update, tell me what phone/iOS version and whether
  it's every photo or specific ones, and I'll dig further.

## Known simplifications

- No push notifications for care reminders — only shown when you open the
  app.
- Weight input is kg-only; lb shown as a converted reference.
- No search across dogs at once — search/filter is per-dog.
- Bulk import groups strictly by calendar day; multiple entries can't be
  split out of one day automatically (edit the date per group before
  importing if you want a photo to land on its own).
