// media.js — turns a picked photo File into two stored blobs:
// a small thumbnail (for grids/lists) and a capped-resolution full image
// (for the one-at-a-time detail view). Never store the original multi-MB
// camera photo directly — see rigorous-app-building skill, section 6.

const THUMB_MAX_DIM = 480; // enough for any card/grid this app shows
const FULL_MAX_DIM = 1600; // enough for a full-screen phone view

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function resizeToBlob(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

async function processPhoto(file) {
  const img = await loadImage(file);
  try {
    const [thumbBlob, fullBlob] = await Promise.all([
      resizeToBlob(img, THUMB_MAX_DIM, 0.7),
      resizeToBlob(img, FULL_MAX_DIM, 0.85),
    ]);
    return { thumbBlob, fullBlob };
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

window.Media = { processPhoto };
