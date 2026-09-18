const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Provide the audited C860 path');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const prefix = 'var lt={proxy:function(){}};var ' + source.slice(source.indexOf('ht=(lt.proxy'), source.indexOf('const pt=')) +
  'var ' + source.slice(86903, 87954) + ';var ' + source.slice(92716, 97420) + ';var ' + source.slice(89173, 91242) +
  'var ' + source.slice(source.indexOf('Oe=function'), source.indexOf(',Me=function')) + ';var ' + source.slice(68096, 68444) + ';var ' + source.slice(97896, source.indexOf(',Rr=function'));
const init = source.slice(101515 + 'r.initIframeStore='.length, 104322);
const report = source.slice(source.indexOf('r.reportError=') + 'r.reportError='.length, source.indexOf(',r.getKeysInfo='));
const code = prefix + ';var r=owner;var Qe=Store;owner.reportError=' + report + ';owner.init=' + init + ';globalThis.Cookie=mr;';
function eventTarget() { const map = {}; return { on(name, fn) { (map[name] ||= []).push(fn); }, emit(name, data) { (map[name] || []).slice().forEach(fn => fn(data)); } }; }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function track(promise) { const result = { status: 'pending' }; void promise.then(value => Object.assign(result, { status: 'fulfilled', value }), error => Object.assign(result, { status: 'rejected', name: error.name, message: error.message })); return result; }
function fixture(mode) {
  const cookies = new Map(), writes = [], calls = [], events = [], data = { a: 'A', b: 'B', empty: '' };
  let random = 0, release;
  const document = { location: { hostname: 'app.synthetic.invalid' }, get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); }, set cookie(value) { writes.push(value); const pair = value.split(';')[0], split = pair.indexOf('='), key = pair.slice(0, split); if (value.includes('expires=')) cookies.delete(key); else cookies.set(key, pair.slice(split + 1)); } };
  const math = Object.create(Math); math.random = () => (random++ % 16) / 16;
  const store = Object.assign(eventTarget(), {
    getItem: (...args) => { calls.push(['get', ...args]); return Promise.resolve(data[String(args[0])] ?? ''); },
    getItemWithKeys: keys => { calls.push(['getItems', keys]); return mode === 'preload' && keys.includes('s_sdk_crypt_sdk') ? new Promise(resolve => { release = resolve; }) : Promise.resolve(Object.fromEntries(keys.map(key => [key, data[key]]))); },
    getItemsWithOrigin: keys => { calls.push(['origins', keys]); return Promise.resolve({ data: Object.fromEntries(keys.map(key => [key, { key, value: data[key], from: '1', origin: 'remote' }])), from: '1' }); },
    setItem: (...args) => { calls.push(['set', ...args]); data[args[0]] = args[1]; return Promise.resolve({ cross: '0' }); },
    setItemWithKeys: (...args) => { calls.push(['setItems', ...args]); args[0].forEach((key, i) => { data[key] = args[1][i]; }); return Promise.resolve({ cross: '0' }); },
    deleteItem: key => { calls.push(['delete', key]); delete data[key]; return Promise.resolve(); },
    getLocalItem: key => { calls.push(['local.get', key]); return Promise.resolve(data[key]); },
    setLocalItem: (...args) => { calls.push(['local.set', ...args]); data[args[0]] = args[1]; return Promise.resolve(); },
    getLocalItemsWithKeys: keys => { calls.push(['local.many', keys]); return Promise.resolve(Object.fromEntries(keys.map(key => [key, data[key]]))); },
    getIframeStatus: () => false, getStorageStatus: () => ({ isConnection: -1 }), startStorageChecker: () => undefined,
  });
  if (mode === 'failure') for (const name of ['getItem', 'setItem', 'deleteItem', 'getItemWithKeys', 'setItemWithKeys', 'getItemsWithOrigin', 'getLocalItem', 'setLocalItem', 'getLocalItemsWithKeys']) store[name] = (...args) => { calls.push([name, ...args]); return Promise.reject(Error('synthetic')); };
  return { context: { document, Math: math }, store, calls, writes, events, data, cookies, release: value => release(value) };
}
async function run(kind, modules, mode) {
  const f = fixture(mode), enabled = !['disabled', 'failure', 'cookie', 'cookie-duplicates'].includes(mode);
  let api, cookie, cache;
  if (kind === 'native') {
    const owner = { enableCache: enabled, _agid: 0, _getInitKeys: () => ['s_sdk_crypt_sdk', 's_sdk_cert_key', 's_sdk_sign_data_key/web_protect'], emit: (name, data) => f.events.push([name, data]) };
    const sandbox = vm.createContext({ ...f.context, Promise, owner, Store: function() { return f.store; } }); vm.runInContext(code, sandbox);
    const initialized = owner.init(); api = owner._storeSDK; cookie = owner.cookieOperate; cache = owner._memoryCache;
    await initialized;
  } else {
    api = new modules.keys.DesktopWebSecureKeyStore({ ...f.context, createStore: () => f.store }, { agId: 0, enableCache: enabled });
    for (const name of ['error', 'load', 'execute', 'log']) api.on(name, data => f.events.push([name, data])); cookie = api.cookieOperate; cache = api.memoryCache;
  }
  const results = [];
  if (mode === 'preload') {
    const pending = track(api.getItems(['s_sdk_crypt_sdk'])); await flush(); results.push(structuredClone(pending)); f.release({ s_sdk_crypt_sdk: 'synthetic-keys', s_sdk_cert_key: '', 's_sdk_sign_data_key/web_protect': '' }); await flush(); results.push(pending);
  } else if (mode === 'cookie-duplicates') {
    for (const text of ['x=first; x=last', 'other=1; x=first; x=last', 'x=; x=last', 'x=%zz; x=last']) {
      Object.defineProperty(f.context.document, 'cookie', { configurable: true, get: () => text }); results.push(cookie.getCookie('x'));
    }
  } else if (mode === 'cookie') {
    cookie.setCookieWithDomain('name', 'hello world'); results.push(cookie.getCookie('name'), cookie.hasCookie('name'), cookie.getCookieKeys()); cookie.deleteAllCookie('name');
    results.push(cookie.setCookie('expires', 'bad'), cookie.setCookie('', 'bad')); cookie.setCookieNoTimeout('x', 'y'); cookie.setCookieWithMaxAge('z', 'w');
  } else if (mode === 'failure') {
    results.push(await api.get('a'), await api.set('a', 'private-value'), await api.delete('a'), await api.getItems(['a']), await api.setItems(['a'], ['private-value']), await api.getItemsWithOrigin(['a']), await api.getLocalItem('a'), await api.setLocalItem('a', 'private-value'), await api.getLocalItems(['a']));
  } else {
    results.push(await api.get('a', 'discarded'), await api.getItems(['a', 'b']), await api.getItemsWithOrigin(['a', 'empty']));
    await api.setLocalItem('a', 'local-new'); results.push(await api.get('a'), await api.getLocalItem('a'));
    await api.set('a', 'set-new', true); results.push(await api.get('a'));
    await api.setItems(['b'], ['batch'], false); results.push(await api.getItems(['b'])); await api.delete('a'); results.push(await api.get('a'));
    cache.clear(); results.push(await api.getItemsWithOrigin(['b']), api.getIframeStatus(), api.getStorageStatus(), api.startStorageChecker());
  }
  await flush();
  return JSON.parse(JSON.stringify({ calls: f.calls, writes: f.writes, results, events: f.events }, (_key, value) => Object.prototype.toString.call(value) === '[object Error]' || value && value.message === 'synthetic' ? { name: value.name, message: value.message } : value));
}
async function main() {
  const keys = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-key-store.js')).href);
  for (const mode of ['enabled', 'disabled', 'preload', 'failure', 'cookie', 'cookie-duplicates']) assert.deepStrictEqual(await run('sdk', { keys }, mode), await run('native', {}, mode), mode);
  console.log('PASS 6 raw initIframeStore/xr/Fe/mr / built SDK binding traces');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
