// Full raw Xe/Ie/Se/De source, real bundled MD5. All browser/storage/network I/O remains synthetic.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { raw, environment, track, flush, source } = require('./desktop-web-secure-cross-storage-oracle.cjs');
let factories;
const capture = { webpackChunkawemeim: { push(data) { factories = data[1]; } } };
vm.runInNewContext(source, { global: capture });
const moduleCache = {};
function requireRaw(id) {
  if (moduleCache[id]) return moduleCache[id].exports;
  const module = { exports: {} }; moduleCache[id] = module; factories[id](module, module.exports, requireRaw); return module.exports;
}
requireRaw.d = (exports, values) => { for (const [name, getter] of Object.entries(values)) Object.defineProperty(exports, name, { get: getter }); };
const hash = requireRaw(76868).kd;
const facade = raw + 'var v={kd:hash};var ' + source.slice(source.indexOf('Me=function'), source.indexOf(',Fe=function')) + ';var ' + source.slice(69629, source.indexOf(';const Qe=')) + ';globalThis.Store=Xe;globalThis.digest=Ve;globalThis.verify=Me;globalThis.cookie=He;';
function configFor(mode) {
  if (mode.startsWith('local')) return { disableCrossStorage: true, namespace: mode === 'local-namespace' ? 'tenant' : undefined };
  return { namespace: mode === 'namespace' ? 'tenant' : undefined, ztIframe: mode === 'url-zt', agid: mode === 'url-agid' ? 1 : undefined,
    url: mode === 'url-override' ? 'https://override.example/frame' : undefined };
}
async function scenario(kind, modules, mode) {
  const f = environment(), io = f.io, config = configFor(mode);
  f.window.location.hostname = mode === 'url-host' || mode === 'url-agid' ? 'www.douyin.com' : '';
  let clock = 100, localIndex = 0;
  const Time = function() { this.getTime = () => clock++; }; Time.now = () => clock++;
  f.context.Date = Time;
  const cookie = modules.cookie.createDesktopWebSecureCookieDigest('{"ec_publicKey":"synthetic"}', 'cert', 'server');
  f.context.document.cookie = `_bd_ticket_crypt_cookie=${cookie}`;
  f.context.document.querySelectorAll = () => mode === 'iframe-none' ? [] : [{ src: 'https://lf-zt.douyin.com/frame' }, { src: 'https://lf-zt.douyin.com/second' }];
  f.local.localDB.getItemByKeys = list => { io.push(['raw.get', list]); return Promise.resolve(['{"ec_publicKey":"synthetic"}', 'cert', 'server']); };
  if (mode.includes('falsy')) f.local.getItem = key => { io.push(['local.item', key]); return Promise.resolve(f.value(false)); };
  if (mode.includes('mismatch')) f.local.getItemByKeys = list => { io.push(['local.get', list]); return Promise.resolve([]); };
  if (mode.includes('values')) f.local.getItemByKeys = list => { io.push(['local.get', list]); return Promise.resolve([f.value(false), f.value(0), f.value(undefined)]); };
  const makeLocal = () => { const index = localIndex++; io.push(['make.local', index]); return { ...f.local,
    getItem(key) { io.push(['local.owner', index, 'get']); return f.local.getItem(key); }, setItem(key, value) { io.push(['local.owner', index, 'set']); return f.local.setItemByKeys([[key, value]]).then(values => values[0]); },
    getItemByKeys(list) { io.push(['local.owner', index, 'getMany']); return f.local.getItemByKeys(list); },
  }; };
  let store;
  if (kind === 'native') {
    const sandbox = vm.createContext({ Promise, window: f.window, document: f.context.document, navigator: f.context.navigator, performance: f.context.performance,
      Date: Time, Math: f.context.Math, location: f.window.location, localStorage: { getItem: f.context.readLocalStorage, setItem() {} },
      setTimeout: f.context.setTimeout, clearTimeout: f.context.clearTimeout, Local: function() { return makeLocal(); }, hash });
    vm.runInContext(facade, sandbox); store = new sandbox.Store(config);
  } else {
    const host = new modules.iframe.DesktopWebSecureIframeHost(f.context), bridges = new modules.bridge.DesktopWebSecureBridgeHost(f.context);
    store = new modules.store.DesktopWebSecureStore(host, bridges, { window: f.window, hostname: f.window.location.hostname,
      createLocalStorage: makeLocal, writeLocalStorage() {}, readCookie: () => f.context.document.cookie, queryIframes: () => f.context.document.querySelectorAll(),
    }, config);
  }
  for (const event of ['execute', 'log', 'error']) store.on(event, data => io.push([event, data instanceof Error ? data.message : data]));
  if (store.storage) {
    const client = store.storage.client;
    // A synthetic completed connection lets us observe Xe/Ie calls without a real remote iframe.
    client.window = Promise.resolve({ target: f.frame, startTime: 0, endTime: 0 }); client.isConnection = true;
    f.frame.postMessage = (packet, origin) => {
      io.push(['remote', packet, origin]);
      const { id, message } = packet.data, name = message.callName, args = message.callArgs;
      let result;
      if (name === 'getItemByKeys') result = mode === 'mismatch' ? [] : args[0].map(() => ({ value: mode === 'falsy' ? false : 'remote', from: 1, origin: 'https://lf-zt.douyin.com' }));
      if (name === 'setItemByKeys') result = args[0].map(([, value]) => ({ value, from: 1, origin: 'https://lf-zt.douyin.com' }));
      queueMicrotask(() => client.emit('message', { data: { id, promiseStatus: 'resolve', message: result } }));
    };
    store.storage.config.disableReportLogger = true;
  }
  let value;
  if (mode.startsWith('url')) { value = { url: store.storage.client.config.url, localCount: localIndex, iframe: store.getIframeStatus() }; }
  else if (mode === 'connection') {
    const pending = track(store.loadIframePromise); await flush(); io.push(['before', { ...pending }]); store.storage.client.emit('connectionFail', Error('fail')); await flush();
    io.push(['failed', { ...pending }]); store.storage.client.emit('connection', { target: f.frame, startTime: 1, endTime: 2 }); await flush();
    store.storage.client.emit('connectionFail', Error('late')); await flush(); value = { pending, status: store.getIframeStatus(), state: store.getStorageStatus() };
  } else if (mode.startsWith('iframe')) { store.checkIframeStatus(); store.checkIframeStatus(); store.checkIframeStatus(true); value = store.getIframeStatus(); }
  else if (mode === 'signed') value = await store.getItem('s_sdk_cert_key');
  else if (mode === 'verify') value = [store.verifySignMethod(['{"ec_publicKey":"synthetic"}', 'cert', 'server']), store.verifySignMethod(['{}', 'cert', 'server'])];
  else if (mode.endsWith('origin')) value = await store.getItemsWithOrigin(['a', 'b']);
  else if (mode === 'mismatch' || mode === 'local-mismatch') value = [await store.getItemWithKeys(['a', 'b']), await store.getLocalItemsWithKeys(['a', 'b']), await store.getItemsWithOrigin(['a', 'b'])];
  else if (mode === 'local-values') value = [await store.getLocalItemsWithKeys(['a', 'b', 'c']), await store.getItemWithKeys(['a', 'b', 'c']), await store.getItemsWithOrigin(['a', 'b', 'c'])];
  else if (mode === 'set' || mode === 'local-set') value = [await store.setItem('a', 'x'), await store.setItem('b', 'y', true), await store.setItemWithKeys(['c'], ['z']), await store.setItemWithKeys([], []), await store.setLocalItem('d', 'local')];
  else if (mode === 'delete' || mode === 'local-delete') value = await store.deleteItem('a');
  else value = [await store.getItem('a'), await store.getLocalItem('a'), await store.getLocalItemsWithKeys(['a', 'b']), store._createStorageKey('a')];
  await flush();
  return JSON.parse(JSON.stringify({ value, io, timers: [...f.timers.values()].map(timer => timer.delay) }));
}
async function main() {
  const modules = {};
  for (const name of ['store', 'cookie', 'iframe', 'bridge']) modules[name] = await import(pathToFileURL(resolve(`lib/anti-bot/desktop-web-secure-${name}.js`)).href);
  const modes = ['get', 'local', 'namespace', 'local-namespace', 'falsy', 'local-falsy', 'mismatch', 'local-mismatch', 'local-values', 'origin', 'local-origin', 'set', 'local-set', 'delete', 'local-delete', 'signed', 'verify', 'url-file', 'url-host', 'url-agid', 'url-zt', 'url-override', 'connection', 'iframe', 'iframe-none'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', modules, mode), await scenario('native', modules, mode), mode);
  const sandbox = vm.createContext({ hash, v: { kd: hash }, document: { cookie: '' } });
  vm.runInContext('var ' + source.slice(67607, source.indexOf(',Fe=function')) + ';var ' + source.slice(69629, 69872) + ';globalThis.out={Me,Ve,He};', sandbox);
  let count = 0;
  for (const publicKey of ['a', '', false, null, 23, { a: 'x' }, '中文😀', '\ud800', 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(3000)]) {
    for (const cert of ['cert', '', null, 0, 1, { b: false }]) {
      const key = JSON.stringify({ ec_publicKey: publicKey }), data = 'server\u0000😀';
      const native = sandbox.out.Ve(key, cert, data), actual = modules.cookie.createDesktopWebSecureCookieDigest(key, cert, data);
      assert.equal(actual, native); assert.equal(modules.cookie.verifyDesktopWebSecureCookie(native, key, cert, data), sandbox.out.Me(native, key, cert, data)); count++;
    }
  }
  for (const cookie of ['a=1; _bd_ticket_crypt_cookie=hello%20x', '_bd_ticket_crypt_cookie=; _bd_ticket_crypt_cookie=b', '_bd_ticket_crypt_cookie=%zz; _bd_ticket_crypt_cookie=b', '_bd_ticket_crypt_cookie=a+b', '_bd_ticket_crypt_cookie_extra=a']) {
    sandbox.document.cookie = cookie; assert.equal(modules.cookie.readDesktopWebSecureCookie(() => cookie, '_bd_ticket_crypt_cookie'), sandbox.out.He('_bd_ticket_crypt_cookie')); count++;
  }
  console.log(`PASS ${modes.length} raw Xe/Ie/Se/De store traces and ${count} bundled-MD5/cookie vectors`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
