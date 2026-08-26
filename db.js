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
    const record = {
      id: uuid(),
      name: dog.name,
      breed: dog.breed || '',
      birthday: dog.birthday || null, // 'YYYY-MM-DD' or null if unknown
      coverPhotoId: dog.coverPhotoId || null,
      createdAt: Date.now(),
    };
    const t = await tx(['dogs'], 'readwrite');
    t.objectStore('dogs').add(record);
    await reqToPromise(t.objectStore('dogs').get(record.id));
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

  async forDog(dogId) {
    const entries = await getAll('entries', 'byDog', dogId);
    return entries.sort((a, b) => (a.date < b.date ? 1 : -1));
  },

  async all() {
    const entries = await getAll('entries');
    return entries.sort((a, b) => (a.date < b.date ? 1 : -1));
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
