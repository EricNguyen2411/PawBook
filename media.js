// media.js — turns a picked photo File into two stored blobs:
// a small thumbnail (for grids/lists) and a capped-resolution full image
// (for the one-at-a-time detail view). Never store the original multi-MB
// camera photo directly — see rigorous-app-building skill, section 6.
//
// iPhones shoot HEIC by default. Safari CAN decode HEIC, but only reliably
// through createImageBitmap(file), which delegates straight to iOS's system
// image decoder — decoding via `new Image()` + a Blob URL is documented to
// fail for HEIC in Safari even though the browser is technically capable of
// reading the format. So createImageBitmap is the primary path here, with
// the old <img>-based approach kept only as a fallback for the rare browser
// without createImageBitmap support.
//
// Every failure here is tagged with which stage it happened in (decode vs.
// resize vs. encode), and the underlying browser error message is preserved
// and surfaced in the UI — without a real device to test against, a vague
// "something went wrong" is much harder to diagnose than the actual error
// WebKit gave us.

const THUMB_MAX_DIM = 480; // enough for any card/grid this app shows
const FULL_MAX_DIM = 1600; // enough for a full-screen phone view
const TOBLOB_TIMEOUT_MS = 15000; // guards against toBlob's callback never firing

class PhotoProcessingError extends Error {
  constructor(stage, cause) {
    const causeMsg = cause && cause.message ? cause.message : String(cause);
    super(`[${stage}] ${causeMsg}`);
    this.stage = stage;
    this.cause = cause;
  }
}

// Pure function, deliberately separated from any DOM/canvas API so it can
// be unit tested directly: given a source image's real dimensions, compute
// the output size that fits within maxDim on the longer edge without
// upscaling anything already smaller than that.
function computeResizeDimensions(sourceWidth, sourceHeight, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('<img> element could not decode this file'));
    img.src = URL.createObjectURL(file);
  });
}

// Returns either an ImageBitmap (preferred) or an HTMLImageElement
// (fallback), plus a matching cleanup function for whichever it returned.
async function loadDecodedSource(file) {
  let bitmapError = null;

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, dims: { w: bitmap.width, h: bitmap.height }, cleanup: () => bitmap.close() };
    } catch (err) {
      bitmapError = err;
      console.warn('createImageBitmap failed, falling back to <img> decode:', err);
    }
  }

  try {
    const img = await loadImageElement(file);
    return {
      source: img,
      dims: { w: img.naturalWidth, h: img.naturalHeight },
      cleanup: () => URL.revokeObjectURL(img.src),
    };
  } catch (imgError) {
    // Both decode paths failed — report whichever gives more information.
    throw new PhotoProcessingError('decode', bitmapError || imgError);
  }
}

function resizeToBlob(source, sourceDims, maxDim, quality) {
  const { width, height } = computeResizeDimensions(sourceDims.w, sourceDims.h, maxDim);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoProcessingError('resize', new Error('canvas 2d context unavailable'));

  try {
    ctx.drawImage(source, 0, 0, width, height);
  } catch (err) {
    throw new PhotoProcessingError('resize', err);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new PhotoProcessingError('encode', new Error('timed out waiting for canvas.toBlob')));
    }, TOBLOB_TIMEOUT_MS);

    try {
      canvas.toBlob(
        (blob) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (blob) resolve(blob);
          else reject(new PhotoProcessingError('encode', new Error('canvas.toBlob returned null')));
        },
        'image/jpeg',
        quality
      );
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new PhotoProcessingError('encode', err));
      }
    }
  });
}

async function processPhoto(file) {
  const { source, dims, cleanup } = await loadDecodedSource(file);
  try {
    const thumbBlob = await resizeToBlob(source, dims, THUMB_MAX_DIM, 0.7);
    // The thumbnail is the essential piece (used everywhere in the UI); if
    // the larger full-size encode fails for some reason, degrade gracefully
    // by reusing the thumbnail rather than losing the photo entirely.
    let fullBlob;
    try {
      fullBlob = await resizeToBlob(source, dims, FULL_MAX_DIM, 0.85);
    } catch (err) {
      console.warn('Full-size encode failed, reusing thumbnail for both:', err);
      fullBlob = thumbBlob;
    }
    return { thumbBlob, fullBlob };
  } finally {
    cleanup();
  }
}

window.Media = { processPhoto, computeResizeDimensions, PhotoProcessingError };
