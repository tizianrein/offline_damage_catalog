/* =============================================================
 * storage.js — IndexedDB persistence layer
 *
 * Schema:
 *   meta:    keyValue store with { key, value }   (single record key="state": {damages, modelMeta})
 *   photos:  keyValue store with { id, name, mime, blob, createdAt }
 *
 * Why IndexedDB: localStorage is capped at ~5MB per origin on iOS Safari
 * and serializes everything as JSON strings — base64 photos are huge.
 * IndexedDB stores Blobs natively, allows tens of megabytes by default,
 * and is async (no UI freezes when writing big photos).
 *
 * Public API mirrors what the old localStorage code expected so app.js
 * doesn't need to know it's talking to IndexedDB:
 *
 *   await Storage.init()
 *   await Storage.loadState()                  -> { damages, modelMeta } | null
 *   await Storage.saveState({ damages, modelMeta })
 *
 *   await Storage.savePhoto(id, blob, name)    -> stores blob under id
 *   await Storage.getPhoto(id)                 -> { id, name, mime, blob } | null
 *   await Storage.deletePhoto(id)
 *   await Storage.listPhotoIds()               -> [id, ...]
 *
 *   await Storage.clearAll()
 *   await Storage.estimate()                   -> { usage, quota } in bytes
 * ============================================================= */

const DB_NAME = 'damage-inspector';
const DB_VERSION = 1;
const STATE_STORE = 'meta';
const PHOTO_STORE = 'photos';
const STATE_KEY = 'app-state';

// Keys used in the legacy localStorage version, kept here so we can
// migrate one-time and then leave them alone.
const LEGACY_STATE_KEY = 'damage-inspector.v1';
const LEGACY_PHOTO_KEY = 'damage-inspector.photos.v1';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDb().then((db) => {
    const t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  });
}

// Wrap an IDBRequest in a promise.
function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// -----------------------------------------------------------------
// State (damages, modelMeta)
// -----------------------------------------------------------------

async function saveState(state) {
  const store = await tx(STATE_STORE, 'readwrite');
  await req2promise(store.put({ key: STATE_KEY, value: state }));
}

async function loadState() {
  const store = await tx(STATE_STORE, 'readonly');
  const rec = await req2promise(store.get(STATE_KEY));
  return rec ? rec.value : null;
}

// -----------------------------------------------------------------
// Photos (blobs)
// -----------------------------------------------------------------

async function savePhoto(id, blob, name) {
  const store = await tx(PHOTO_STORE, 'readwrite');
  await req2promise(store.put({
    id,
    name: name || id,
    mime: blob.type || 'image/jpeg',
    blob,
    createdAt: new Date().toISOString(),
  }));
}

async function getPhoto(id) {
  const store = await tx(PHOTO_STORE, 'readonly');
  return req2promise(store.get(id));
}

async function deletePhoto(id) {
  const store = await tx(PHOTO_STORE, 'readwrite');
  await req2promise(store.delete(id));
}

async function listPhotoIds() {
  const store = await tx(PHOTO_STORE, 'readonly');
  const keys = await req2promise(store.getAllKeys());
  return keys || [];
}

async function getAllPhotos() {
  const store = await tx(PHOTO_STORE, 'readonly');
  const all = await req2promise(store.getAll());
  return all || [];
}

// -----------------------------------------------------------------
// Maintenance
// -----------------------------------------------------------------

async function clearAll() {
  const db = await openDb();
  const t = db.transaction([STATE_STORE, PHOTO_STORE], 'readwrite');
  await Promise.all([
    req2promise(t.objectStore(STATE_STORE).clear()),
    req2promise(t.objectStore(PHOTO_STORE).clear()),
  ]);
}

async function estimate() {
  if (navigator.storage && navigator.storage.estimate) {
    return navigator.storage.estimate();
  }
  return { usage: 0, quota: 0 };
}

// -----------------------------------------------------------------
// One-time migration from old localStorage
// -----------------------------------------------------------------

async function migrateFromLocalStorage() {
  const oldState = localStorage.getItem(LEGACY_STATE_KEY);
  const oldPhotos = localStorage.getItem(LEGACY_PHOTO_KEY);
  if (!oldState && !oldPhotos) return false;

  let migrated = false;

  // state
  if (oldState) {
    try {
      const parsed = JSON.parse(oldState);
      if (parsed && Array.isArray(parsed.damages)) {
        // only migrate if no IDB state exists yet
        const existing = await loadState();
        if (!existing) {
          await saveState({
            damages: parsed.damages,
            modelMeta: parsed.modelMeta || null,
          });
          migrated = true;
        }
      }
    } catch (e) {
      console.warn('Could not parse legacy state:', e);
    }
  }

  // photos: were stored as { id: { name, mime, dataUrl } }
  if (oldPhotos) {
    try {
      const obj = JSON.parse(oldPhotos);
      const existingIds = new Set(await listPhotoIds());
      for (const [id, photo] of Object.entries(obj || {})) {
        if (existingIds.has(id)) continue;
        if (!photo || !photo.dataUrl) continue;
        const blob = await dataUrlToBlob(photo.dataUrl);
        await savePhoto(id, blob, photo.name);
        migrated = true;
      }
    } catch (e) {
      console.warn('Could not parse legacy photos:', e);
    }
  }

  if (migrated) {
    // Don't delete the old keys yet — keep them as a backup until the
    // user does something destructive. Worst case they see a stale copy
    // if they downgrade, but no data loss.
    console.info('[storage] Migrated legacy localStorage data into IndexedDB.');
  }
  return migrated;
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// -----------------------------------------------------------------
// Init
// -----------------------------------------------------------------

async function init() {
  await openDb();
  await migrateFromLocalStorage();
  // Ask the browser to NOT evict our data — important for offline use.
  if (navigator.storage && navigator.storage.persist) {
    try {
      const persisted = await navigator.storage.persisted();
      if (!persisted) {
        const granted = await navigator.storage.persist();
        console.info('[storage] Persistent storage:', granted ? 'granted' : 'not granted');
      }
    } catch (e) {
      console.warn('[storage] persist() failed:', e);
    }
  }
}

export const Storage = {
  init,
  saveState,
  loadState,
  savePhoto,
  getPhoto,
  deletePhoto,
  listPhotoIds,
  getAllPhotos,
  clearAll,
  estimate,
};
