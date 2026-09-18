import {
  DesktopWebSecureIndexedStorageHost, type DesktopWebIdbContext, type DesktopWebIdbDatabase,
  type DesktopWebIdbFactory, type DesktopWebIdbOpenRequest, type DesktopWebIdbRequest,
  type DesktopWebIdbStore, type DesktopWebIdbTransaction,
} from './desktop-web-secure-indexed-storage.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function request<T>(result: T): DesktopWebIdbRequest<T> { return { result, error: null, onsuccess: null, onerror: null }; }
function fixture() {
  const data = new Map<string, unknown>(), transactions: DesktopWebIdbTransaction[] = [], timers = new Map<number, () => void>();
  const opens: DesktopWebIdbOpenRequest[] = [];
  let timer = 0, autoOpen = true;
  const store: DesktopWebIdbStore = {
    get: jest.fn(key => { const pending = request(data.get(key)); queueMicrotask(() => pending.onsuccess?.()); return pending; }),
    put: jest.fn((value, key) => { data.set(key, value); }),
    delete: jest.fn(key => { data.delete(key); return request(undefined); }),
    openKeyCursor: jest.fn(() => {
      const pending = request<{ key: unknown; continue(): void } | null>(null), keys = [...data.keys()]; let index = 0;
      const advance = () => queueMicrotask(() => {
        pending.result = index < keys.length ? { key: keys[index++], continue: advance } : null; pending.onsuccess?.();
      }); advance(); return pending;
    }),
  };
  const database: DesktopWebIdbDatabase = {
    version: 1, objectStoreNames: { contains: jest.fn(() => true) }, createObjectStore: jest.fn(), close: jest.fn(),
    transaction: jest.fn(() => {
      const tx: DesktopWebIdbTransaction = { objectStore: () => store, oncomplete: null, onabort: null, onerror: null };
      transactions.push(tx); return tx;
    }),
  };
  const factory: DesktopWebIdbFactory = {
    open: jest.fn(() => {
      const pending = { ...request(database), onupgradeneeded: null }; opens.push(pending);
      if (autoOpen) queueMicrotask(() => pending.onsuccess?.());
      return pending;
    }),
    deleteDatabase: jest.fn(() => { const pending = request(undefined); queueMicrotask(() => pending.onsuccess?.()); return pending; }),
  };
  const context: DesktopWebIdbContext = {
    origin: 'https://synthetic.invalid', readIndexedDB: () => factory,
    setTimeout: jest.fn(callback => { timers.set(++timer, callback); return timer; }),
    clearTimeout: jest.fn(handle => { timers.delete(handle as number); }),
  };
  const host = new DesktopWebSecureIndexedStorageHost(context);
  return { host, context, factory, database, store, data, transactions, timers, opens, manualOpen() { autoOpen = false; } };
}

it('uses the native database/store defaults, shared open promise and resettable 20s close timer', async () => {
  const f = fixture(); f.data.set('a', '{"data":"synthetic"}');
  await expect(f.host.createStorage().getItemByKeys(['a'])).resolves.toEqual(['synthetic']);
  await f.host.createStorage().getItemByKeys(['a']);
  expect(f.factory.open).toHaveBeenCalledTimes(1); expect(f.factory.open).toHaveBeenCalledWith('secure-store', 1);
  expect(f.database.transaction).toHaveBeenCalledWith('cryptvalues', 'readonly');
  expect(f.context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 20000); expect(f.timers.size).toBe(1);
  [...f.timers.values()][0]!(); await flush(); expect(f.database.close).toHaveBeenCalledTimes(1);
  await f.host.createStorage().getItemByKeys(['a']); expect(f.factory.open).toHaveBeenCalledTimes(2);
});

it('returns reads on request success without waiting for transaction complete', async () => {
  const f = fixture(); f.data.set('a', '{"data":0}');
  await expect(f.host.createStorage().getItemByKeys(['a'])).resolves.toEqual([0]);
  expect(f.transactions[0]?.oncomplete).toBeNull();
});

it('waits for write commit, avoids identical puts and serializes later operations behind the write', async () => {
  const f = fixture(); f.data.set('a', '{"data":1}'); const storage = f.host.createStorage();
  let done = false;
  const write = storage.setItemByKeys([['a', 1], ['b', false]]).then(value => { done = true; return value; });
  const read = storage.getItemByKeys(['b']); await flush();
  expect(done).toBe(false); expect(f.transactions).toHaveLength(1);
  expect(f.store.put).toHaveBeenCalledTimes(1); expect(f.store.put).toHaveBeenCalledWith('{"data":false}', 'b');
  f.transactions[0]!.oncomplete!();
  await expect(write).resolves.toEqual([1, false]); await expect(read).resolves.toEqual([false]);
});

it('retries async decode failures four times, poisons all DB names, but allows deletion outside the queue', async () => {
  const f = fixture(); f.data.set('a', 'malformed');
  await expect(f.host.createStorage().getItemByKeys(['a'])).rejects.toThrow(SyntaxError);
  expect(f.factory.open).toHaveBeenCalledTimes(4);
  await expect(f.host.createStorage({ dbName: 'other' }).getItemByKeys(['b'])).rejects.toThrow(SyntaxError);
  expect(f.factory.open).toHaveBeenCalledTimes(4);
  const deletion = f.host.createStorage().removeItem('a'); await flush();
  expect(f.data.has('a')).toBe(false); f.transactions.at(-1)!.oncomplete!(); await expect(deletion).resolves.toBeUndefined();
});

it('does not retry a synchronous operation failure', async () => {
  const f = fixture(), failure = new Error('synthetic timer failure');
  f.context.setTimeout = jest.fn(() => { throw failure; });
  await expect(f.host.createStorage().getKeys()).rejects.toBe(failure);
  await expect(f.host.createStorage().getKeys()).rejects.toBe(failure);
  expect(f.context.setTimeout).toHaveBeenCalledTimes(1); expect(f.factory.open).not.toHaveBeenCalled();
});

