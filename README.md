# PawBook

A photo & video timeline, health tracker, and memory book for your dog(s) —
installs to your phone's home screen and works fully offline.

## What it does

- **Timeline** — photos, videos, notes, milestones, walks, vet visits, or
  vaccinations. Grouped by month, searchable, filterable by type, with an
  "On this day" callout.
- **Search across all dogs** — a toggle appears once you have 2+ dogs,
  switching search from "this dog" to everyone at once, with a dog-name
  badge on each result so you can tell them apart.
- **Edit & delete entries** — tap any entry to edit it, or delete it.
  Deleting is now **undoable**: it moves to Recently Deleted (in the Backup
  tab) for 30 days, with an "Undo" button right on the confirmation toast.
- **Full-screen viewer** — tap a photo or video to see it full-size, swipe
  between items, share any of them straight from the viewer.
- **Share a memory or a year recap** — a share button in the photo viewer
  composites the photo with its caption and date into a single image (or
  shares a video as-is); a share button on the Year in Review sheet
  generates a standalone summary card. Both use your device's native share
  sheet where available, or save the image for you to share manually.
- **Weight tracking with goals** — log weigh-ins, see a trend chart, and
  optionally set a target weight range per dog — the chart shades the
  target band and shows whether the latest weight is within, above, or
  below it.
- **App Lock** — an optional PIN (in the Backup tab), hashed and never
  stored in plaintext, shown on launch and whenever you return to the app.
  This is a basic privacy deterrent, not encryption — see below.
- **Bulk import with duplicate detection** — pick a big batch of photos and
  videos at once; PawBook hashes each file's actual content (not its name)
  and automatically skips anything you've already imported — even under a
  different filename — both against your existing library and duplicates
  within the same batch.
- **Auto date & location from photos, auto date from videos**; **tag
  browser**; **stats dashboard**; **care reminders**; **puppy vaccination
  schedule suggestions**; **year in review**; **dark mode**;
  **backup/restore** — all still present from earlier rounds, unaffected by
  this update (re-verified below).
- Supports multiple dogs, switchable from the top bar. Installable as a
  home-screen app (PWA), fully usable offline.

## About App Lock

