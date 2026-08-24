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

const THUMB_MAX_DIM = 480; // enough for any card/grid this app shows
const FULL_MAX_DIM = 1600; // enough for a full-screen phone view

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
    img.onerror = () => reject(new Error('Image element failed to decode this file'));
    img.src = URL.createObjectURL(file);
  });
}

// Returns either an ImageBitmap (preferred) or an HTMLImageElement
// (fallback), plus a matching cleanup function for whichever it returned.
async function loadDecodedSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, dims: { w: bitmap.width, h: bitmap.height }, cleanup: () => bitmap.close() };
    } catch (err) {
      console.warn('createImageBitmap failed, falling back to <img> decode:', err);
    }
  }
  const img = await loadImageElement(file);
  return {
    source: img,
    dims: { w: img.naturalWidth, h: img.naturalHeight },
    cleanup: () => URL.revokeObjectURL(img.src),
  };
}

function resizeToBlob(source, sourceDims, maxDim, quality) {
  const { width, height } = computeResizeDimensions(sourceDims.w, sourceDims.h, maxDim);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      'image/jpeg',
      quality
    );
  });
}

async function processPhoto(file) {
  const { source, dims, cleanup } = await loadDecodedSource(file);
  try {
    const [thumbBlob, fullBlob] = await Promise.all([
      resizeToBlob(source, dims, THUMB_MAX_DIM, 0.7),
      resizeToBlob(source, dims, FULL_MAX_DIM, 0.85),
    ]);
    return { thumbBlob, fullBlob };
  } finally {
    cleanup();
  }
}

window.Media = { processPhoto, computeResizeDimensions };
