/**
 * Media files (official audio, recorded video) are much too big for the workspace JSON,
 * and they never need to leave the device: IndexedDB keeps them locally, per project.
 */
const NAME = "tktgen-media";
const STORE = "files";

let opening: Promise<IDBDatabase> | null = null;

const db = () => (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is not available")); return; }
  const req = indexedDB.open(NAME, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
}));

/**
 * Ask the browser to keep this site's files even when the disk runs low (otherwise IndexedDB is
 * "best effort" and can be cleared). Granted silently by Chrome for sites in use, asked in Firefox.
 */
export async function askPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

export async function putMedia(key: string, blob: Blob): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMedia(key: string): Promise<Blob | null> {
  try {
    const d = await db();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = d.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function delMedia(key: string): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* nothing stored */
  }
}

/** Keys starting with `prefix` (used to list the fonts the user loaded). */
export async function listMedia(prefix: string): Promise<string[]> {
  try {
    const d = await db();
    return await new Promise<string[]>((resolve, reject) => {
      const tx = d.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String).filter((k) => k.startsWith(prefix)));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}
