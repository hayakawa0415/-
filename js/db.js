// IndexedDB（端末内保存）の薄いラッパー
const DB_NAME = "nouhinsho";
const DB_VERSION = 1;
export const STORES = ["sites", "records", "photos", "usage", "meta"];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("sites", { keyPath: "id" });
      const records = db.createObjectStore("records", { keyPath: "id" });
      records.createIndex("siteId", "siteId");
      db.createObjectStore("photos", { keyPath: "id" });
      db.createObjectStore("usage", { keyPath: "key" });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = "readonly") {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}

export async function get(name, key) {
  return wrap((await store(name)).get(key));
}

export async function put(name, value) {
  return wrap((await store(name, "readwrite")).put(value));
}

export async function del(name, key) {
  return wrap((await store(name, "readwrite")).delete(key));
}

export async function clearAll() {
  const db = await open();
  const tx = db.transaction(STORES, "readwrite");
  for (const name of STORES) tx.objectStore(name).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(key, fallback = null) {
  const row = await get("meta", key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put("meta", { key, value });
}

export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
