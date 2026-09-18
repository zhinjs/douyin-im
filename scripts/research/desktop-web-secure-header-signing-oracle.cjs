// Exact source control flow; synthetic store/keys/ECDSA, real original and WebCrypto HMAC.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { webcrypto } = require('node:crypto');
const { source, raw, method, flush } = require('./desktop-web-secure-keys-oracle.cjs');
let factories;
const browser = { window: { atob, btoa }, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Promise, atob, btoa };
vm.runInNewContext(source, { ...browser, global: { webpackChunkawemeim: { push(data) { factories = data[1]; } } } });
const cache = {};
function requireRaw(id) { if (cache[id]) return cache[id].exports; const module = { exports: {} }; cache[id] = module; factories[id](module, module.exports, requireRaw); return module.exports; }
requireRaw.d = (exports, values) => { for (const [name, get] of Object.entries(values)) Object.defineProperty(exports, name, { get }); };
const encoding = requireRaw(76868), sha = requireRaw(71312);
const body = raw + ';var ' + source.slice(82697, source.indexOf(';const nr=rr', 82697)).replace('Ye=r(71312)', 'Ye=shaModule') + ';nr=rr;' +
  source.slice(68981, source.indexOf(',He=function', 68981)) + ';var ' + source.slice(source.indexOf('Ve=function'), source.indexOf(',Fe=function')) + ';' +
  'r.getKeysInfoWithOrigin=' + method('getKeysInfoWithOrigin', 'signWithKeysInfo') + ';' +
  'r.signWithKeysInfo=' + method('signWithKeysInfo', 'setKeysAndValues') + ';' +
  'r._signValueWithIframe=' + method('_signValueWithIframe', 'setSignValue') + ';' +
  'r.setSignValue=' + method('setSignValue', 'setSignValueAsync') + ';' +
  'r.setSignValueAsync=' + method('setSignValueAsync', 'clearSignData') + ';' +
  'r.clearSignData=' + method('clearSignData', 'sign') + ';r.setSignValueScheduler=new qe;er=recordHmac;';
