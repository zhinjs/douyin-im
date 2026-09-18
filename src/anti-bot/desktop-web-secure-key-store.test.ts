import { DesktopWebSecureKeyStore, DESKTOP_WEB_SECURE_INIT_KEYS, type DesktopWebSecureKeyStoreOptions } from './desktop-web-secure-key-store.js';
import { DesktopWebSecureStore } from './desktop-web-secure-store.js';
import { DesktopWebSecureIframeHost, type DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';
import { DesktopWebSecureBridgeHost } from './desktop-web-secure-bridge.js';
import { DesktopWebSecureLocalStorage, DesktopWebSecureMemoryArea, createDesktopWebSecureMemoryStorage } from './desktop-web-secure-local-storage.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(options: DesktopWebSecureKeyStoreOptions = {}, setup?: (store: DesktopWebSecureStore) => void) {
  const cookies = new Map<string, string>(), writes: string[] = [], area = new DesktopWebSecureMemoryArea();
  const document = { location: { hostname: 'app.synthetic.invalid' }, get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); }, set cookie(value: string) {
    writes.push(value); const pair = value.split(';')[0]!, index = pair.indexOf('='), key = pair.slice(0, index); if (value.includes('expires=')) cookies.delete(key); else cookies.set(key, pair.slice(index + 1));
  } };
  const local = createDesktopWebSecureMemoryStorage(area), db = new DesktopWebSecureLocalStorage(local, local, local, 'https://synthetic.invalid');
  const io: DesktopStorageIframeContext = { origin: 'https://synthetic.invalid', navigator: { userAgent: 'synthetic' }, window: {}, Date: { now: () => 100 }, performance: { now: () => 1 }, Math: { random: () => 0.1 },
    document: { body: null, readyState: 'complete', visibilityState: 'visible', getElementById: () => null, createElement: () => { throw Error('unexpected iframe'); }, addEventListener() {}, removeEventListener() {} },
    readLocalStorage: () => null, setTimeout: () => 0, clearTimeout() {}, addMessageListener() {}, removeMessageListener() {},
  };
  const host = new DesktopWebSecureIframeHost(io), parent = { postMessage() {} };
  const store = new DesktopWebSecureStore(host, new DesktopWebSecureBridgeHost(io), { window: { parent, postMessage() {} }, hostname: document.location.hostname,
    createLocalStorage: () => db, writeLocalStorage() {}, readCookie: () => document.cookie, queryIframes: () => [] }, { disableCrossStorage: true });
  setup?.(store); const diagnostics = jest.fn(), create = jest.fn(() => store);
  const keys = new DesktopWebSecureKeyStore({ document, Math: io.Math, createStore: create, onBackgroundError: diagnostics }, options);
  return { keys, store, local, area, document, cookies, writes, diagnostics, create };
}

it('constructs once and immediately preloads three logical keys without waiting for the read', async () => {
  const pending = deferred<Record<string, unknown>>(); let read!: jest.SpyInstance;
  const f = fixture({}, store => { read = jest.spyOn(store, 'getItemWithKeys').mockReturnValue(pending.promise); });
  expect(f.create).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith([...DESKTOP_WEB_SECURE_INIT_KEYS]);
  const follower = f.keys.getItems(['s_sdk_crypt_sdk']); await flush(); expect(read).toHaveBeenCalledTimes(1);
  pending.resolve({ s_sdk_crypt_sdk: 'synthetic', s_sdk_cert_key: '', 's_sdk_sign_data_key/web_protect': '' });
  await expect(follower).resolves.toEqual({ s_sdk_crypt_sdk: 'synthetic' });
});

it('disabled cache skips preload, preserves single argument and origin metadata', async () => {
  let get!: jest.SpyInstance, bulk!: jest.SpyInstance;
  const f = fixture({ enableCache: false }, store => { get = jest.spyOn(store, 'getItem').mockResolvedValue('x'); bulk = jest.spyOn(store, 'getItemWithKeys'); });
  expect(bulk).not.toHaveBeenCalled(); await f.keys.get('one'); expect(get).toHaveBeenCalledWith('one');
  await expect(f.keys.getItemsWithOrigin(['a'])).resolves.toEqual({ data: { a: { key: 'a', value: undefined, from: '-1', origin: 'https://synthetic.invalid' } }, from: '0' });
});

it('enabled single miss passes missing-key array to raw getter and shares cache with bulk', async () => {
  let get!: jest.SpyInstance; const f = fixture({}, store => { get = jest.spyOn(store, 'getItem').mockResolvedValue('x'); });
  await expect(f.keys.get('one')).resolves.toBe('x'); expect(get).toHaveBeenCalledWith(['one']);
  await expect(f.keys.getItems(['one'])).resolves.toEqual({ one: 'x' }); expect(get).toHaveBeenCalledTimes(1);
});

it('enabled origin getter strips original origin/from even on all-miss response', async () => {
  const f = fixture({}, store => { jest.spyOn(store, 'getItemsWithOrigin').mockResolvedValue({ data: { one: { key: 'one', value: 'x', from: '1', origin: 'https://remote.example' } }, from: '1' }); });
  await expect(f.keys.getItemsWithOrigin(['one'])).resolves.toEqual({ data: { one: { key: 'one', value: 'x' } }, from: '-1', summary: { total: 1, hit: 0, pending: 0, miss: 1, missKeys: ['one'] } });
  await expect(f.keys.getItemsWithOrigin(['one'])).resolves.toMatchObject({ summary: { hit: 1, miss: 0 } });
});

