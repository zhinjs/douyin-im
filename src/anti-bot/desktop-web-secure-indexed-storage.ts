import {
  DesktopWebSecureLocalStorage, DesktopWebSecureMemoryArea,
  createDesktopWebSecureLocalArea, createDesktopWebSecureMemoryStorage,
  type DesktopWebStorageArea, type DesktopWebStorageBackend,
} from './desktop-web-secure-local-storage.js';

interface StorageError { name?: string; message?: string }
interface RequestEvent { preventDefault(): void; target: { result: DesktopWebIdbDatabase } }
export interface DesktopWebIdbRequest<T = unknown> {
  result: T;
  error: StorageError | null;
  transaction?: { error: StorageError | null } | null;
  onsuccess: (() => void) | null;
  onerror: ((event: RequestEvent) => void) | null;
}
export interface DesktopWebIdbOpenRequest extends DesktopWebIdbRequest<DesktopWebIdbDatabase> {
  onupgradeneeded: ((event: RequestEvent) => void) | null;
}
export interface DesktopWebIdbStore {
  get(key: string): DesktopWebIdbRequest;
  put(value: string, key: string): unknown;
  delete(key: string): DesktopWebIdbRequest;
  openKeyCursor(): DesktopWebIdbRequest<{ key: unknown; continue(): void } | null>;
}
export interface DesktopWebIdbTransaction {
  objectStore(name: string): DesktopWebIdbStore;
  oncomplete: (() => void) | null;
  onabort: (() => void) | null;
  onerror: (() => void) | null;
}
export interface DesktopWebIdbDatabase {
  version: number;
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode?: 'readonly' | 'readwrite'): DesktopWebIdbTransaction;
  close(): void;
}
export interface DesktopWebIdbFactory {
  open(name: string, version?: number): DesktopWebIdbOpenRequest;
  databases?: () => Promise<Array<{ name?: string; version?: number }>>;
  deleteDatabase?: (name: string) => DesktopWebIdbRequest | undefined;
}
export interface DesktopWebIdbContext {
  /** Resolve the owner's indexedDB/global vendor aliases; no Node database substitute. */
  readIndexedDB(): DesktopWebIdbFactory | undefined;
  origin: string;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  onQuotaError?: () => void;
  onBackgroundError?: (error: unknown) => void;
}
export interface DesktopWebIdbConfig {
  dbName?: string;
  storeName?: string;
  closeDBTime?: number;
  version?: number;
  onQuotaErrorCallback?: (clean: (name?: string) => Promise<void>) => void;
}

/** Own one realm's native Bt state: DB promises, close timers and the shared serial queue. */
export class DesktopWebSecureIndexedStorageHost {
  private readonly databases: Record<string, Promise<DesktopWebIdbDatabase> | undefined> = {};
  private readonly timers: Record<string, unknown> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private attempts = 0;
  private readonly memory = new DesktopWebSecureMemoryArea();

  constructor(private readonly context: DesktopWebIdbContext) {}

  createLocalStorage(readArea: () => DesktopWebStorageArea | undefined, config: DesktopWebIdbConfig = {}): DesktopWebSecureLocalStorage {
    const storage = new DesktopWebSecureLocalStorage(createDesktopWebSecureLocalArea(readArea, this.context.origin),
      this.createStorage({ ...config, onQuotaErrorCallback: () => { storage.emit('log', { name: 'QuotaError' }); this.context.onQuotaError?.(); } }),
      createDesktopWebSecureMemoryStorage(this.memory), this.context.origin);
    return storage;
  }

