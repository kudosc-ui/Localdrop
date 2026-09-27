// storage.js — IndexedDB persistence layer for LocalDrop.
// Large clipboard text and files live in IndexedDB (not localStorage) so the
// app stays responsive with big payloads. Small config lives in localStorage.

const DB_NAME = 'localdrop-db';
const DB_VERSION = 1;
const LARGE_TEXT_THRESHOLD = 20000; // characters — above this we treat an entry as "large"

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('favorite', 'favorite');
      }
      if (!db.objectStoreNames.contains('content')) {
        db.createObjectStore('content', { keyPath: 'id' }); // full text for large entries
      }
      if (!db.objectStoreNames.contains('files')) {
        const store = db.createObjectStore('files', { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('devices')) {
        db.createObjectStore('devices', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

// ---------- Settings (localStorage — small, synchronous, fine here) ----------

const DEFAULT_SETTINGS = {
  deviceName: null, // set on first run
  clipboardSyncEnabled: true,
  fileTransferEnabled: true,
  historyEnabled: true,
  maxHistoryItems: 200,
  autoDeleteHistoryDays: 0, // 0 = never
  theme: 'dark', // spec requires dark by default; user can switch to Light or System in Settings
  showOnNetwork: true,
  requirePairingConfirmation: true,
};

function getSettings() {
  try {
    const raw = localStorage.getItem('localdrop-settings');
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function setSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  localStorage.setItem('localdrop-settings', JSON.stringify(merged));
  return merged;
}

function getOrCreateDeviceIdentity() {
  // Intentionally sessionStorage, not localStorage: localStorage is shared
  // across every tab of the same origin, which would give two Demo Mode tabs
  // (or two windows of this same browser) the SAME device id — and identical
  // ids get filtered out everywhere as "my own broadcast". sessionStorage is
  // scoped per tab, so each simulated device gets its own identity, while a
  // single tab still keeps a stable identity across reloads within its session.
  let id = sessionStorage.getItem('localdrop-device-id');
  if (!id) {
    id = uuid();
    sessionStorage.setItem('localdrop-device-id', id);
  }
  let name = getSettings().deviceName;
  if (!name) {
    name = detectDeviceName();
    setSettings({ deviceName: name });
  }
  return { id, name };
}

function detectDeviceType() {
  const ua = navigator.userAgent || '';
  const isTablet = /iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
  if (isTablet) return 'Tablet';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Device';
}

function detectDeviceName() {
  return `${detectDeviceType()} (${Math.random().toString(36).slice(2, 6)})`;
}

// ---------- History ----------

async function addHistoryEntry({ text, originDeviceId, originDeviceName, favorite = false, id = null }) {
  const settings = getSettings();
  if (!settings.historyEnabled) return null;

  const entryId = id || uuid();
  const byteSize = new Blob([text]).size;
  const charCount = text.length;
  const isLarge = charCount > LARGE_TEXT_THRESHOLD;
  const preview = text.slice(0, 300);

  const meta = {
    id: entryId,
    preview,
    isLarge,
    byteSize,
    charCount,
    timestamp: Date.now(),
    originDeviceId,
    originDeviceName,
    favorite,
    // small entries keep their full text inline for fast rendering
    text: isLarge ? null : text,
  };

  const store = await tx('history', 'readwrite');
  store.put(meta);

  if (isLarge) {
    const contentStore = await tx('content', 'readwrite');
    contentStore.put({ id: entryId, text });
  }

  await enforceHistoryLimit(settings.maxHistoryItems);
  return meta;
}

async function enforceHistoryLimit(max) {
  if (!max || max <= 0) return;
  const all = await getHistoryList();
  if (all.length <= max) return;
  const toRemove = all.slice(max); // getHistoryList is newest-first
  const historyStore = await tx('history', 'readwrite');
  const contentStore = await tx('content', 'readwrite');
  for (const item of toRemove) {
    if (!item.favorite) {
      historyStore.delete(item.id);
      contentStore.delete(item.id);
    }
  }
}

async function getHistoryList() {
  const store = await tx('history', 'readonly');
  const all = await reqToPromise(store.getAll());
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

async function getHistoryFullText(id) {
  const store = await tx('history', 'readonly');
  const meta = await reqToPromise(store.get(id));
  if (!meta) return null;
  if (!meta.isLarge) return meta.text;
  const contentStore = await tx('content', 'readonly');
  const content = await reqToPromise(contentStore.get(id));
  return content ? content.text : null;
}

async function deleteHistoryEntry(id) {
  const historyStore = await tx('history', 'readwrite');
  historyStore.delete(id);
  const contentStore = await tx('content', 'readwrite');
  contentStore.delete(id);
}

async function toggleFavorite(id) {
  const store = await tx('history', 'readwrite');
  const item = await reqToPromise(store.get(id));
  if (!item) return null;
  item.favorite = !item.favorite;
  store.put(item);
  return item;
}

async function clearHistory({ keepFavorites = true } = {}) {
  const all = await getHistoryList();
  const historyStore = await tx('history', 'readwrite');
  const contentStore = await tx('content', 'readwrite');
  for (const item of all) {
    if (keepFavorites && item.favorite) continue;
    historyStore.delete(item.id);
    contentStore.delete(item.id);
  }
}

async function searchHistory(query) {
  const all = await getHistoryList();
  if (!query) return all;
  const q = query.toLowerCase();
  return all.filter((item) => item.preview.toLowerCase().includes(q));
}

async function updateHistoryText(id, newText) {
  const store = await tx('history', 'readwrite');
  const item = await reqToPromise(store.get(id));
  if (!item) return null;
  const isLarge = newText.length > LARGE_TEXT_THRESHOLD;
  item.preview = newText.slice(0, 300);
  item.byteSize = new Blob([newText]).size;
  item.charCount = newText.length;
  item.isLarge = isLarge;
  item.text = isLarge ? null : newText;
  item.timestamp = Date.now();
  store.put(item);
  const contentStore = await tx('content', 'readwrite');
  if (isLarge) contentStore.put({ id, text: newText });
  else contentStore.delete(id);
  return item;
}

// ---------- Files ----------

async function saveFileBlob({ id, name, mimeType, blob, originDeviceId, originDeviceName }) {
  const store = await tx('files', 'readwrite');
  store.put({ id, name, mimeType, size: blob.size, blob, timestamp: Date.now(), originDeviceId, originDeviceName });
}

async function getFileList() {
  const store = await tx('files', 'readonly');
  const all = await reqToPromise(store.getAll());
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

async function getFile(id) {
  const store = await tx('files', 'readonly');
  return reqToPromise(store.get(id));
}

async function deleteFile(id) {
  const store = await tx('files', 'readwrite');
  store.delete(id);
}

// ---------- Devices (paired device records, persisted across sessions) ----------

async function saveDeviceRecord(device) {
  const store = await tx('devices', 'readwrite');
  store.put(device);
}

async function getDeviceRecords() {
  const store = await tx('devices', 'readonly');
  return reqToPromise(store.getAll());
}

async function deleteDeviceRecord(id) {
  const store = await tx('devices', 'readwrite');
  store.delete(id);
}

window.LocalDropStorage = {
  uuid,
  LARGE_TEXT_THRESHOLD,
  getSettings,
  setSettings,
  getOrCreateDeviceIdentity,
  detectDeviceType,
  addHistoryEntry,
  getHistoryList,
  getHistoryFullText,
  deleteHistoryEntry,
  toggleFavorite,
  clearHistory,
  searchHistory,
  updateHistoryText,
  saveFileBlob,
  getFileList,
  getFile,
  deleteFile,
  saveDeviceRecord,
  getDeviceRecords,
  deleteDeviceRecord,
};
