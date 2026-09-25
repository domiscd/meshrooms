import { base64, deviceId, encode } from './protocol';

type Identity = { id: string; publicKey: string; keys: CryptoKeyPair };
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ||= new Promise((resolve, reject) => {
    const open = indexedDB.open('meshrooms-browser-v1', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('records');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(new Error('Browser storage is unavailable. Allow site storage and reload.'));
    open.onblocked = () => reject(new Error('Close other Meshrooms tabs and reload to update storage.'));
  });
}
export async function read<T>(key: string): Promise<T | undefined> {
  const store = (await db()).transaction('records').objectStore('records');
  return new Promise((resolve, reject) => { const r = store.get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
export async function write(key: string, value: unknown) {
  const tx = (await db()).transaction('records', 'readwrite');
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('Could not save in this browser. Free some site storage and retry.'));
    tx.objectStore('records').put(value, key);
  });
}
/** Several puts and deletes in one transaction, so a file and its index entry change together. */
export async function update(puts: [string, unknown][], deletes: string[] = []) {
  const tx = (await db()).transaction('records', 'readwrite');
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('Could not save in this browser. Free some site storage and retry.'));
    const store = tx.objectStore('records');
    for (const [key, value] of puts) store.put(value, key);
    for (const key of deletes) store.delete(key);
  });
}
let current: Promise<Identity> | undefined;
export function identity() {
  return current ||= (async () => {
    if (!crypto.subtle || !navigator.locks) throw new Error('Open this room over HTTPS in a browser with Web Crypto and Web Locks support.');
    return navigator.locks.request('meshrooms-identity', async () => {
      const existing = await read<Identity>('identity'); if (existing) return existing;
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKey = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
      const created = { id: await deviceId(publicKey), publicKey, keys };
      await write('identity', created); return created;
    });
  })();
}
export async function sign(value: unknown) {
  const i = await identity();
  return base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, i.keys.privateKey, encode(value)));
}
