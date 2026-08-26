# PawBook

A photo & video timeline, health tracker, and memory book for your dog(s) —
installs to your phone's home screen and works fully offline.

## What it does

- **Timeline** — log photos, videos, notes, milestones, walks, vet visits,
  or vaccinations. Grouped by month, searchable, filterable by type, with
  an "On this day" callout for entries from past years.
- **Videos** — add a video the same way as a photo. PawBook generates a
  thumbnail from a frame partway into the clip, shows a ▶ badge on it in
  the timeline and picker, and plays it back with native controls in the
  full-screen viewer. Videos over 200MB aren't accepted (trim first) — this
  protects the app's storage and backups, not a codec limitation.
- **Edit & delete entries** — tap any entry to edit it (date, caption, tags,
  photos/videos, type-specific details) or delete it entirely.
- **Full-screen viewer** — tap a photo or video to see it full-size; swipe
  between photos in the same entry (videos use their own native controls
  instead, plus ‹ › buttons that work for both).
- **Auto date & location from photos, auto date from videos** — adding a
  photo reads its embedded EXIF date (and GPS location, if present) and
  fills in the entry's date automatically. Adding a video reads its
  container metadata (a completely different format from photo EXIF, but
  serves the same purpose) for its own capture date. Either way, once you
  edit the date yourself, it won't be overwritten.
- **Bulk import** — tap Import on the Timeline, pick a big batch of photos
  *and videos* at once, and PawBook reads each one's real date and groups
  everything into one entry per day, with a review step (adjustable dates,
  skippable days) before anything is saved.
- **Tag browser**, **stats dashboard**, **care reminders**, **puppy
  vaccination schedule suggestions**, **weight tracking**, **year in
  review**, **dark mode**, and **backup/restore** — see previous notes;
  all still present and unaffected by this update.
- Supports multiple dogs, switchable from the top bar.
- Installable as a home-screen app (PWA), fully usable offline.

## About video dates specifically

Photos carry their capture date in a format called EXIF; videos use a
completely different one (inside the MP4/MOV file's own container
structure, in a part called the `moov`/`mvhd` box). PawBook reads this
directly — no library, on-device only — but only from a bounded portion
near the start of the file, rather than loading the whole video into memory
just to find a few dozen bytes of metadata. This covers the common case
(metadata placed early in the file) but not every possible video encoding.
If a video's date can't be read this way, PawBook falls back to the video
file's own last-modified timestamp — same fallback already used for photos
with no EXIF — and the date is always editable before you save either way.

## How it stores your data

Everything lives **locally on your phone**, in the browser's IndexedDB — no
server, no account, nothing leaves your device unless you tap Export.
Photos are stored as a small thumbnail plus a capped-resolution full
version. Videos are stored as-is (no client-side compression — that would
need much heavier tooling than fits this app's offline-first,
dependency-free approach), plus a small poster-frame thumbnail for grids.

**Videos take up meaningfully more space than photos.** Back up regularly,
especially after adding video-heavy entries — the Backup tab handles this
in one tap, and video is included in both export and restore.

## Getting it onto your phone

1. Create a new GitHub repo and upload all the files in this folder
   (`index.html`, `styles.css`, `app.js`, `db.js`, `helpers.js`, `media.js`,
   `exif.js`, `video-meta.js`, `backup.js`, `manifest.json`,
   `service-worker.js`, and the `icons/` folder).
2. In the repo's Settings → Pages, enable Pages from the main branch.
3. Open the resulting URL on your iPhone in **Safari** (not Chrome — "Add
   to Home Screen" needs Safari for a proper standalone install on iOS).
4. Tap the Share icon → **Add to Home Screen**.
5. Open it from the home screen icon from now on.

If you already installed an earlier version: replace the files in your
host, then **fully close** every open instance of the app (not just
background it) and reopen it.

## What I verified vs. what needs your eyes

**Actually tested, with real code execution:**
- The video date parser, written from scratch (no library), tested against
  **real MP4 and MOV files generated with ffmpeg** with known creation
  dates set — confirmed byte-exact date extraction for both formats, plus
  defensive handling of garbage input, truncated data, and metadata that
  sits beyond the bounded prefix this reads (falls back cleanly rather than
  reading the whole file or crashing).
- The video size cap and its error message.
- The exact same design flaw I'd already found and fixed once for timeline
  entries (a hand-maintained field whitelist silently dropping new fields)
  was still present in the photo/video storage layer — found it before it
  could bite, and fixed it the same way.
- A full simulated-browser run through the real app code: added a video
  entry and confirmed its date auto-filled from real, ffmpeg-generated
  video metadata; confirmed the play badge appears in both the picker and
  the timeline; confirmed the full-screen viewer correctly shows a
  `<video>` element (not an image) for a video entry; confirmed editing an
  entry preserves its video; confirmed bulk import correctly groups a mix
  of photos and videos by each file's own real date; and confirmed the
  video's mediaType and blob presence survive a full backup export.
- The full backup/restore round trip for video specifically — export, wipe
  the database, restore — verified against the real MP4 bytes, confirming
  they come back **byte-for-byte identical**, the same guarantee already
  established for photos. (One test run hit a compatibility quirk between
  two of my *testing tools* — not the app — which I isolated and confirmed
  before re-running the check in a way that avoided it; noting this in the
  interest of being precise about what was and wasn't actually verified.)
- Re-ran the full existing regression suite (plain photo entries, care
  reminders, stats dashboard) to confirm none of this broke anything
  already working.

**Not tested — no real browser/phone here, so please check on your device:**
- Actual video recording/picking and playback on a real iPhone — the logic
  is tested, but real camera files, real Safari video decoding, and real
  touch interaction with native video controls only show up on a real
  device.
- Whether your specific videos' metadata falls within the portion of the
  file this reads — if a video's date doesn't auto-fill, it'll fall back to
  the file's last-modified date, which you can just edit.

## Known simplifications

- No push notifications for care reminders — only shown when you open the
  app.
- Videos aren't compressed or transcoded — stored as picked, up to 200MB.
- Video date reading only checks a bounded portion of large files, not the
  entire file.
- Weight input is kg-only; lb shown as a converted reference.
- Search/filter and the tag browser are per-dog, not across all dogs.
- Bulk import groups strictly by calendar day.
- The puppy vaccination schedule is a generic template, not veterinary
  advice — always meant to be adjusted against your actual vet's plan.