  createStorage(config: DesktopWebIdbConfig = {}): DesktopWebStorageBackend {
    const settings = { dbName: 'secure-store', storeName: 'cryptvalues', closeDBTime: 20000, ...config };
    const open = (): Promise<DesktopWebIdbDatabase> => {
      this.context.clearTimeout(this.timers[settings.dbName]);
      this.timers[settings.dbName] = this.context.setTimeout(() => { void this.closeDB(settings.dbName).catch(() => undefined); }, settings.closeDBTime);
      return this.openDB(settings).then(db => {
        if (!db.objectStoreNames.contains(settings.storeName)) {
          const version = db.version + 1;
          return this.closeDB(settings.dbName).then(() => this.openDB(settings, version));
        }
        return db;
      });
    };
    const transaction = <T>(operation: () => Promise<T>): Promise<T> => {
      const run = (): Promise<T> => operation().then(value => { this.attempts = 0; return value; }).catch(error => {
        if (this.attempts < 3) {
          this.attempts++; this.databases[settings.dbName] = undefined;
          const quota = String((error as StorageError | null)?.name || '').toLowerCase() === 'quotaexceedederror';
          // Native does not await this notification or clean the database automatically.
          void Promise.resolve().then(() => {
            if (quota) settings.onQuotaErrorCallback?.call(storage, name => this.cleanDB(name || settings.dbName));
          }).catch(error => { try { this.context.onBackgroundError?.(error); } catch { /* Detached diagnostics cannot replace the operation result. */ } });
          return run();
        }
        this.attempts = 0; throw error;
      });
      // No catch/recovery here: an exhausted failure poisons the native shared queue.
      const result = this.queue.then(run);
      this.queue = result;
      return result;
    };
    const storage: DesktopWebStorageBackend = {
      getItemByKeys: keys => transaction(() => open().then(db => {
        const store = db.transaction(settings.storeName, 'readonly').objectStore(settings.storeName);
        return Promise.all(keys.map(key => request(store.get(key)).then(value => JSON.parse((value || '{}') as string).data)));
      })),
      setItemByKeys: entries => transaction(() => open().then(db => {
        const tx = db.transaction(settings.storeName, 'readwrite'), store = tx.objectStore(settings.storeName);
        return Promise.all(entries.map(([key, value]) => {
          const serialized = JSON.stringify({ data: value });
          return request(store.get(key)).then(previous => { if (previous !== serialized) store.put(serialized, key); return value; });
        })).then(values => this.transactionComplete(tx).then(() => values));
      })),
      // Native deletion bypasses the poisoned queue and transaction retry wrapper.
      removeItem: key => open().then(db => {
        const tx = db.transaction(settings.storeName, 'readwrite'), deletion = tx.objectStore(settings.storeName).delete(key);
        return this.transactionComplete(tx, deletion);
      }),
      getKeys: () => transaction(() => open().then(db => {
        const cursor = db.transaction(settings.storeName).objectStore(settings.storeName).openKeyCursor();
        return new Promise<unknown[]>((resolve, reject) => {
          const keys: unknown[] = [];
          cursor.onsuccess = () => { if (cursor.result) { keys.push(cursor.result.key); cursor.result.continue(); } else resolve(keys); };
          cursor.onerror = () => { reject(cursor.error); };
        });
      })),
    };
    return storage;
  }

  closeDB(name: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const pending = this.databases[name];
      if (!pending) { resolve(-1); return; }
      void pending.then(db => { this.databases[name] = undefined; try { db.close(); resolve(1); } catch (error) { reject(error); } }).catch(reject);
    });
  }

  private factory(): DesktopWebIdbFactory | undefined {
    try { return this.context.readIndexedDB(); } catch { return undefined; }
  }

  private error(name: string, message = ''): Error {
    return Object.assign(new Error(message || ''), { name, origin: this.context.origin });
  }

  private openDB(config: { dbName: string; storeName: string; version?: number }, version?: number): Promise<DesktopWebIdbDatabase> {
    if (version) this.databases[config.dbName] = undefined;
    if (!this.factory()) return Promise.reject(this.error('DBStorageNotSupport'));
    const factory = this.factory();
    const open = (name: string, requestedVersion?: number): Promise<DesktopWebIdbDatabase> => new Promise((resolve, reject) => {
      const pending = factory!.open(name, requestedVersion);
      pending.onsuccess = () => { resolve(pending.result); };
      pending.onerror = event => { event.preventDefault(); reject(this.error(pending.error?.name || 'IndexedDBOpenError', pending.error?.message)); };
      pending.onupgradeneeded = event => { try { (pending.result || event.target.result).createObjectStore(config.storeName); } catch (error) { reject(error); } };
    });
    if (!this.databases[config.dbName]) this.databases[config.dbName] = new Promise((resolve, reject) => {
      try {
        void open(config.dbName, version || config.version || 1).catch(error => {
          // Native Lt's match() comparison makes every ordinary VersionError eligible.
          if (String((error as StorageError | null)?.name || '').toLowerCase() !== 'versionerror') throw error;
          return this.getDatabaseVersion(config.dbName).then(actual => actual ? open(config.dbName, actual) : open(config.dbName))
            .catch(() => open(config.dbName));
        }).then(resolve).catch(reject);
      } catch (error) { reject(this.error('DBStorageNotSupport', (error as StorageError).message)); }
    });
    return this.databases[config.dbName]!;
  }

  private getDatabaseVersion(name: string): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
      const factory = this.factory();
      if (factory?.databases) { void factory.databases().then(entries => { resolve(entries.filter(entry => entry.name === name)[0]?.version); }).catch(reject); return; }
      reject(new Error(`idb.database is ${typeof factory?.databases}`));
    });
  }

  private cleanDB(name: string): Promise<void> {
    const deletion = this.factory()?.deleteDatabase?.(name);
    return new Promise(resolve => {
      if (deletion) { deletion.onsuccess = () => { resolve(); }; deletion.onerror = () => { resolve(); }; } else resolve();
    });
  }

  private transactionComplete(tx: DesktopWebIdbTransaction, operation?: DesktopWebIdbRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => { resolve(); };
      tx.onabort = tx.onerror = () => {
        const error = operation ? operation.error || operation.transaction?.error : { name: 'TransactionAbortOrError', message: '' };
        reject(this.error(error?.name || 'TransactionAbortOrError', error?.message));
      };
    });
  }
}

function request<T>(pending: DesktopWebIdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { pending.onsuccess = () => { resolve(pending.result); }; pending.onerror = () => { reject(pending.error); }; });
}
