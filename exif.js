// exif.js — a minimal, dependency-free EXIF reader. Pulls just two things
// out of a JPEG's EXIF block: the original capture date/time, and GPS
// coordinates, if present. No library, so the app stays fully offline —
// this is genuinely small once you're only after two tags.
//
// Only JPEGs carry EXIF in the form parsed here. HEIC/HEIF (the default
// iPhone camera format) uses a completely different container (ISOBMFF)
// that this does not parse — see the caller for the fallback behavior.
// If the browser or OS has converted the picked file to JPEG (which iOS
// Safari commonly does when photos are shared out of the Photos app),
// this works normally.

function readString(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// EXIF DateTimeOriginal is formatted 'YYYY:MM:DD HH:MM:SS'. We only need
// the date part, and we want it as 'YYYY-MM-DD' to match the rest of the
// app's date format (see helpers.js parseLocalDate).
function exifDateToLocalDateStr(exifDateStr) {
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(exifDateStr || '');
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function dmsToDecimal(d, m, s, ref) {
  let dec = d + m / 60 + s / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return dec;
}

// Reads one IFD (Image File Directory) starting at `offset` (relative to
// tiffStart). Returns a Map of tag -> {type, count, valueOffset} where
// valueOffset is the absolute byte offset of the value (already resolved
// whether it was stored inline or via a pointer).
function readIFD(view, tiffStart, offset, little) {
  const entries = new Map();
  const count = view.getUint16(offset, little);
  const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  for (let i = 0; i < count; i++) {
    const entryOffset = offset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, little);
    const type = view.getUint16(entryOffset + 2, little);
    const numValues = view.getUint32(entryOffset + 4, little);
    const size = (TYPE_SIZES[type] || 1) * numValues;

    let valueAbsOffset;
    if (size <= 4) {
      valueAbsOffset = entryOffset + 8; // stored inline within the entry
    } else {
      const pointer = view.getUint32(entryOffset + 8, little);
      valueAbsOffset = tiffStart + pointer;
    }

    entries.set(tag, { type, count: numValues, offset: valueAbsOffset });
  }

  return { entries };
}

function readRational(view, offset, little) {
  const num = view.getUint32(offset, little);
  const den = view.getUint32(offset + 4, little);
  return den === 0 ? 0 : num / den;
}

function parseGPS(view, tiffStart, gpsIFDOffset, little) {
  const { entries } = readIFD(view, tiffStart, gpsIFDOffset, little);

  const latRefEntry = entries.get(0x0001);
  const latEntry = entries.get(0x0002);
  const lonRefEntry = entries.get(0x0003);
  const lonEntry = entries.get(0x0004);

  if (!latEntry || !lonEntry || !latRefEntry || !lonRefEntry) return null;

  const latRef = readString(view, latRefEntry.offset, 1);
  const lonRef = readString(view, lonRefEntry.offset, 1);

  const latD = readRational(view, latEntry.offset, little);
  const latM = readRational(view, latEntry.offset + 8, little);
  const latS = readRational(view, latEntry.offset + 16, little);

  const lonD = readRational(view, lonEntry.offset, little);
  const lonM = readRational(view, lonEntry.offset + 8, little);
  const lonS = readRational(view, lonEntry.offset + 16, little);

  const lat = dmsToDecimal(latD, latM, latS, latRef);
  const lon = dmsToDecimal(lonD, lonM, lonS, lonRef);

  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

// Main entry point. Takes an ArrayBuffer of a JPEG file, returns
// { date: 'YYYY-MM-DD'|null, location: {lat,lon}|null }. Never throws —
// any parsing failure just yields nulls, since EXIF is always optional
// metadata and a photo without it is still a perfectly good photo.
function parseExif(arrayBuffer) {
  const result = { date: null, location: null };
  try {
    const view = new DataView(arrayBuffer);
    if (view.getUint16(0, false) !== 0xffd8) return result; // not a JPEG (no SOI marker)

    let offset = 2;
    const len = view.byteLength;

    while (offset < len - 4) {
      const marker = view.getUint16(offset, false);
      if ((marker & 0xff00) !== 0xff00) break; // corrupt/unexpected data, bail out safely

      // SOS (Start of Scan) means image data follows — no more markers to scan.
      if (marker === 0xffda) break;

      const segmentLength = view.getUint16(offset + 2, false);

      if (marker === 0xffe1) {
        // Candidate APP1 segment — check for the 'Exif\0\0' signature.
        const sigOffset = offset + 4;
        const sig = readString(view, sigOffset, 6);
        if (sig === 'Exif') {
          const tiffStart = sigOffset + 6;
          const byteOrderMark = view.getUint16(tiffStart, false);
          const little = byteOrderMark === 0x4949; // 'II'
          if (little || byteOrderMark === 0x4d4d) {
            const ifd0Offset = view.getUint32(tiffStart + 4, little);
            const { entries: ifd0 } = readIFD(view, tiffStart, tiffStart + ifd0Offset, little);

            // DateTimeOriginal lives in the Exif sub-IFD (tag 0x8769 on IFD0).
            const exifIFDPointerEntry = ifd0.get(0x8769);
            if (exifIFDPointerEntry) {
              const exifIFDOffset = view.getUint32(exifIFDPointerEntry.offset, little);
              const { entries: exifIFD } = readIFD(view, tiffStart, tiffStart + exifIFDOffset, little);
              const dtOriginal = exifIFD.get(0x9003);
              if (dtOriginal) {
                const raw = readString(view, dtOriginal.offset, 19);
                result.date = exifDateToLocalDateStr(raw);
              }
            }
            // Fall back to the plain DateTime tag on IFD0 if no DateTimeOriginal.
            if (!result.date) {
              const dt = ifd0.get(0x0132);
              if (dt) {
                const raw = readString(view, dt.offset, 19);
                result.date = exifDateToLocalDateStr(raw);
              }
            }

            // GPSInfo pointer (tag 0x8825 on IFD0).
            const gpsPointerEntry = ifd0.get(0x8825);
            if (gpsPointerEntry) {
              const gpsOffset = view.getUint32(gpsPointerEntry.offset, little);
              result.location = parseGPS(view, tiffStart, tiffStart + gpsOffset, little);
            }
          }
          break; // found and parsed the Exif APP1 segment — done
        }
      }

      offset += 2 + segmentLength;
    }
  } catch (err) {
    // Malformed/truncated EXIF — treat exactly like "no EXIF present".
    console.warn('EXIF parse failed, continuing without it:', err);
  }
  return result;
}

async function parseExifFromFile(file) {
  const buf = await file.arrayBuffer();
  return parseExif(buf);
}

const api = { parseExif, parseExifFromFile, exifDateToLocalDateStr, dmsToDecimal };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.Exif = api;
}