This adds a PIN prompt, hashed with SHA-256 before it's stored (never in
plaintext) — but it is **not encryption**. Your dogs' data in IndexedDB is
not otherwise protected if someone has direct access to this device's app
storage; App Lock is meant to stop a casual glance at your unlocked phone
from landing on your timeline, not to withstand real forensic access.
Losing your PIN with no way to recover it isn't a risk here, since there's
nothing to "recover" — data isn't encrypted with it, so if you forget it,
removing and re-setting it in the Backup tab (once you're back in — or by
clearing this site's data, which also clears everything else) is the reset
path. Choose a PIN you'll actually remember.

## About Recently Deleted

Deleting an entry now moves it to a 30-day holding area instead of removing
it immediately — restore it anytime from Backup → Recently Deleted, or
delete it permanently right away if you're sure. After 30 days it's cleaned
up automatically (photos/videos included) the next time you open the app.

## How it stores your data

Everything lives **locally on your phone**, in the browser's IndexedDB — no
server, no account, nothing leaves your device unless you tap Export or
Share. Photos are stored as a thumbnail plus a capped-resolution full
version; videos are stored as-is (up to 200MB) plus a small poster
thumbnail.

**Back up regularly** — especially after a big bulk import or adding
videos. The Backup tab handles this in one tap, and everything (including
video, target weights, and soft-deleted-but-not-yet-purged entries staying
as active data until purged) round-trips through export/restore.

## Getting it onto your phone

1. Create a new GitHub repo and upload all the files in this folder
   (`index.html`, `styles.css`, `app.js`, `db.js`, `helpers.js`, `media.js`,
   `exif.js`, `video-meta.js`, `backup.js`, `manifest.json`,
   `service-worker.js`, and the `icons/` folder).
2. In the repo's Settings → Pages, enable Pages from the main branch.
3. Open the resulting URL on your iPhone in **Safari** (not Chrome).
4. Tap the Share icon → **Add to Home Screen**.
5. Open it from the home screen icon from now on.

If you already installed an earlier version: replace the files, then
**fully close** every open instance of the app (not just background it)
and reopen it.

## What I verified vs. what needs your eyes

**Actually tested, with real code execution:**
- Duplicate detection: confirmed a photo re-selected under a **completely
  different filename** is still correctly caught (proving it's real
  content hashing, not name matching), confirmed a duplicate picked twice
  within the *same* bulk selection is caught too, confirmed genuinely
  different photos are never falsely flagged, and confirmed the final
  stored-photo and entry counts are exactly right afterward — no phantom
  entries, no duplicate storage.
- Found the same field-whitelist bug **a fourth time**, this time in
  `backup.js`'s export/restore — it would have silently dropped
  `contentHash` (and anything else added later) on every backup. Fixed the
  same way as the previous three times, and re-verified the full
  export → wipe → restore round trip still preserves everything correctly.
- Every new calculation (weight-target chart scaling — including when the
  target range falls entirely outside the actual weight data, tag counting,
  trash-expiry boundaries) unit tested against hand-computed values.
- Found and fixed **the same design flaw for a third time**: `Dogs.add` had
  the same hand-maintained field whitelist that had already caused real
  bugs twice before in this build (entries, then photos). Fixed the same
  way, before it could bite again — this is what let the weight-target
  fields "just work."
- The full soft-delete lifecycle (delete → undo from the toast → delete
  again → restore from Recently Deleted → permanently delete) run through
  the real app code end to end.
- App Lock's actual hash-and-compare logic: confirmed the stored value is a
  64-character SHA-256 hex hash (never the PIN itself), confirmed a wrong
  PIN is rejected with an error, confirmed a correct PIN unlocks, and
  confirmed the lock reappears on returning to the app.
- Cross-dog search with two real dogs and entries under each: confirmed
  single-dog search stays scoped correctly, confirmed the all-dogs toggle
  finds entries from both, and confirmed the dog-name badge appears
  correctly on each result.
- The share feature's image generation was rendered with a **real canvas
  library** (not a stub) and the actual output images were visually
  inspected — including catching and fixing a real sizing bug where a
  normal-length caption ("Beach day at Bondi with the whole crew") was
  being truncated unnecessarily; verified against several realistic caption
  lengths after the fix. The recap-card and video-share paths were also
  confirmed end-to-end through the real app code, including the fallback
  to a plain download when the Web Share API isn't available.
- One test run for photo-sharing specifically hit the same jsdom
  Blob/IndexedDB testing-tool quirk documented earlier in this build (not
  an app bug) — isolated it again, confirmed it was the same known cause,
  and separately verified the sharing logic itself against a real Blob to
  close the loop.
- Re-ran the full existing regression suite (care reminders, stats
  dashboard, weight screen, backup tab) to confirm none of this broke
  anything already working.

**Not tested — no real browser/phone here, so please check on your device:**
- The actual native share sheet UI and how it looks sharing to Messages/
  Photos/etc.
- App Lock's real-world feel — whether re-locking every single time you
  background the app (vs. a grace period) feels right for how you use it.
- The visual polish of the generated share-card images at real photo sizes
  on an actual screen.

## Known simplifications

- Duplicate detection matches exact byte-for-byte content — a photo that's
  been edited, re-compressed, or re-saved by another app (even slightly)
  will have different bytes and won't be caught as a duplicate. It also
  only works going forward: photos and videos already in your library from
  before this feature don't have a content hash recorded, so duplicates of
  *those specific* existing items won't be caught (anything newly added
  will be, including against each other).
- App Lock is a deterrent, not encryption (see above).
- No push notifications for care reminders — only shown when you open the
  app.
- Videos aren't compressed; stored as picked, up to 200MB.
- The puppy vaccination schedule is a generic template, not veterinary
  advice.
- Weight input is kg-only; lb shown as a converted reference.
- Bulk import groups strictly by calendar day.
