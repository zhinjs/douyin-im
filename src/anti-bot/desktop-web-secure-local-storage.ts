import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';

export interface DesktopWebStorageBackend {
  getItemByKeys(keys: string[]): Promise<unknown[]>;
  setItemByKeys(entries: Array<[string, unknown]>): Promise<unknown[]>;
  removeItem(key: string): Promise<unknown>;
  getKeys(): Promise<unknown[]>;
}

export interface DesktopWebStorageValue {
  value: unknown;
  from: number;
  origin: string;
}

export interface DesktopWebStorageArea {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One JS realm's fallback area. Share within its owner, never between accounts. */
export class DesktopWebSecureMemoryArea implements DesktopWebStorageArea {
  // The original uses a plain object, not a Map or a null-prototype dictionary.
  private readonly values: Record<string, string> = {};
  get length(): number { return Object.keys(this.values).length; }
  key(index: number): string | null { return Object.keys(this.values)[index] ?? null; }
  getItem(key: string): string | null { return this.values[key] || null; }
  setItem(key: string, value: string): void { this.values[key] = `${value}`; }
  removeItem(key: string): void { delete this.values[key]; }
  keys(): string[] { return Object.keys(this.values); }
}

export function createDesktopWebSecureMemoryStorage(area: DesktopWebSecureMemoryArea): DesktopWebSecureAreaStorage {
  const storage = new DesktopWebSecureAreaStorage(() => Promise.resolve(area));
  // Ft includes the empty key; jt's localStorage enumerator does not.
  storage.getKeys = () => Promise.resolve(area).then(memory => memory.keys());
  return storage;
}

/** Native jt/Ft {data: value} serialization; opening is repeated for every call. */
export class DesktopWebSecureAreaStorage implements DesktopWebStorageBackend {
  constructor(private readonly open: () => Promise<DesktopWebStorageArea>) {}

  getItem = (key: string): Promise<unknown> => this.getItemByKeys([key]).then(values => values[0]);
  setItem = (key: string, value: unknown): Promise<unknown> => this.setItemByKeys([[key, value]]).then(values => values[0]);
  getItemByKeys = (keys: string[]): Promise<unknown[]> => this.open().then(area => keys.map(key => JSON.parse(area.getItem(key) || '{}').data));
  setItemByKeys = (entries: Array<[string, unknown]>): Promise<unknown[]> => this.open().then(area => entries.map(([key, value]) => {
    area.setItem(key, JSON.stringify({ data: value })); return value;
  }));
  removeItem = (key: string): Promise<void> => this.open().then(area => { area.removeItem(key); });
  getKeys = (): Promise<string[]> => this.open().then(area => {
    const keys: string[] = [];
    for (let index = 0; index < area.length; index++) if (area.key(index)) keys.push(area.key(index)!);
    return keys;
  });
}

export function createDesktopWebSecureLocalArea(readArea: () => DesktopWebStorageArea | undefined, origin: string): DesktopWebSecureAreaStorage {
  return new DesktopWebSecureAreaStorage(() => {
    // The getter is outside the support probe's try/catch, matching Nt()/jt.
    const area = readArea();
    let supported = false;
    if (area) try {
      const key = '__x_storage_test__';
      area.setItem(key, key); const value = area.getItem(key); area.removeItem(key);
      supported = value === key;
    } catch { /* A failed support probe selects the next backend. */ }
    if (supported) return Promise.resolve(readArea()!);
    return Promise.reject(Object.assign(new Error(''), { name: 'LocalStorageNotSupport', origin }));
  });
}

/** Native ce read/write ordering. A fulfilled write does NOT imply both stores committed. */
export class DesktopWebSecureLocalStorage extends DesktopWebSecureEvents {
  private readonly db: Promise<DesktopWebStorageBackend[]>;

  constructor(
    readonly localDB: DesktopWebStorageBackend,
    indexed: DesktopWebStorageBackend,
    private readonly fallback: DesktopWebStorageBackend,
    private readonly origin: string,
  ) { super(); this.db = Promise.resolve([localDB, indexed]); }

  getItem = (key: string): Promise<DesktopWebStorageValue | undefined> => this.getItemByKeys([key]).then(values => values[0]);
  setItem = (key: string, value: unknown): Promise<DesktopWebStorageValue | undefined> => this.setItemByKeys([[key, value]]).then(values => values[0]);

  getItemByKeys = (keys: string[]): Promise<DesktopWebStorageValue[]> => {
    let from = -1;
    const observed: DesktopWebStorageValue[][] = [];
    return this.db.then(backends => runSerial(backends.map((backend, index) => () => backend.getItemByKeys(keys).then(values => {
      observed[index] = keys.map((_key, position) => ({ from: values[position] !== undefined ? index : -1, value: values[position], origin: this.origin }));
      return values;
    })), values => {
      for (let i = 0; i < (values?.length ?? 0); i++) if (values?.[i] === undefined) return true;
      return false;
    })).catch(() => this.fallback.getItemByKeys(keys).then(values => { from = 2; return values; })).then(values => {
      if (observed[0]) return observed[0].map((local, index) => {
        if (local.value !== undefined) return local;
        const indexed = observed[1]?.[index];
        return indexed && indexed.value !== undefined ? indexed : local;
      });
      if (observed[1]) return observed[1];
      return values.map(value => ({ value, from, origin: this.origin }));
    });
  };

  setItemByKeys = (entries: Array<[string, unknown]>): Promise<DesktopWebStorageValue[]> => {
    let from = -1;
    return this.db.then(backends => runFirstResolved(backends.map((backend, index) => () => backend.setItemByKeys(entries).then(values => {
      from = index; return values;
    }))).catch(() => { from = 2; return this.fallback.setItemByKeys(entries); })
      .then(values => values.map(value => ({ value, from, origin: this.origin })))).then(values => values, error => {
      // Keep ce's final fulfillment/rejection hop; its oe hook is renderer-only telemetry.
      throw error;
    });
  };

  removeItem = (key: string): Promise<unknown> => this.db.then(backends => Promise.all(backends.map(backend => backend.removeItem(key)))
    .then(() => this.fallback.removeItem(key)));

  getKeys = (): Promise<unknown[]> => this.db.then(backends => runSerial(backends.map(backend => () => backend.getKeys()), keys => keys === undefined || keys.length === 0));
}

function runSerial<T>(operations: Array<() => Promise<T>>, retryResult: (value: T) => boolean): Promise<T> {
  let result = Promise.reject<T>(new Error('WebStorageRunSerialQueueError'));
  for (const operation of operations) {
    // The catch belongs to this step: a rejected selected operation runs again.
    result = result.then(value => retryResult(value) || value === undefined ? operation() : value).catch(() => operation());
  }
  return result;
}

function runFirstResolved<T>(operations: Array<() => Promise<T>>): Promise<T> {
  let result = Promise.reject<T>(new Error('WebStorageRunSerialQueueIfOneResolveError'));
  for (const operation of operations) result = result.then(value => { void operation().catch(() => undefined); return value; }).catch(() => operation());
  return result;
}
