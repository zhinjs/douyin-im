const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Provide the audited C860 path');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const method = (name, next) => source.slice(source.indexOf(`r.${name}=`) + `r.${name}=`.length, source.indexOf(`,r.${next}=`));
const raw = 'var ' + source.slice(65953, source.indexOf(',Le=function', 65953)) + ';var ' + source.slice(68445, 68981) +
  ';var ' + source.slice(97896, source.indexOf(',Rr=function', 97896)) + ';var ' + source.slice(84082, source.indexOf(';const nr=rr', 84082)) +
  ';var nr=rr;var r=owner;' +
  'r._checkCryptKeys=' + method('_checkCryptKeys', 'getPerfomanceTimes') + ';' +
  'r.initPubKey=' + method('initPubKey', '_initCookie') + ';' +
  'r.initECDHKey=' + method('initECDHKey', 'initPubKey') + ';' +
  'r._initCert=' + method('_initCert', 'getCertificate') + ';' +
  'r._getCertificatePem=' + method('_getCertificatePem', '_checkCert') + ';' +
  'r.getPerfomanceTimes=' + method('getPerfomanceTimes', '_getInitKeys') + ';' +
  'r.reportError=' + method('reportError', 'getKeysInfo') + ';';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const KEY = 's_sdk_crypt_sdk';
const fakePair = index => ({ privatePem: `private-${index}`, publicPem: `public-${index}` });
function fixture(mode) {
  let generation = 0, data = {}, local, resolveSecond;
  const calls = [], events = [];
  const record = JSON.stringify({ ec_privateKey: 'private-stored', ec_publicKey: 'public-stored', ec_csr: mode === 'restore-cert' ? 'csr' : '' });
  if (['restore', 'restore-cert', 'missing-csr'].includes(mode)) data = { [KEY]: record };
  if (mode === 'bad-cross') data = { [KEY]: '{' };
  if (mode === 'missing-cross') data = { [KEY]: '{}' };
  if (mode === 'local-winner') local = record;
  if (mode === 'local-empty' || mode === 'local-pending') local = '{}';
  if (mode === 'local-bad') local = '{';
  const crypto = {
    generateNewKeyPairPEM() { generation++; calls.push(['generate', generation]); return mode === 'generate-error' ? Promise.reject(Error('generate')) : mode === 'local-pending' && generation === 2 ? new Promise(resolve => { resolveSecond = resolve; }) : Promise.resolve(fakePair(generation)); },
    signWithECDSA(key, text) { calls.push(['sign', key, text]); return Promise.resolve({ hex: 'abcd', buffer: new Uint8Array([171, 205]).buffer }); },
    extractPublicKeyHexFromPem(key) { calls.push(['public', key]); return Promise.resolve({ rawHex: '040102' }); },
    deriveEcdhKey(key, cert) { calls.push(['derive', key, cert]); return Promise.resolve({ bytes: new Uint8Array([7, 8]), hex: '0708' }); },
  };
  const store = { on() {},
    getItems(keys) { calls.push(['read', keys]); return mode === 'read-error' || mode === 'empty-ecdh' ? Promise.reject(Error('read')) : Promise.resolve(data); },
    getLocalItem(key) { calls.push(['local-read', key]); return Promise.resolve(local); },
    setLocalItem(key, value) { calls.push(['local-write', key, value]); local = value; return Promise.resolve(); },
    set(key, value) { calls.push(['write', key, value]); data[key] = value; return mode === 'write-error' ? Promise.reject(Error('write')) : Promise.resolve({ cross: '0' }); },
  };
  const certificates = { get(aid, cache) { calls.push(['certificate', aid, cache]); return Promise.resolve({ cert: 'CERT', sn: 'SN' }); } };
  const Clock = class { getTime() { return 100; } static now() { return 100; } };
  return { calls, events, crypto, store: mode === 'no-store' ? undefined : store, certificates, Clock,
    done() { resolveSecond?.(fakePair(2)); }, emit(name, event) { events.push([name, event]); if (mode === 'observer-error' && name === 'load') throw Error('observer'); } };
}
function track(promise) { const result = { status: 'pending' }; void promise.then(value => Object.assign(result, { status: 'fulfilled', value }), error => Object.assign(result, { status: 'rejected', name: error.name })); return result; }
async function scenario(kind, sdk, mode) {
  const f = fixture(mode), initType = mode.includes('csr') || mode === 'restore-cert' ? 'cert' : 'pubKey';
  let owner, check;
  if (kind === 'raw') {
    owner = { _storeSDK: f.store, _initData: {}, initType, aid: 1128, emit: f.emit, _getInitKeys: () => [KEY, 's_sdk_cert_key', 's_sdk_sign_data_key/web_protect'] };
    const context = vm.createContext({ owner, Promise, Date: f.Clock, Uint8Array, window: { performance: { now: () => 5 } },
      Q: f.crypto.generateNewKeyPairPEM, Y: f.crypto.signWithECDSA, _r: f.certificates.get, $: f.crypto.deriveEcdhKey,
      Ue: async (_private, publicKey) => { const value = await f.crypto.extractPublicKeyHexFromPem(publicKey); return Buffer.from(value.rawHex, 'hex').toString('base64'); } });
    vm.runInContext(raw, context); check = owner._checkCryptKeys;
  } else {
    owner = new sdk.DesktopWebSecureKeys({ crypto: f.crypto, certificates: f.certificates, createKeyStore: () => f.store, Date: f.Clock, performance: { now: () => 5 } }, { initType, aid: 1128 });
    for (const event of ['load', 'ready', 'error']) owner.on(event, value => f.emit(event, value));
    await owner.initIframeStore(); check = owner.checkCryptKeys;
  }
  const a = check(), sameFlight = check() === a, outcome = track(a); await flush();
  const result = { sameFlight, outcome, state: { text: owner._cryptData, object: owner._cryptObject, initial: owner._initData } };
  if (mode === 'local-pending') {
    const keys = track(owner.cryptoSDK.getKeys()); await flush(); result.pendingKeys = structuredClone(keys); f.done(); await flush(); result.resolvedKeys = keys;
  } else if (mode === 'public') {
    result.public = await owner.initPubKey(); result.again = await owner.initPubKey();
  } else if (mode === 'ecdh' || mode === 'empty-ecdh') {
    const bytes = await owner.initECDHKey(); result.derived = Array.from(bytes); result.sameDerived = bytes === await owner.initECDHKey();
  } else if (outcome.status === 'fulfilled' && outcome.value && owner.cryptoSDK) {
    result.keys = await owner.cryptoSDK.getKeys(); await owner.cryptoSDK.sign('message');
  }
  await flush();
  return JSON.parse(JSON.stringify({ ...result, calls: f.calls, events: f.events }, (_key, value) => value && Object.prototype.toString.call(value) === '[object Error]' ? { name: value.name } : value));
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-keys.js')).href);
  const modes = ['generate', 'restore', 'restore-cert', 'missing-csr', 'bad-cross', 'missing-cross', 'local-winner', 'local-empty', 'local-pending', 'local-bad', 'no-store', 'read-error', 'write-error', 'generate-error', 'observer-error', 'public', 'ecdh', 'empty-ecdh'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', {}, mode), mode);
  console.log(`PASS ${modes.length} raw Rr/nr/We / SDK key initialization traces (synthetic keys/store/crypto for control flow)`);
}
module.exports = { source, raw, method, flush };
if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