const KEY = 's_sdk_crypt_sdk', CERT = 's_sdk_cert_key', SIGN = 's_sdk_sign_data_key/web_protect';
function fixture(mode, system) {
  const data = { [KEY]: JSON.stringify({ ec_privateKey: 'private', ec_publicKey: 'public', ec_csr: 'CSR' }), [CERT]: 'pub.CERT', [SIGN]: JSON.stringify({ ticket: 'ticket', ts_sign: 'ts.2.synthetic', client_cert: 'pub.CERT', log_id: 'id' }) };
  const calls = [], events = []; let release;
  const store = { on() {}, memoryCache: { isEnabled: () => false }, cookieOperate: { setCookieWithDomain(...args) { calls.push(['cookie', ...args]); } },
    getItems(keys) { calls.push(['init-read', keys]); return Promise.resolve(Object.fromEntries(keys.map(key => [key, data[key]]))); },
    getLocalItem(key) { calls.push(['local-read', key]); return Promise.resolve(data[key]); },
    setLocalItem(key, value) { calls.push(['local-write', key, value]); data[key] = value; return Promise.resolve(); },
    getItemsWithOrigin(keys) { calls.push(['origins', keys]); return Promise.resolve({ data: Object.fromEntries(keys.map(key => [key, { key, value: data[key], from: '2', origin: 'synthetic' }])), from: '2' }); },
    set(key, value, sync) { calls.push(['set', key, value, sync]); if (mode === 'queue-pending' && key === SIGN) return new Promise(resolve => { release = () => { data[key] = value; resolve(); }; }); data[key] = value; return Promise.resolve({ cross: '0' }); },
    delete(key) { calls.push(['delete', key]); delete data[key]; return Promise.resolve(); },
  };
  const crypto = {
    generateNewKeyPairPEM: () => Promise.resolve({ privatePem: 'private', publicPem: 'public' }),
    signWithECDSA(key, text) { calls.push(['ecdsa', key, text]); return Promise.resolve({ hex: 'abcd', buffer: new Uint8Array([171, 205]).buffer }); },
    extractPublicKeyHexFromPem(key) { calls.push(['public', key]); return Promise.resolve({ rawHex: '040102' }); },
    extractPublicKeyFromPrivateKey(key) { calls.push(['public-private', key]); return Promise.resolve({ rawHex: '040102' }); },
    deriveEcdhKey(key, cert) { calls.push(['derive', key, cert]); return mode === 'hmac-error' ? Promise.reject(Error('derive')) : Promise.resolve({ bytes: new Uint8Array(mode === 'hmac-empty' ? [] : [1, 2, 3]), hex: '' }); },
    hmacSha256(key, text) { calls.push(['hmac', Array.from(key), text]); return system.hmacSha256(key, text); },
  };
  const certificate = (aid, useCache) => { calls.push(['certificate', aid, useCache]); return Promise.resolve({ cert: 'SERVER', sn: 'SN' }); };
  const Clock = class { getTime() { return 100_000; } static now() { return 100_000; } };
  return { data, store, calls, events, crypto, certificate, Clock, release: () => release?.() };
}
async function scenario(kind, sdk, mode, system) {
  const f = fixture(mode, system); let owner;
  if (kind === 'raw') {
    owner = { _storeSDK: f.store, _memoryCache: f.store.memoryCache, cookieOperate: f.store.cookieOperate, _storageNamespace: mode === 'clear-with-namespace' ? 'ns' : undefined,
      _disableStorageSignData: mode === 'disabled-storage', initType: 'pubKey', aid: 1128, enableEcdh: mode !== 'disabled-ecdh', emit: (name, data) => f.events.push([name, data]), _getInitKeys: () => [KEY, CERT, SIGN] };
    const context = vm.createContext({ ...browser, owner, Date: f.Clock, window: { performance: { now: () => 1 }, atob, btoa }, shaModule: sha, v: encoding,
      Q: f.crypto.generateNewKeyPairPEM, Y: f.crypto.signWithECDSA, _r: f.certificate, $: f.crypto.deriveEcdhKey,
      Ue: async (privateKey, publicKey) => publicKey ? encoding.LE((await f.crypto.extractPublicKeyHexFromPem(publicKey)).rawHex) : privateKey ? encoding.LE((await f.crypto.extractPublicKeyFromPrivateKey(privateKey)).rawHex) : '',
      recordHmac(key, text) { f.calls.push(['hmac', Array.from(key), text]); return sha.sha256.hmac(key, text); } });
    vm.runInContext(body, context); await owner._checkCryptKeys();
  } else {
    owner = new sdk.DesktopWebSecureKeys({ crypto: f.crypto, certificates: { get: f.certificate }, Date: f.Clock, performance: { now: () => 1 }, createKeyStore: () => f.store },
      { aid: 1128, storageNamespace: mode === 'clear-with-namespace' ? 'ns' : undefined, disableStorageSignData: mode === 'disabled-storage' });
    owner.enableEcdh = mode !== 'disabled-ecdh';
    for (const name of ['load', 'ready', 'log', 'error']) owner.on(name, data => f.events.push([name, data]));
    await owner.initIframeStore(); await owner.checkCryptKeys();
  }
  const results = [];
  if (['base64-write', 'inner-fail', 'undefined-json', 'clear-with-namespace', 'clear-no-namespace', 'disabled-storage', 'queue-pending'].includes(mode)) {
    const text = JSON.stringify({ ticket: 'new-ticket', ts_sign: 'new-ts', client_cert: 'pub.NEW' });
    const input = { sign: mode === 'inner-fail' ? Buffer.from('{').toString('base64') : mode === 'undefined-json' ? { toJSON: () => undefined } : mode === 'base64-write' ? Buffer.from('\ufeff' + text).toString('base64') : JSON.parse(text), scene: 'web_protect', namespace: 'ns' };
    if (mode === 'queue-pending') results.push(owner.setSignValue(input)); else results.push(await owner.setSignValueAsync(input));
    if (mode.startsWith('clear-')) results.push(await owner.clearSignData('web_protect'));
  }
  if (mode === 'invalid-read') f.data[KEY] = '{';
  const keysInfo = await owner.getKeysInfoWithOrigin({ certType: 'header', scene: 'web_protect' }); results.push(keysInfo);
  if (mode === 'queue-pending') { f.release(); await flush(); results.push(await owner.getKeysInfoWithOrigin({ certType: 'header', scene: 'web_protect' })); }
  else if (mode !== 'invalid-read') {
    if (mode === 'no-sign') delete keysInfo.sign;
    if (mode === 'no-ticket') keysInfo.sign = {};
    const input = { keysInfo, certType: 'header', scene: 'web_protect', isNewCert: mode !== 'not-new' && mode !== 'header-ecdsa',
      sign_data: mode === 'req-content' ? 'signed-text' : mode === 'malformed-text' ? '\ud800A' : undefined, req_content: mode === 'req-content' ? 'not-signed' : undefined, timestamp: mode === 'timestamp-zero' ? 0 : 123 };
    results.push(await owner.signWithKeysInfo(input));
  }
  await flush();
  // Credential log redaction is intentional. Normalize only raw log fields, not results or storage.
  for (const [name, data] of f.events) if (name === 'log' && data.extra) for (const key of ['ts_sign', 'sign_data', 'req_content', 'csr', 'cert', 'sign']) if (data.extra[key]) data.extra[key] = '[redacted]';
  return JSON.parse(JSON.stringify({ results, data: f.data, signData: owner._signData, calls: f.calls, events: f.events }, (_key, value) => value && Object.prototype.toString.call(value) === '[object Error]' ? { name: value.name } : value));
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-keys.js')).href);
  const { DesktopWebSecureSystemCrypto } = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-crypto.js')).href);
  const system = new DesktopWebSecureSystemCrypto(webcrypto.subtle);
  const modes = ['header-ecdsa', 'header-hmac', 'hmac-empty', 'hmac-error', 'no-sign', 'no-ticket', 'timestamp-zero', 'req-content', 'not-new', 'disabled-ecdh', 'malformed-text', 'base64-write', 'inner-fail', 'undefined-json', 'clear-with-namespace', 'clear-no-namespace', 'disabled-storage', 'invalid-read', 'queue-pending'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode, system), await scenario('raw', {}, mode, system), mode);
  console.log(`PASS ${modes.length} raw Rr header-ticket/getKeysInfoWithOrigin/signWithKeysInfo / SDK traces (credential logs intentionally redacted)`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
