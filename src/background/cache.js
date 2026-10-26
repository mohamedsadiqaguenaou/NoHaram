// Result cache: in-memory LRU backed by IndexedDB, so images seen before (avatars, thumbnails,
// banners) resolve instantly, even after the service worker restarts or the browser reopens.
// Only SHA-256 hashes of URLs are written to disk — the cache is not a readable browsing history.

const DB_NAME = 'noharam';
const STORE = 'scores';
const MEMORY_LIMIT = 5000;
const DISK_LIMIT = 40000;
const FLUSH_DELAY_MS = 1500;

export class ResultCache {
  constructor(modelVersion) {
    this.version = modelVersion;
    this.mem = new Map();
    this.writes = new Map();
    this.flushTimer = 0;
    this.dbPromise = null;
  }

  db() {
    this.dbPromise ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'k' });
          store.createIndex('t', 't');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null); // private mode etc.: memory cache only
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  async hash(url) {
    const bytes = new TextEncoder().encode(`${this.version}\n${url}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let s = '';
    for (let i = 0; i < 16; i++) s += digest[i].toString(16).padStart(2, '0');
    return s;
  }

  remember(url, value) {
    this.mem.delete(url);
    this.mem.set(url, value);
    if (this.mem.size > MEMORY_LIMIT) this.mem.delete(this.mem.keys().next().value);
  }

  async get(url) {
    const hit = this.mem.get(url);
    if (hit) {
      this.remember(url, hit);
      return hit;
    }
    const db = await this.db();
    if (!db) return null;
    const k = await this.hash(url);
    const row = await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
    if (!row) return null;
    const value = { s1: row.s1, s2: row.s2, aspect: row.a };
    this.remember(url, value);
    return value;
  }

  set(url, value) {
    this.remember(url, value);
    this.writes.set(url, value);
    // Batch writes, but never postpone them indefinitely while a page keeps scanning.
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  async flush() {
    this.flushTimer = 0;
    const batch = [...this.writes];
    this.writes.clear();
    const db = await this.db();
    if (!db || !batch.length) return;
    const rows = await Promise.all(
      batch.map(async ([url, v]) => ({ k: await this.hash(url), s1: v.s1, s2: v.s2, a: v.aspect, t: Date.now() })),
    );
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
    const count = await new Promise((resolve) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
    if (count > DISK_LIMIT) {
      // Drop the oldest 10%.
      let toDelete = Math.ceil(DISK_LIMIT * 0.1);
      store.index('t').openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || toDelete-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    }
  }

  async size() {
    const db = await this.db();
    if (!db) return this.mem.size;
    return new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(this.mem.size);
    });
  }

  async clear() {
    this.mem.clear();
    this.writes.clear();
    const db = await this.db();
    if (!db) return;
    await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      req.onsuccess = req.onerror = () => resolve();
    });
  }
}
