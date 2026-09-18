// Execute source-owned storage algorithms against synthetic browser I/O, never account data.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Usage: node scripts/research/desktop-web-secure-storage-oracle.cjs /path/to/860.js');
const source = readFileSync(resolve(process.argv[2]), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const code = 'var yt;var ' + source.slice(source.indexOf('St=(yt='), source.indexOf('const Rt=Bt')) +
  'const Rt=Bt;var ' + source.slice(source.indexOf('Lt=function'), source.indexOf('var Jt=window')) +
  'var ' + source.slice(source.indexOf('Yt=function'), source.indexOf(',te=function')) + ';var ' +
  source.slice(source.indexOf('ie=function'), source.indexOf(';var ue=')) + ';globalThis.original={Bt,Mt,Wt,ce};';
const normalize = value => structuredClone(value);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function result(operation) {
  try { return { value: normalize(await operation()) }; }
  catch (error) { return { error: { name: error?.name, message: error?.message, origin: error?.origin } }; }
}
function environment(mode = 'normal') {
  const trace = [], data = new Map(), localData = new Map();
  let version = 1, hasStore = mode !== 'upgrade', opens = 0, timer = 0;
  const local = {
    get length() { return localData.size; }, key: n => [...localData.keys()][n] ?? null,
    getItem(key) { trace.push(['local.get', key]); return localData.get(key) ?? null; },
    setItem(key, value) { trace.push(['local.set', key, value]); localData.set(key, value); },
    removeItem(key) { trace.push(['local.remove', key]); localData.delete(key); },
  };
  const makeRequest = value => {
    const request = { result: value, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => request.onsuccess?.()); return request;
  };
  const factory = {
    databases() { trace.push(['databases']); return Promise.resolve([{ name: 'secure-store', version: 7 }]); },
    deleteDatabase(name) { trace.push(['deleteDatabase', name]); return makeRequest(undefined); },
    open(name, requestedVersion) {
      trace.push(['open', name, requestedVersion]); opens++;
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (mode === 'version' && opens === 1) {
          request.error = { name: 'VersionError', message: 'arbitrary' };
          request.onerror?.({ preventDefault() { trace.push(['preventDefault']); } }); return;
        }
        if (mode === 'open-fail') {
          request.error = { name: 'QuotaExceededError', message: 'synthetic' };
          request.onerror?.({ preventDefault() { trace.push(['preventDefault']); } }); return;
        }
        const upgrading = requestedVersion > version;
        if (requestedVersion) version = requestedVersion;
        request.result = {
          version, objectStoreNames: { contains: () => hasStore },
          createObjectStore(name) { trace.push(['createStore', name]); hasStore = true; },
          close() { trace.push(['close']); },
          transaction(storeName, mode) {
            trace.push(['transaction', storeName, mode]);
            let complete;
            const tx = { onabort: null, onerror: null,
              get oncomplete() { return complete; },
              set oncomplete(callback) { complete = callback; queueMicrotask(() => callback()); },
              objectStore() { return {
                get(key) { trace.push(['get', key]); return makeRequest(data.get(key)); },
                put(value, key) { trace.push(['put', key, value]); data.set(key, value); },
                delete(key) { trace.push(['delete', key]); data.delete(key); return makeRequest(undefined); },
                openKeyCursor() {
                  trace.push(['cursor']); const keys = [...data.keys()]; let i = 0;
                  const request = { result: null, onsuccess: null, onerror: null, error: null };
                  const advance = () => queueMicrotask(() => {
                    request.result = i < keys.length ? { key: keys[i++], continue: advance } : null;
                    request.onsuccess?.();
                  }); advance(); return request;
                },
              }; },
            }; return tx;
          },
        };
        if (upgrading) request.onupgradeneeded?.({ target: { result: request.result } });
        request.onsuccess?.();
      }); return request;
    },
  };
  const context = { origin: 'https://synthetic.invalid', readIndexedDB: () => mode === 'unsupported' ? undefined : factory,
    setTimeout(callback, delay) { trace.push(['timer', delay]); return ++timer; },
    clearTimeout(handle) { trace.push(['clearTimer', handle]); },
  };
  return { context, trace, data, localData, local, factory: context.readIndexedDB() };
}
function native(f) {
  const sandbox = vm.createContext({ window: { localStorage: f.local, indexedDB: f.factory }, indexedDB: f.factory,
    webkitIndexedDB: undefined, mozIndexedDB: undefined, OIndexedDB: undefined,
    location: { origin: f.context.origin }, zt: { origin: f.context.origin },
    setTimeout: f.context.setTimeout, clearTimeout: f.context.clearTimeout, dt: EventEmitter, oe() {}, Promise });
  vm.runInContext(code, sandbox);
  return sandbox.original;
}
async function indexedTrace(create, mode) {
  const f = environment(mode), backend = create(f), values = [];
  if (mode === 'malformed') f.data.set('a', 'malformed');
  values.push(await result(() => backend.getItemByKeys(['a', 'b'])));
  values.push(await result(() => backend.setItemByKeys([['a', 'synthetic'], ['b', null]])));
  values.push(await result(() => backend.setItemByKeys([['a', 'synthetic'], ['b', null]])));
  values.push(await result(() => backend.getItemByKeys(['a', 'b'])));
  values.push(await result(() => backend.getKeys()));
  values.push(await result(() => backend.removeItem('a')));
  await flush(); return normalize({ trace: f.trace, data: [...f.data], values });
}
async function compositeTrace(create, scenario) {
  const trace = [], failure = Object.assign(new Error('synthetic'), { name: 'StorageFailure' });
  const make = (id, values) => ({
    getItemByKeys: keys => { trace.push(['get', id, keys]); return values === 'reject' ? Promise.reject(failure) : Promise.resolve(values); },
    setItemByKeys: entries => { trace.push(['set', id, entries]); return values === 'reject' ? Promise.reject(failure) : Promise.resolve([id]); },
    removeItem: key => { trace.push(['remove', id, key]); return values === 'reject' ? Promise.reject(failure) : Promise.resolve(); },
    getKeys: () => { trace.push(['keys', id]); return values === 'reject' ? Promise.reject(failure) : Promise.resolve(values); },
  });
  const cases = [ [['L', undefined], ['I', 'B']], [['L', undefined], 'reject'], ['reject', ['I', undefined]], ['reject', 'reject'], [[null, false], ['I', 'B']], [[], ['I', 'B']] ];
  const [left, right] = cases[scenario], backends = [make('local', left), make('indexed', right)], fallback = make('memory', ['M', 'N']);
  const store = create(backends, fallback), values = [];
  values.push(await result(() => store.getItemByKeys(['a', 'b'])));
  values.push(await result(() => store.setItemByKeys([['a', 'value']])));
  values.push(await result(() => store.getKeys()));
  values.push(await result(() => store.removeItem('a')));
  await flush(); return normalize({ values, trace });
}
async function areaTrace(create, memory) {
  const f = environment(), backend = create(f), values = [];
  values.push(await result(() => backend.setItemByKeys([['a', 'v'], ['', null], ['zero', 0], ['missing', undefined]])));
  values.push(await result(() => backend.getItemByKeys(['a', '', 'zero', 'missing', 'absent'])));
  values.push(await result(() => backend.getKeys()));
  values.push(await result(() => backend.removeItem('a')));
  values.push(await result(() => backend.getKeys()));
  return normalize({ values, trace: memory ? [] : f.trace, data: memory ? [] : [...f.localData] });
}
void (async () => {
  const local = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-local-storage.js')).href);
  const { DesktopWebSecureIndexedStorageHost } = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-indexed-storage.js')).href);
  let count = 0;
  for (const mode of ['normal', 'upgrade', 'version', 'malformed', 'unsupported', 'open-fail']) {
    const original = await indexedTrace(f => new (native(f).Bt)(), mode);
    const sdk = await indexedTrace(f => new DesktopWebSecureIndexedStorageHost(f.context).createStorage(), mode);
    assert.deepEqual(sdk, original, `indexed ${mode}`); count++;
  }
  for (let i = 0; i < 6; i++) {
    const original = await compositeTrace((backends, fallback) => { const store = new (native(environment()).ce)(); store.db = Promise.resolve(backends); store.fallbackDB = fallback; return store; }, i);
    const sdk = await compositeTrace(([a, b], fallback) => new local.DesktopWebSecureLocalStorage(a, b, fallback, 'https://synthetic.invalid'), i);
    assert.deepEqual(sdk, original, `composite ${i}`); count++;
  }
  for (const memory of [false, true]) {
    const original = await areaTrace(f => new (native(f)[memory ? 'Wt' : 'Mt'])(), memory);
    const sdk = await areaTrace(f => memory ? local.createDesktopWebSecureMemoryStorage(new local.DesktopWebSecureMemoryArea()) : local.createDesktopWebSecureLocalArea(() => f.local, f.context.origin), memory);
    assert.deepEqual(sdk, original, `area memory=${memory}`); count++;
  }
  console.log(`PASS ${count} original / built SDK IndexedDB, local, memory and composite storage traces`);
})().catch(error => { console.error(error); process.exitCode = 1; });
