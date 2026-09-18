// Rr setters/start/refresh against compiled Keys; all async primitives and storage are synthetic.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { source, method, flush } = require('./desktop-web-secure-keys-oracle.cjs');
const start = source.indexOf('Rr=function'), constructor = source.slice(start, source.indexOf(';const Lr=', start));
const raw = 'var ' + source.slice(97896, source.indexOf(',Rr=function', 97896)) + ';var r=owner;' +
  constructor.slice(constructor.indexOf('r.setType='), constructor.indexOf(',r.initIframeStore=')) + ';' +
  'r.refresh=' + method('refresh', 'reportError') + ';' +
  constructor.slice(constructor.indexOf('r.setEnableEcdh='), constructor.indexOf(',r.getUsage=')) + ';';
const compact = value => JSON.parse(JSON.stringify(value));
async function scenario(kind, sdk, mode) {
  const calls = [], release = [];
  const task = name => (...args) => {
    calls.push([name, ...args]);
    if (mode === `${name}-throw`) throw Error('synthetic');
    if (mode === 'pending') return new Promise(resolve => release.push(resolve));
    return Promise.resolve(true);
  };
  const owner = kind === 'raw' ? { enableEcdh: true, enableCache: true } : new sdk.DesktopWebSecureKeys({ Date,
    document: { cookie: '', location: { hostname: 'www.douyin.com' } }, crypto: {}, certificates: {} });
  if (kind === 'raw') vm.runInNewContext(raw, { owner, Promise, Array, Object, Ir: 's_sdk_crypt_sdk', Or: 's_sdk_cert_key', lr: () => 'douyin.com' });
  const pending = [], observeTask = name => {
    const fn = task(name);
    return (...args) => { const result = fn(...args); pending.push(result); return result; };
  };
  owner.initIframeKeys = observeTask('store'); owner.initECDHKey = observeTask('ecdh'); owner.initPubKey = observeTask('public');
  owner[kind === 'raw' ? '_initCookie' : 'initCookie'] = observeTask('cookie');
  owner.reportError = (error, name) => calls.push(['error', error.message, name]);
  const settings = { storageNamespace: 'initial', initType: 'cert', signType: 'cert', disableCrossStorage: true, updateKeys: true, iframeURL: 'frame', iframeBackURL: 'fallback', disableStorageSignData: true };
  owner.setContext(settings); owner.setAid(1128); owner.setConfig({ first: [{ scene: 'one', certType: 'cookie' }, { scene: 'ignored', certType: 'cookie' }], second: [{ certType: 'header' }, { certType: 'cookie' }], third: [{ certType: 'cookie' }], invalid: { certType: 'cookie' } });
  if (mode === 'context-reset') owner.setContext({});
  if (mode === 'type-reset') owner.setType({});
  if (mode === 'ecdh-off') owner.setEnableEcdh(false);
  if (mode === 'cache-off') owner.setEnableCache(false);
  if (mode === 'agid-number') owner.setAgidAndHost(1);
  if (mode === 'agid-string') owner.setAgidAndHost('1');
  if (mode === 'agid-explicit') { owner.setAgidAndHost(1); owner.setAgidAndHost(3, 'explicit'); }
  if (mode === 'setters') { owner.setStorageNamespace('next'); owner.setCrossStorageURL('newframe'); owner.setCrossStorageBackURL('newback'); owner.setDisableCrossStorage(false); owner.setDisableStorageSignData(false); owner.setUpdateKeys(false); }
  let result;
  try {
    if (mode.startsWith('refresh')) {
      const store = { delete: async key => { calls.push(['delete', key]); if (mode === 'refresh-reject') throw Error('delete'); } };
      owner._storeSDK = mode === 'refresh-absent' ? undefined : store;
      owner._cryptData = 'old'; owner._cryptObject = { old: true }; owner._signData = 'old';
      owner._initData = { keep: 'init' }; owner._ecdh_key = 'keep-ecdh'; owner.initMatch = true;
      result = await owner.refresh();
      calls.push(['retained', !!owner._storeSDK, owner._cryptData, owner._cryptObject, owner._signData, owner._initData, owner._ecdh_key, owner.initMatch]);
    } else {
      const detached = owner.start; result = detached(); // Source closure is callable without a receiver.
      if (mode === 'repeat') owner.start();
    }
  } catch (error) { result = { error: error.message }; }
  release.forEach(resolve => resolve(true)); await flush();
  const fields = ['signType', 'initType', 'enableEcdh', 'enableCache', 'updateKeys', 'aid'];
  const state = Object.fromEntries(fields.map(key => [key, owner[key]]));
  for (const [rawKey, sdkKey] of [['_storageNamespace', 'storageNamespace'], ['_disableCrossStorage', 'disableCrossStorage'], ['_iframeURL', 'iframeURL'], ['_iframeBackURL', 'iframeBackURL'], ['_disableStorageSignData', 'disableStorageSignData'], ['_agid', 'agid'], ['_ztIframe', 'ztIframe']]) state[sdkKey] = owner[kind === 'raw' ? rawKey : sdkKey];
  return compact({ result, state, calls });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-keys.js')).href);
  const modes = ['normal', 'pending', 'repeat', 'ecdh-off', 'cache-off', 'context-reset', 'type-reset', 'agid-number', 'agid-string', 'agid-explicit', 'setters',
    'store-throw', 'ecdh-throw', 'public-throw', 'cookie-throw', 'refresh', 'refresh-absent', 'refresh-reject'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', sdk, mode), mode);
  console.log(`PASS ${modes.length} raw Rr start/settings/refresh vs SDK traces (synthetic storage, no network)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