it('has no invented blocked timeout: close waits for a pending open rather than declaring it ready', async () => {
  const f = fixture(); f.manualOpen(); let readDone = false, closeDone = false;
  const reading = f.host.createStorage().getKeys().then(() => { readDone = true; }); await flush();
  const closing = f.host.closeDB('secure-store').then(value => { closeDone = true; return value; });
  [...f.timers.values()][0]!(); await flush(); expect(readDone).toBe(false); expect(closeDone).toBe(false);
  f.opens[0]!.onsuccess!(); await reading; await expect(closing).resolves.toBe(1);
});

it('upgrades when the cached database lacks the requested object store', async () => {
  const f = fixture(); let available = false;
  f.database.version = 4; f.database.objectStoreNames.contains = () => available;
  f.database.close = jest.fn(() => { available = true; });
  await f.host.createStorage({ storeName: 'second' }).getKeys();
  expect(f.factory.open).toHaveBeenNthCalledWith(1, 'secure-store', 1);
  expect(f.factory.open).toHaveBeenNthCalledWith(2, 'secure-store', 5); expect(f.database.close).toHaveBeenCalledTimes(1);
});

it('recovers any VersionError through the actual database version', async () => {
  const f = fixture(); f.manualOpen(); f.factory.databases = jest.fn(async () => [{ name: 'secure-store', version: 7 }]);
  const read = f.host.createStorage().getKeys(); await flush();
  const first = f.opens[0]!; first.error = { name: 'VERSIONERROR', message: 'arbitrary' };
  const preventDefault = jest.fn(); first.onerror!({ preventDefault, target: { result: f.database } }); await flush();
  expect(preventDefault).toHaveBeenCalledTimes(1); expect(f.factory.open).toHaveBeenLastCalledWith('secure-store', 7);
  f.opens[1]!.onsuccess!(); await expect(read).resolves.toEqual([]);
});

it('falls back to an unversioned open if database version discovery is unavailable', async () => {
  const f = fixture(); f.manualOpen(); const read = f.host.createStorage().getKeys(); await flush();
  f.opens[0]!.error = { name: 'VersionError', message: '' };
  f.opens[0]!.onerror!({ preventDefault() {}, target: { result: f.database } }); await flush();
  expect(f.factory.open).toHaveBeenLastCalledWith('secure-store', undefined);
  f.opens[1]!.onsuccess!(); await expect(read).resolves.toEqual([]);
});

it('passes delete request errors through without retrying', async () => {
  const f = fixture(), deletion = request(undefined);
  deletion.error = { name: 'SyntheticDeleteFailure', message: 'failed' }; f.store.delete = () => deletion;
  const pending = f.host.createStorage().removeItem('a'); await flush(); f.transactions[0]!.onerror!();
  await expect(pending).rejects.toMatchObject({ name: 'SyntheticDeleteFailure', message: 'failed', origin: f.context.origin });
  expect(f.factory.open).toHaveBeenCalledTimes(1);
});

it('labels aborted writes with the generic transaction error and retries until exhausted', async () => {
  const f = fixture(); const pending = f.host.createStorage().setItemByKeys([['a', 'synthetic']]);
  const observed = expect(pending).rejects.toMatchObject({ name: 'TransactionAbortOrError', message: '' });
  for (let i = 0; i < 4; i++) { await flush(); f.transactions[i]!.onabort!(); }
  await observed; expect(f.transactions).toHaveLength(4);
});

it('reports quota without automatically deleting storage and observes a throwing report callback', async () => {
  const f = fixture(), failure = { name: 'QuotaExceededError', message: 'synthetic' };
  f.store.get = () => { const pending = request(undefined); pending.error = failure;
    queueMicrotask(() => pending.onerror?.({ preventDefault() {}, target: { result: f.database } })); return pending; };
  const diagnostics = jest.fn(); f.context.onBackgroundError = diagnostics;
  const callbackError = new Error('synthetic report failure');
  const callback = jest.fn(() => { throw callbackError; });
  await expect(f.host.createStorage({ onQuotaErrorCallback: callback }).getItemByKeys(['a'])).rejects.toBe(failure); await flush();
  expect(callback).toHaveBeenCalledTimes(3); expect(f.factory.deleteDatabase).not.toHaveBeenCalled();
  expect(diagnostics).toHaveBeenCalledTimes(3); expect(diagnostics).toHaveBeenCalledWith(callbackError);
});

it('composite storage exposes raw localDB and forwards its own QuotaError log', async () => {
  const f = fixture(), failure = { name: 'QuotaExceededError', message: 'synthetic' };
  f.store.get = () => { const pending = request(undefined); pending.error = failure;
    queueMicrotask(() => pending.onerror?.({ preventDefault() {}, target: { result: f.database } })); return pending; };
  const notification = jest.fn(), overridden = jest.fn(); f.context.onQuotaError = notification;
  const storage = f.host.createLocalStorage(() => undefined, { onQuotaErrorCallback: overridden }), logs = jest.fn(); storage.on('log', logs);
  await expect(storage.localDB.getItemByKeys(['a'])).rejects.toMatchObject({ name: 'LocalStorageNotSupport' });
  await storage.getItemByKeys(['a']); await flush();
  expect(logs).toHaveBeenCalledTimes(3); expect(logs).toHaveBeenCalledWith({ name: 'QuotaError' }); expect(notification).toHaveBeenCalledTimes(3);
  expect(overridden).not.toHaveBeenCalled(); expect(f.factory.deleteDatabase).not.toHaveBeenCalled();
});