it('local-only writes bypass cache/version updates and can leave cached value stale', async () => {
  const f = fixture(); await f.keys.set('a', 'first'); await flush(); const writes = f.writes.length;
  await f.keys.setLocalItem('a', 'second'); expect(f.writes).toHaveLength(writes); await expect(f.keys.get('a')).resolves.toBe('first'); await expect(f.keys.getLocalItem('a')).resolves.toBe('second');
});

it('setter populates shared cache but equal values avoid cookie churn', async () => {
  const f = fixture({ agId: 0 }); await f.keys.set('a', { data: 1 }); await flush();
  const writes = f.writes.length; await f.keys.setItems(['a'], [{ data: 1 }]); await flush(); expect(f.writes).toHaveLength(writes);
  expect(f.writes.some(value => value.startsWith('__security_mc_1_a='))).toBe(true); await expect(f.keys.getItems(['a'])).resolves.toEqual({ a: { data: 1 } });
});

it('Fe reports sync and async failures as undefined without logging private values', async () => {
  const f = fixture({ enableCache: false }, store => {
    jest.spyOn(store, 'setItem').mockRejectedValue(Error('failure')); jest.spyOn(store, 'getItem').mockImplementation(() => { throw Error('sync'); });
  });
  const errors = jest.fn(), logs = jest.fn(); f.keys.on('error', errors); f.keys.on('log', logs);
  await expect(f.keys.set('key', 'private-material')).resolves.toBeUndefined(); await expect(f.keys.get('key')).resolves.toBeUndefined();
  expect(errors.mock.calls.map(call => call[0].name)).toEqual(['iframe set item error', 'iframe get item error']); expect(JSON.stringify(logs.mock.calls)).not.toContain('private-material');
  expect(logs).toHaveBeenCalledWith({ content: 'report error', extra: { key: 'key' }, level: 'error' });
});

it('Fe preserves original typo and slash key reporting for local bulk reads', async () => {
  const f = fixture({ enableCache: false }, store => { jest.spyOn(store, 'getLocalItemsWithKeys').mockRejectedValue(Error('failure')); });
  const errors = jest.fn(), logs = jest.fn(); f.keys.on('error', errors); f.keys.on('log', logs);
  await expect(f.keys.getLocalItems(['a/b', 'c'])).resolves.toBeUndefined(); expect(errors).toHaveBeenCalledWith(expect.objectContaining({ name: 'localstorage set item keys error' }));
  expect(logs).toHaveBeenCalledWith({ content: 'report error', extra: { a_b: '1', c: '1' }, level: 'error' });
});

it('error reporter observer failure propagates if the secondary error observer throws', async () => {
  const f = fixture({ enableCache: false }, store => { jest.spyOn(store, 'getItem').mockRejectedValue(Error('backend')); });
  f.keys.on('error', () => { throw Error('observer'); }); await expect(f.keys.get('a')).rejects.toThrow('observer');
});

it('setter rejection is swallowed for caller but detached cache error is observed separately', async () => {
  const failure = Error('synthetic'), f = fixture({}, store => { jest.spyOn(store, 'setItem').mockRejectedValue(failure); });
  await expect(f.keys.set('a', 'x')).resolves.toBeUndefined(); await flush(); expect(f.diagnostics).toHaveBeenCalledWith(failure);
});

it('getter failure remains queued after Fe reports it; subsequent call does not recover backend', async () => {
  let get!: jest.SpyInstance; const f = fixture({}, store => { get = jest.spyOn(store, 'getItem').mockRejectedValue(Error('backend')); });
  await expect(f.keys.get('a')).resolves.toBeUndefined(); get.mockResolvedValue('recovered'); await expect(f.keys.get('a')).resolves.toBeUndefined(); expect(get).toHaveBeenCalledTimes(1);
  f.keys.memoryCache.clear(); await expect(f.keys.get('a')).resolves.toBe('recovered');
});

it('construction captures raw operation methods; replacing the store method later does not change wrapper', async () => {
  const f = fixture({ enableCache: false }, store => { jest.spyOn(store, 'getItem').mockResolvedValue('original'); });
  f.store.getItem = async () => 'replacement'; await expect(f.keys.get('a')).resolves.toBe('original');
});

it('forwards store and Cookie errors, while state/checker methods bypass Fe', async () => {
  const f = fixture({ enableCache: false }, store => { jest.spyOn(store, 'getIframeStatus').mockImplementation(() => { throw Error('state'); }); });
  const errors = jest.fn(), load = jest.fn(); f.keys.on('error', errors); f.keys.on('load', load);
  f.store.emit('load', { stage: 'synthetic' }); expect(load).toHaveBeenCalledWith({ stage: 'synthetic' });
  f.cookies.set('bad', '%zz'); expect(f.keys.cookieOperate.getCookie('bad')).toBeNull(); expect(errors).toHaveBeenCalledWith(expect.objectContaining({ name: 'cookie get item error' }));
  expect(() => f.keys.getIframeStatus()).toThrow('state');
});
