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
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200MB — protects IndexedDB storage/backup size, not a codec limit
const VIDEO_LOAD_TIMEOUT_MS = 20000; // guards against a video that never fires loadedmetadata/seeked

class PhotoProcessingError extends Error {
  constructor(stage, cause) {
    const causeMsg = cause && cause.message ? cause.message : String(cause);
    super(`[${stage}] ${causeMsg}`);
    this.stage = stage;
    this.cause = cause;
  }
}

// Trusts an explicit video/* type completely. When type is missing (see the
// same reasoning in app.js's looksLikeImageFile), falls back to extension.
function isVideoFile(file) {
  if (file.type) return file.type.startsWith('video/');
  return /\.(mp4|mov|m4v|webm|avi)$/i.test(file.name || '');
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
    return { thumbBlob, fullBlob, mediaType: 'photo' };
  } finally {
    cleanup();
  }
}

// Loads a video file into a <video> element and waits for a decoded frame
// partway into the clip (frame 0 is very often black/blank on real camera
// footage), so it can be drawn to canvas the same way an image or
// ImageBitmap would be.
//
// The element is temporarily attached to the page (visually hidden, off
// the edge of the screen) rather than left detached. iOS Safari is
// documented to suspend video elements that aren't attached to the DOM as
// a battery-saving measure — which silently prevents loadedmetadata/seeked
// from ever firing, with no error at all. That exact symptom (picking a
// video appears to do nothing) is what this works around.
function captureVideoFrame(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.setAttribute('muted', '');
    video.playsInline = true;
    video.setAttribute('playsinline', ''); // some WebKit versions want the attribute form too
    video.style.cssText = 'position:fixed; top:0; left:-9999px; width:1px; height:1px; opacity:0;';
    document.body.appendChild(video);

    const url = URL.createObjectURL(file);
    video.src = url;

    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (video.parentNode) video.parentNode.removeChild(video);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PhotoProcessingError('decode', new Error('timed out loading video')));
    }, VIDEO_LOAD_TIMEOUT_MS);

    video.onloadedmetadata = () => {
      // Seek a little way in, capped to the clip's own length for very short videos.
      video.currentTime = Math.min(0.3, (video.duration || 1) / 2);
    };
    video.onseeked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Resolve with dims now; the caller draws from `video` synchronously
      // before this function's own cleanup would otherwise remove it, so
      // defer removal to the caller via the returned cleanup-less video —
      // actual DOM removal happens in processVideo's finally block instead.
      resolve({ source: video, dims: { w: video.videoWidth, h: video.videoHeight }, url, remove: () => cleanup() });
    };
    video.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new PhotoProcessingError('decode', new Error('<video> element could not decode this file')));
    };
  });
}

// Unlike photos, the video itself is stored as-is (no client-side
// transcoding — that needs a much heavier toolchain than fits this app's
// offline-first, dependency-free approach). Only a poster-frame thumbnail
// is generated, the same size/quality as a photo thumbnail, for grid display.
async function processVideo(file) {
  if (file.size > MAX_VIDEO_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(0);
    const capMb = MAX_VIDEO_BYTES / (1024 * 1024);
    throw new PhotoProcessingError('size', new Error(`video is ${mb}MB, over the ${capMb}MB limit — try trimming it first`));
  }

  const { source, dims, remove } = await captureVideoFrame(file);
  try {
    const thumbBlob = await resizeToBlob(source, dims, THUMB_MAX_DIM, 0.7);
    return { thumbBlob, videoBlob: file, mediaType: 'video' };
  } finally {
    remove();
  }
}

window.Media = { processPhoto, processVideo, isVideoFile, computeResizeDimensions, PhotoProcessingError, MAX_VIDEO_BYTES };
