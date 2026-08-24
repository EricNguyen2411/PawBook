// backup.js — export everything in IndexedDB to a single JSON file the user
// can save anywhere (Files app, iCloud Drive, email to themselves, etc.),
// and restore from that file later. This is the only way data survives a
// lost/replaced phone, since storage is local-only (see db.js).

const BACKUP_FORMAT_VERSION = 1;

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000; // avoid call-stack limits on String.fromCharCode with huge arrays
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return { data: btoa(binary), type: blob.type || 'image/jpeg' };
}

function base64ToBlob({ data, type }) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || 'image/jpeg' });
}

async function exportBackup() {
  const { Dogs, Entries, Photos, Weights } = window.DB;

  const dogs = await Dogs.all();
  const entries = await Entries.all();
  const weights = [];
  for (const dog of dogs) {
    weights.push(...(await Weights.forDog(dog.id)));
  }

  // Collect every photo referenced by an entry or a dog cover photo.
  const photoIds = new Set();
  entries.forEach((e) => (e.photoIds || []).forEach((id) => photoIds.add(id)));
  dogs.forEach((d) => d.coverPhotoId && photoIds.add(d.coverPhotoId));

  const photos = [];
  for (const id of photoIds) {
    const rec = await Photos.get(id);
    if (!rec) continue;
    photos.push({
      id: rec.id,
      createdAt: rec.createdAt,
      thumbBlob: rec.thumbBlob ? await blobToBase64(rec.thumbBlob) : null,
      fullBlob: rec.fullBlob ? await blobToBase64(rec.fullBlob) : null,
    });
  }

  const payload = {
    format: 'pawbook-backup',
    version: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    dogs,
    entries,
    weights,
    photos,
  };

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = window.Helpers.todayLocalStr();

  const a = document.createElement('a');
  a.href = url;
  a.download = `pawbook-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return { dogCount: dogs.length, entryCount: entries.length, weightCount: weights.length, photoCount: photos.length };
}

async function readBackupFile(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (payload.format !== 'pawbook-backup' || !Array.isArray(payload.dogs)) {
    throw new Error('This file does not look like a PawBook backup.');
  }
  return payload;
}

// Writes every record from the backup back into IndexedDB. Uses `put`
// throughout (via the DB module's own add/update, which both map to
// IndexedDB `put`-style writes keyed by id), so importing the same backup
// twice is safe and never creates duplicates.
async function restoreBackup(payload) {
  const { Dogs, Entries, Photos, Weights } = window.DB;

  for (const rec of payload.photos || []) {
    const thumbBlob = rec.thumbBlob ? base64ToBlob(rec.thumbBlob) : null;
    const fullBlob = rec.fullBlob ? base64ToBlob(rec.fullBlob) : null;
    await Photos.putRaw({ id: rec.id, thumbBlob, fullBlob, createdAt: rec.createdAt });
  }

  for (const dog of payload.dogs || []) {
    await Dogs.update(dog); // update() does a put keyed by id — works for new ids too
  }

  for (const entry of payload.entries || []) {
    await Entries.update(entry);
  }

  for (const weight of payload.weights || []) {
    await Weights.putRaw(weight);
  }

  return {
    dogCount: (payload.dogs || []).length,
    entryCount: (payload.entries || []).length,
    weightCount: (payload.weights || []).length,
    photoCount: (payload.photos || []).length,
  };
}

window.Backup = { exportBackup, readBackupFile, restoreBackup, blobToBase64, base64ToBlob };
