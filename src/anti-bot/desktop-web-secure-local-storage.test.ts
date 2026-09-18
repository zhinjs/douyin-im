import {
  DesktopWebSecureLocalStorage, DesktopWebSecureMemoryArea, createDesktopWebSecureLocalArea,
  createDesktopWebSecureMemoryStorage, type DesktopWebStorageBackend,
} from './desktop-web-secure-local-storage.js';
import { DesktopWebSecureIndexedStorageHost } from './desktop-web-secure-indexed-storage.js';

const origin = 'https://synthetic.invalid';
function backend(overrides: Partial<DesktopWebStorageBackend> = {}): DesktopWebStorageBackend {
  return { getItemByKeys: jest.fn(async () => []), setItemByKeys: jest.fn(async entries => entries.map(([, value]) => value)),
    removeItem: jest.fn(async () => undefined), getKeys: jest.fn(async () => []), ...overrides };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

it('stores JSON envelopes, preserves falsy values and shares memory only within its owner', async () => {
  const area = new DesktopWebSecureMemoryArea(), a = createDesktopWebSecureMemoryStorage(area), b = createDesktopWebSecureMemoryStorage(area);
  await a.setItemByKeys([['empty', ''], ['zero', 0], ['false', false], ['null', null], ['missing', undefined]]);
  expect(area.getItem('missing')).toBe('{}');
  await expect(b.getItemByKeys(['empty', 'zero', 'false', 'null', 'missing'])).resolves.toEqual(['', 0, false, null, undefined]);
  await expect(createDesktopWebSecureMemoryStorage(new DesktopWebSecureMemoryArea()).getItem('zero')).resolves.toBeUndefined();
});

it('probes localStorage on every operation and skips only its empty key in key enumeration', async () => {
  const area = new DesktopWebSecureMemoryArea(); area.setItem('', '{"data":1}');
  const read = jest.fn(() => area), local = createDesktopWebSecureLocalArea(read, origin);
  await local.setItem('a', 0); await local.getItem('a');
  expect(read).toHaveBeenCalledTimes(4); expect(area.getItem('__x_storage_test__')).toBeNull();
  await expect(local.getKeys()).resolves.toEqual(['a']);
  await expect(createDesktopWebSecureMemoryStorage(area).getKeys()).resolves.toEqual(['', 'a']);
});

it('does not swallow a throwing localStorage getter but rejects a failed support probe', async () => {
  const failure = new Error('synthetic permission failure');
  const throwing = createDesktopWebSecureLocalArea(() => { throw failure; }, origin);
  expect(() => throwing.getItem('a')).toThrow(failure);
  const area = new DesktopWebSecureMemoryArea(); area.setItem = () => { throw failure; };
  await expect(createDesktopWebSecureLocalArea(() => area, origin).getItem('a')).rejects.toMatchObject({ name: 'LocalStorageNotSupport', origin });
});

it('keeps partial writes before serialization failure and rejects malformed stored JSON', async () => {
  const area = new DesktopWebSecureMemoryArea(), storage = createDesktopWebSecureMemoryStorage(area);
  await expect(storage.setItemByKeys([['a', 1], ['b', 1n]])).rejects.toThrow(TypeError);
  await expect(storage.getItem('a')).resolves.toBe(1); expect(area.getItem('b')).toBeNull();
  area.setItem('broken', '{'); await expect(storage.getItem('broken')).rejects.toThrow(SyntaxError);
});

it('fills only undefined local slots from IndexedDB, not null, empty or false', async () => {
  const local = backend({ getItemByKeys: async () => [undefined, null, '', false] });
  const indexed = backend({ getItemByKeys: async () => ['I', 'I', 'I', 'I'] });
  const fallback = backend(), store = new DesktopWebSecureLocalStorage(local, indexed, fallback, origin);
  await expect(store.getItemByKeys(['a', 'b', 'c', 'd'])).resolves.toEqual([
    { value: 'I', from: 1, origin }, { value: null, from: 0, origin }, { value: '', from: 0, origin }, { value: false, from: 0, origin },
  ]);
  expect(fallback.getItemByKeys).not.toHaveBeenCalled();
});

it('retries a selected failed second read once, but discards fallback values when a local snapshot exists', async () => {
  const local = backend({ getItemByKeys: async () => ['L', undefined] });
  const indexed = backend({ getItemByKeys: jest.fn(async () => { throw Error('synthetic'); }) });
  const fallback = backend({ getItemByKeys: jest.fn(async () => ['M', 'N']) });
  const store = new DesktopWebSecureLocalStorage(local, indexed, fallback, origin);
  await expect(store.getItemByKeys(['a', 'b'])).resolves.toEqual([{ value: 'L', from: 0, origin }, { value: undefined, from: -1, origin }]);
  expect(indexed.getItemByKeys).toHaveBeenCalledTimes(2); expect(fallback.getItemByKeys).toHaveBeenCalledTimes(1);
});

it('uses memory only after both backends reject without a completed persistent snapshot', async () => {
  const fail = jest.fn(async () => { throw Error('synthetic'); });
  const store = new DesktopWebSecureLocalStorage(backend({ getItemByKeys: fail }), backend({ getItemByKeys: fail }), backend({ getItemByKeys: async () => ['M'] }), origin);
  await expect(store.getItem('a')).resolves.toEqual({ value: 'M', from: 2, origin }); expect(fail).toHaveBeenCalledTimes(2);
});

it('starts the second write but does not wait for it after the first succeeds', async () => {
  let complete!: (values: unknown[]) => void;
  const indexed = backend({ setItemByKeys: jest.fn(() => new Promise(resolve => { complete = resolve; })) });
  const store = new DesktopWebSecureLocalStorage(backend(), indexed, backend(), origin);
  await expect(store.setItem('a', 'L')).resolves.toEqual({ value: 'L', from: 0, origin });
  expect(indexed.setItemByKeys).toHaveBeenCalledTimes(1); complete(['I']); await flush();
});

it('preserves source race: fast second write can label the first result with from=1', async () => {
  const store = new DesktopWebSecureLocalStorage(backend({ setItemByKeys: async () => ['L'] }), backend({ setItemByKeys: async () => ['I'] }), backend(), origin);
  await expect(store.setItem('a', 'value')).resolves.toEqual({ value: 'L', from: 1, origin });
});

it('observes a detached second write failure without converting the first success into failure', async () => {
  const fallback = backend(), store = new DesktopWebSecureLocalStorage(backend(), backend({ setItemByKeys: async () => { throw Error('synthetic'); } }), fallback, origin);
  await expect(store.setItem('a', 'L')).resolves.toMatchObject({ value: 'L' }); await flush();
  expect(fallback.setItemByKeys).not.toHaveBeenCalled();
});

it('does not remove memory if either persistent deletion fails', async () => {
  const fallback = backend(), indexed = backend(), failure = new Error('synthetic');
  const store = new DesktopWebSecureLocalStorage(backend({ removeItem: async () => { throw failure; } }), indexed, fallback, origin);
  await expect(store.removeItem('a')).rejects.toBe(failure);
  expect(indexed.removeItem).toHaveBeenCalledWith('a'); expect(fallback.removeItem).not.toHaveBeenCalled();
});

it('lists keys from the first nonempty persistent backend, never merges or lists memory', async () => {
  const indexed = backend({ getKeys: jest.fn(async () => ['I']) }), fallback = backend();
  const store = new DesktopWebSecureLocalStorage(backend({ getKeys: async () => ['L'] }), indexed, fallback, origin);
  await expect(store.getKeys()).resolves.toEqual(['L']); expect(indexed.getKeys).not.toHaveBeenCalled(); expect(fallback.getKeys).not.toHaveBeenCalled();
});

it('assembles local plus IDB plus owner-scoped memory without pretending memory is durable', async () => {
  const host = () => new DesktopWebSecureIndexedStorageHost({ origin, readIndexedDB: () => undefined, setTimeout: () => 1, clearTimeout: () => undefined });
  const first = host(), a = first.createLocalStorage(() => undefined), b = first.createLocalStorage(() => undefined);
  await expect(a.setItem('key', 'synthetic')).resolves.toEqual({ value: 'synthetic', from: 2, origin });
  await expect(b.getItem('key')).resolves.toEqual({ value: 'synthetic', from: 2, origin });
  await expect(host().createLocalStorage(() => undefined).getItem('key')).resolves.toEqual({ value: undefined, from: 2, origin });
});
