// db.js — IndexedDB wrapper. All data lives on this device only (no server,
// no account). Everything here is offline-first by construction: IndexedDB
// works with zero network, and nothing in this file ever calls fetch().

const DB_NAME = 'dogMemoryBook';
const DB_VERSION = 1;

function uuid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  // Fallback for older WebViews without crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('dogs')) {
        db.createObjectStore('dogs', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('entries')) {
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('byDog', 'dogId', { unique: false });
        entries.createIndex('byDate', 'date', { unique: false });
      }

      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('weights')) {
        const weights = db.createObjectStore('weights', { keyPath: 'id' });
        weights.createIndex('byDog', 'dogId', { unique: false });
        weights.createIndex('byDate', 'date', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll(storeName, indexName, query) {
  return tx([storeName], 'readonly').then((t) => {
    const store = t.objectStore(storeName);
    const source = indexName ? store.index(indexName) : store;
    const req = query !== undefined ? source.getAll(query) : source.getAll();
    return reqToPromise(req);
  });
}

// ---- Dogs ----

const DogsAPI = {
  async add(dog) {
    // Spread first — same reasoning as Entries.add and Photos.add. This was
    // the third copy of the same hand-maintained-whitelist pattern that had
    // already caused a real bug twice; fixing it here before it does again
    // (this change is what let targetMinKg/targetMaxKg just work below).
    const record = {
      breed: '',
      birthday: null,
      coverPhotoId: null,
      ...dog,
      id: uuid(),
      createdAt: Date.now(),
    };
    const t = await tx(['dogs'], 'readwrite');
    t.objectStore('dogs').add(record);
    return record;
  },

  async update(dog) {
    const t = await tx(['dogs'], 'readwrite');
    t.objectStore('dogs').put(dog);
    return dog;
  },

  async all() {
    const dogs = await getAll('dogs');
    return dogs.sort((a, b) => a.createdAt - b.createdAt);
  },

  async remove(id) {
    const t = await tx(['dogs'], 'readwrite');
    t.objectStore('dogs').delete(id);
  },
};

// ---- Entries (timeline: photo posts, notes, milestones) ----
//
// Deleting an entry is a soft delete: it's stamped with `deletedAt` rather
// than removed outright, and every read here filters those out by default.
// A separate "Recently Deleted" view (app.js) can list, restore, or
// permanently purge them. This is deliberately NOT hidden inside forDog/all
// via a hard-to-notice flag — see the dedicated trashedForDog/purge methods
// below, which make the soft-delete lifecycle explicit at the call site.

const EntriesAPI = {
  async add(entry) {
    // Spread first so any field the caller provides (dogId, date, type,
    // distanceKm, durationMin, nextDueDate, location, etc.) is preserved
    // automatically — then apply defaults/overrides on top. A hand-written
    // field whitelist here previously caused a real bug where new fields
    // were silently dropped on save; this shape can't repeat that.
    const record = {
      ...entry,
      id: uuid(),
      type: entry.type || 'photo',
      caption: entry.caption || '',
      photoIds: entry.photoIds || [],
      tags: entry.tags || [],
      favorite: !!entry.favorite,
      deletedAt: null,
      createdAt: Date.now(),
    };
    const t = await tx(['entries'], 'readwrite');
    t.objectStore('entries').add(record);
    return record;
  },

  async update(entry) {
    const t = await tx(['entries'], 'readwrite');
    t.objectStore('entries').put(entry);
    return entry;
  },

  async get(id) {
    const t = await tx(['entries'], 'readonly');
    return reqToPromise(t.objectStore('entries').get(id));
  },

  async forDog(dogId) {
    const entries = await getAll('entries', 'byDog', dogId);
    return entries.filter((e) => !e.deletedAt).sort((a, b) => (a.date < b.date ? 1 : -1));
  },

  async all() {
    const entries = await getAll('entries');
    return entries.filter((e) => !e.deletedAt).sort((a, b) => (a.date < b.date ? 1 : -1));
  },

  async trashedForDog(dogId) {
    const entries = await getAll('entries', 'byDog', dogId);
    return entries.filter((e) => e.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  },

  async softDelete(id) {
    const entry = await this.get(id);
    if (!entry) return null;
    entry.deletedAt = Date.now();
    return this.update(entry);
  },

  async restore(id) {
    const entry = await this.get(id);
    if (!entry) return null;
    entry.deletedAt = null;
    return this.update(entry);
  },

  async remove(id) {
    const t = await tx(['entries'], 'readwrite');
    t.objectStore('entries').delete(id);
  },
};

// ---- Photos (stored as blobs; thumb + full kept separately, see media.js) ----

const PhotosAPI = {
  async add(fields) {
    // Spread first — same reasoning as Entries.add above. Previously this
    // only kept thumbBlob/fullBlob, which would have silently dropped
    // videoBlob and mediaType the same way it once dropped walk/vaccination
    // fields on entries.
    const record = { mediaType: 'photo', ...fields, id: uuid(), createdAt: Date.now() };
    const t = await tx(['photos'], 'readwrite');
    t.objectStore('photos').add(record);
    return record;
  },

  async get(id) {
    const t = await tx(['photos'], 'readonly');
    return reqToPromise(t.objectStore('photos').get(id));
  },

  // Used to build a duplicate-detection index (content hashes) before a
  // bulk import — small enough at personal scale to just fetch everything.
  async all() {
    return getAll('photos');
  },

  async remove(id) {
    const t = await tx(['photos'], 'readwrite');
    t.objectStore('photos').delete(id);
  },

  // Used only by backup restore, which needs to preserve original ids so
  // re-importing the same backup twice overwrites rather than duplicates.
  async putRaw(record) {
    const t = await tx(['photos'], 'readwrite');
    t.objectStore('photos').put(record);
    return record;
  },
};

// ---- Weights ----

const WeightsAPI = {
  async add(weight) {
    const record = {
      id: uuid(),
      dogId: weight.dogId,
      date: weight.date, // 'YYYY-MM-DD'
      weightKg: weight.weightKg,
      note: weight.note || '',
      createdAt: Date.now(),
    };
    const t = await tx(['weights'], 'readwrite');
    t.objectStore('weights').add(record);
    return record;
  },

  async forDog(dogId) {
    const weights = await getAll('weights', 'byDog', dogId);
    return weights.sort((a, b) => (a.date > b.date ? 1 : -1));
  },

  async remove(id) {
    const t = await tx(['weights'], 'readwrite');
    t.objectStore('weights').delete(id);
  },

  // Used only by backup restore — see PhotosAPI.putRaw for why.
  async putRaw(record) {
    const t = await tx(['weights'], 'readwrite');
    t.objectStore('weights').put(record);
    return record;
  },
};

window.DB = { openDB, Dogs: DogsAPI, Entries: EntriesAPI, Photos: PhotosAPI, Weights: WeightsAPI };
