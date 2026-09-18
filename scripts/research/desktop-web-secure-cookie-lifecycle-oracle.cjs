// C860 raw methods vs compiled owner. Synthetic browser/store/crypto only; no account or network.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { source, raw, method, flush } = require('./desktop-web-secure-keys-oracle.cjs');
let factories;
const realm = { window: { atob, btoa }, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Promise, atob, btoa };
vm.runInNewContext(source, { ...realm, global: { webpackChunkawemeim: { push(data) { factories = data[1]; } } } });
const modules = {};
function requireRaw(id) { if (modules[id]) return modules[id].exports; const module = modules[id] = { exports: {} }; factories[id](module, module.exports, requireRaw); return module.exports; }
requireRaw.d = (exports, values) => { for (const [name, get] of Object.entries(values)) Object.defineProperty(exports, name, { get }); };
const encoding = requireRaw(76868);
const body = raw + ';var ' + source.slice(64598, 65952) + ';var ' + source.slice(66431, 68095) + ';var ' + source.slice(69629, 69872) + ';var Er=Object.assign;' +
  'r._initCookie=' + method('_initCookie', '_checkCryptKeys') + ';' +
  'r._processCookie=' + method('_processCookie', 'checkCookieMd5') + ';' +
  'r.checkCookieMd5=' + method('checkCookieMd5', '_processCryptData') + ';' +
  'r._processCryptData=' + method('_processCryptData', '_compareCookieWithCache') + ';' +
  'r._processServerCookie=' + method('_processServerCookie', '_initCert') + ';' +
  'r.getKeysInfoWithOrigin=' + method('getKeysInfoWithOrigin', 'signWithKeysInfo') + ';' +
  'r.signWithKeysInfo=' + method('signWithKeysInfo', 'setKeysAndValues') + ';';
