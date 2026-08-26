// video-meta.js — reads the creation date embedded in MP4/MOV container
// metadata. This is the video equivalent of exif.js's JPEG date reading,
// but a completely different (box-based, ISOBMFF) format.
//
// Unlike a JPEG, a video file can be hundreds of MB, and the metadata we
// need (inside a box called 'moov' -> 'mvhd') can in principle be anywhere
// in the file. Reading the whole file into memory just to find a few dozen
// bytes of metadata would be wasteful and slow on a phone, especially
// during a bulk import processing many videos in a row. So this only reads
// a bounded prefix of the file (PREFIX_BYTES) via File.slice() — which
// covers "fast-start" exports (moov placed near the beginning, common for
// video meant to be streamed/previewed quickly, and requested explicitly
// when generating the test file this was verified against). If moov isn't
// within that prefix, this gives up and returns null rather than reading
// the entire file — the caller falls back to the file's own last-modified
// timestamp, the same fallback already used for photos with no EXIF.

const PREFIX_BYTES = 8 * 1024 * 1024; // 8MB — generous for a moov box, cheap to read
const MAC_EPOCH_OFFSET_SECONDS = 2082844800; // seconds between 1904-01-01 and 1970-01-01 (Unix epoch)

function readBoxType(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// Walks sibling boxes starting at `start`, up to `end` (exclusive), calling
// visit(type, contentStart, contentEnd) for each fully-contained box.
// Stops silently (does not throw) the moment a box's declared size would
// run past `end` — we simply don't have enough of the file read to look
// further at that point.
function walkBoxes(view, start, end, visit) {
  let offset = start;
  while (offset + 8 <= end) {
    let boxSize = view.getUint32(offset, false);
    const boxType = readBoxType(view, offset + 4);
    let headerSize = 8;

    if (boxSize === 1) {
      // 64-bit extended size follows immediately after the type.
      if (offset + 16 > end) return; // not enough buffered to read it
      const hi = view.getUint32(offset + 8, false);
      const lo = view.getUint32(offset + 12, false);
      // Extremely unlikely to matter for a moov box, but guard against
      // sizes bigger than we could ever address in this buffer anyway.
      boxSize = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (boxSize === 0) {
      // Box extends to end of file — we don't know the true end within a
      // bounded prefix read, so treat everything remaining as its content.
      boxSize = end - offset;
    }

    const contentStart = offset + headerSize;
    const contentEnd = offset + boxSize;
    if (contentEnd > end) return; // box isn't fully within what we've read

    visit(boxType, contentStart, contentEnd);
    offset = contentEnd;
  }
}

function parseMvhd(view, contentStart) {
  const version = view.getUint8(contentStart);
  // 3 bytes of flags follow the version byte, then creation_time.
  const creationTimeOffset = contentStart + 4;
  const macSeconds = version === 1 ? Number(view.getBigUint64(creationTimeOffset, false)) : view.getUint32(creationTimeOffset, false);

  if (!macSeconds) return null;
  const unixMs = (macSeconds - MAC_EPOCH_OFFSET_SECONDS) * 1000;
  if (!Number.isFinite(unixMs) || unixMs <= 0) return null;

  const d = new Date(unixMs);
  const y = d.getFullYear();
  // Sanity bound — a corrupt/garbage timestamp shouldn't produce a wildly
  // implausible date silently treated as real.
  if (y < 1990 || y > 2100) return null;

  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function findCreationDate(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const end = view.byteLength;
  let found = null;

  walkBoxes(view, 0, end, (type, contentStart, contentEnd) => {
    if (found) return;
    if (type === 'moov') {
      walkBoxes(view, contentStart, contentEnd, (innerType, innerStart) => {
        if (found) return;
        if (innerType === 'mvhd') {
          try {
            found = parseMvhd(view, innerStart);
          } catch (err) {
            found = null; // malformed mvhd — treat exactly like "not found"
          }
        }
      });
    }
  });

  return found;
}

async function parseVideoCreationDate(file) {
  try {
    const prefix = file.slice(0, Math.min(PREFIX_BYTES, file.size));
    const buf = await prefix.arrayBuffer();
    return findCreationDate(buf);
  } catch (err) {
    console.warn('Video date read failed, continuing without it:', err);
    return null;
  }
}

const api = { parseVideoCreationDate, findCreationDate };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.VideoMeta = api;
}