const KEY = 's_sdk_crypt_sdk', CERT = 's_sdk_cert_key', SIGN = 's_sdk_sign_data_key/web_protect';
const SERVER = 'bd_ticket_guard_server_data', HASH = '_bd_ticket_crypt_cookie', DOMAIN = 'bd_ticket_guard_web_domain';
const keyText = (pub = 'public', csr = 'CSR') => JSON.stringify({ ec_privateKey: 'private', ec_publicKey: pub, ec_csr: csr });
function fixture(sdk, mode) {
  let release;
  const data = { [KEY]: keyText(mode === 'server-hex' ? '0102' : 'public'), [CERT]: 'pub.BAECAw==', [SIGN]: JSON.stringify({ ticket: 'old', client_cert: 'pub.BAECAw==' }) };
  const local = { ...data }, cookies = new Map(), calls = [], events = [];
  const document = { location: { hostname: 'synthetic.invalid' },
    get cookie() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(value) { calls.push(['cookie-write', value]); const item = value.split(';')[0], at = item.indexOf('='), key = item.slice(0, at); if (value.includes('expires=Thu, 01 Jan 1970')) cookies.delete(key); else cookies.set(key, item.slice(at + 1)); },
  };
  const cookieOperate = new sdk.DesktopWebSecureCookieOperator(document);
  if (mode === 'fallback') { const read = cookieOperate.getCookie; cookieOperate.getCookie = name => name === SERVER ? null : read(name); }
  if (mode === 'status-fail') { const set = cookieOperate.setCookieWithDomain; cookieOperate.setCookieWithDomain = (key, value) => { if (key === '__security_server_data_status') throw Error('status'); return set(key, value); }; }
  if (mode === 'delete-fail') { const remove = cookieOperate.deleteAllCookie; cookieOperate.deleteAllCookie = key => { if (key === SERVER) throw Error('delete'); return remove(key); }; }
  const store = { on() {}, cookieOperate, memoryCache: { isEnabled: () => false }, loadIframePromise: new Promise(resolve => { release = resolve; }),
    getItems(keys) { calls.push(['read', keys]); return Promise.resolve(Object.fromEntries(keys.map(key => [key, data[key]]))); },
    getLocalItem(key) { calls.push(['local-read', key]); return Promise.resolve(local[key]); },
    getLocalItems(keys) { calls.push(['locals-read', keys]); return Promise.resolve(Object.fromEntries(keys.map(key => [key, local[key]]))); },
    getItemsWithOrigin(keys) { calls.push(['origins', keys]); return Promise.resolve({ data: Object.fromEntries(keys.map(key => [key, { key, value: data[key] }])), from: '2' }); },
    setItems(keys, values, sync) {
      calls.push(['write', keys, values, sync]);
      if (mode === 'write-reject' || mode === 'md5-reject') return Promise.reject(Error('write'));
      keys.forEach((key, index) => { data[key] = values[index]; }); return Promise.resolve({ cross: mode === 'md5-null-cross' ? null : '0' });
    }, startStorageChecker() { calls.push(['checker']); },
  };
  if (mode === 'md5-no-iframe') store.loadIframePromise = undefined;
  const crypto = {
    generateNewKeyPairPEM() { calls.push(['generate']); return Promise.resolve({ privatePem: 'private-generated', publicPem: 'public-generated' }); },
    extractPublicKeyFromX509Cert(cert) { calls.push(['x509', cert]); return cert === 'X509' ? Promise.resolve(new Uint8Array([1, 2])) : Promise.reject(Error('not-x509')); },
    extractPublicKeyHexFromPem(pub) { calls.push(['public', pub]); return Promise.resolve({ rawHex: pub === 'local-public' ? '04040506' : '04010203' }); },
    extractPublicKeyFromPrivateKey(key) { calls.push(['private', key]); return Promise.resolve({ rawHex: '04010203' }); },
    signWithECDSA(key, text) { calls.push(['sign', key, text]); return Promise.resolve({ hex: 'abcd', buffer: new Uint8Array([171, 205]).buffer }); },
  };
  const Clock = class { getTime() { return 1000; } static now() { return 1000; } };
  return { store, local, data, cookies, calls, events, document, crypto, Clock, release: () => release(),
    put(value) { cookies.set(SERVER, encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64'))); } };
}
async function scenario(kind, sdk, mode) {
  const f = fixture(sdk, mode); let owner;
  const initType = mode === 'client-cert' || mode === 'cert-skips-md5' ? 'cert' : 'pubKey';
  if (kind === 'raw') {
    owner = { _storeSDK: f.store, cookieOperate: f.store.cookieOperate, loadIframePromise: f.store.loadIframePromise, _memoryCache: f.store.memoryCache,
      _initData: {}, _hasProcessServerData: false, initMatch: false, initType, emit: (name, event) => f.events.push([name, event]), _getInitKeys: () => [KEY, CERT, SIGN] };
    vm.runInNewContext(body, { ...realm, owner, document: f.document, Date: f.Clock, window: { atob, btoa, performance: { now: () => 1 } }, v: encoding,
      Q: f.crypto.generateNewKeyPairPEM, Y: f.crypto.signWithECDSA, rt: f.crypto.extractPublicKeyFromX509Cert, et: f.crypto.extractPublicKeyHexFromPem, tt: f.crypto.extractPublicKeyFromPrivateKey });
    await owner._checkCryptKeys();
  } else {
    owner = new sdk.DesktopWebSecureKeys({ crypto: f.crypto, certificates: { get: async () => ({}) }, document: f.document, Date: f.Clock, performance: { now: () => 1 }, createKeyStore: () => f.store }, { initType });
    for (const name of ['load', 'ready', 'execute', 'log', 'error']) owner.on(name, event => f.events.push([name, event]));
    await owner.initIframeStore(); await owner.checkCryptKeys();
  }
  const init = scene => kind === 'raw' ? owner._initCookie(scene) : owner.initCookie(scene);
  const processServer = scene => kind === 'raw' ? owner._processServerCookie(scene) : owner.processServerCookie(scene);
  const processClient = () => kind === 'raw' ? owner._processCookie() : owner.processCookie();
  const results = [];
  if (mode.startsWith('md5-')) {
    let value = f.data[KEY], cert = f.data[CERT], sign = f.data[SIGN];
    if (mode === 'md5-2' || mode === 'md5-3') value = f.local[KEY] = keyText('local-public');
    if (mode === 'md5-3') { cert = f.local[CERT] = 'local-cert'; sign = f.local[SIGN] = 'local-sign'; }
    if (mode !== 'md5-absent') f.cookies.set(HASH, mode === 'md5-bad' ? 'bad' : sdk.createDesktopWebSecureCookieDigest(value, cert, sign));
    results.push(await owner.checkCookieMd5()); results.push({ before: f.calls.filter(row => row[0] === 'write').length });
    if (mode !== 'md5-pending') { if (mode === 'md5-changed') f.cookies.set(HASH, 'changed'); f.release(); for (let i = 0; i < 6; i++) await flush(); }
  } else if (mode === 'client' || mode === 'client-cert') results.push(await processClient());
  else {
    let ticket = { ticket: 'new', ts_sign: 'synthetic-ts', client_cert: 'pub.BAECAw==' };
    if (mode === 'server-local') { f.local[KEY] = keyText('local-public'); ticket.client_cert = 'pub.BAQFBg=='; }
    if (mode === 'server-hex' || mode === 'server-pem-x509') ticket.client_cert = 'X509';
    if (mode === 'server-mismatch') ticket.client_cert = 'pub.mismatch';
    if (mode === 'no-cert') delete ticket.client_cert;
    if (mode !== 'empty' && mode !== 'domain-only') f.put(ticket);
    if (mode === 'domain' || mode === 'domain-only') f.cookies.set(DOMAIN, '2');
    if (mode === 'bad-json') f.cookies.set(SERVER, Buffer.from('{').toString('base64'));
    if (mode === 'init-bad') f.cookies.set(SERVER, '%%%');
    if (mode === 'double-decode') f.cookies.set(SERVER, encodeURIComponent(f.cookies.get(SERVER).replace(/./g, char => `%${char.charCodeAt(0).toString(16)}`)));
    if (mode === 'getter-first') {
      results.push(await owner.getKeysInfoWithOrigin({ certType: 'cookie', scene: 'web_protect' }));
      f.put({ ...ticket, ticket: 'later' }); results.push(await owner.getKeysInfoWithOrigin({ certType: 'cookie', scene: 'web_protect' }));
    } else if (mode === 'signer-first') {
      results.push(await owner.signWithKeysInfo({ certType: 'cookie', scene: 'web_protect', keysInfo: { crypt: JSON.parse(f.data[KEY]), sign: { ticket: 'input' } }, isNewCert: false }));
    } else if (mode === 'init-bad' || mode === 'init-once') {
      const first = init('first'); results.push({ sameFlight: first === init('second') }); results.push(await first); f.put(ticket); results.push(await init('third'));
    } else {
      results.push(await processServer('web_protect')); if (mode === 'cert-skips-md5') results.push(await processClient());
    }
  }
  await flush();
  for (const [name, event] of f.events) if (name === 'log' && event.extra) for (const key of ['ts_sign', 'cookie', 'pub', 'csr', 'cert', 'md5', 'md5Cookie']) if (event.extra[key]) event.extra[key] = '[redacted]';
  return JSON.parse(JSON.stringify({ results, calls: f.calls, events: f.events, data: f.data, cookies: [...f.cookies],
    state: { initial: owner._initData, text: owner._cryptData, object: owner._cryptObject, processed: owner._hasProcessServerData, match: owner.initMatch } },
  (_key, value) => value && Object.prototype.toString.call(value) === '[object Error]' ? { name: value.name } : value));
}
async function main() {
  const sdk = { ...await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-keys.js')).href), ...await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-cookie.js')).href) };
  const modes = ['client', 'client-cert', 'empty', 'domain', 'domain-only', 'server-local', 'server-hex', 'server-pem-x509', 'server-mismatch', 'no-cert', 'bad-json', 'double-decode', 'fallback',
    'status-fail', 'delete-fail', 'write-reject', 'getter-first', 'signer-first', 'init-bad', 'init-once', 'cert-skips-md5',
    'md5-1', 'md5-2', 'md5-3', 'md5-absent', 'md5-bad', 'md5-changed', 'md5-pending', 'md5-no-iframe', 'md5-reject', 'md5-null-cross'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', sdk, mode), mode);
  console.log(`PASS ${modes.length} raw C860 Cookie/key-switch/storage/getter/signer traces (synthetic I/O and crypto, logs intentionally redacted)`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
