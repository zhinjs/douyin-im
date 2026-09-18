// Raw Ie + Se + De against the built SDK; local storage and browser I/O are synthetic.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { fixture, code, source, flush } = require('./desktop-web-secure-iframe-oracle.cjs');
const raw = code + 'var ' + source.slice(source.indexOf('Yt=function'), source.indexOf(',ee="J_uc_iframe_box')) + ';var ' + source.slice(47681, 54510) + ';var ne=false;var ' + source.slice(54511, 56586) +
  ';var oe=function(){};var ue=["security-sdk/s_sdk_crypt_sdk","security-sdk/s_sdk_cert_key","security-sdk/s_sdk_sign_data_key/web_protect"];var ce=Local;var ' + source.slice(56587, 64594) + ';globalThis.Cross=Ie;';
const keys = ['security-sdk/s_sdk_crypt_sdk', 'security-sdk/s_sdk_cert_key', 'security-sdk/s_sdk_sign_data_key/web_protect'];
function track(promise) {
  const state = { status: 'pending' };
  void promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => { state.status = 'rejected'; state.error = { name: error?.name, message: error?.message, origin: error?.origin }; }); return state;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function events() {
  const listeners = {};
  return { on(name, fn) { (listeners[name] ||= []).push(fn); }, emit(name, data) { (listeners[name] || []).slice().forEach(fn => fn(data)); } };
}
function environment() {
  const f = fixture(), io = [], packets = [];
  const value = value => ({ value, from: 0, origin: f.context.origin });
  const local = Object.assign(events(), {
    localDB: { getItemByKeys(list) { io.push(['raw.get', list]); return Promise.resolve(['private', 'cert', 'sign']); } },
    getItemByKeys(list) { io.push(['local.get', list]); return Promise.resolve(list.map(key => value(`local:${key}`))); },
    getItem(key) { io.push(['local.item', key]); return Promise.resolve(value(`local:${key}`)); },
    setItemByKeys(entries) { io.push(['local.set', entries]); return Promise.resolve(entries.map(([, data]) => value(data))); },
    removeItem(key) { io.push(['local.remove', key]); return Promise.resolve(); },
  });
  const parent = { postMessage(data, origin) { io.push(['parent.post', data, origin]); } };
  const window = { ...f.context.window, location: { origin: f.context.origin, hostname: 'synthetic.invalid' }, parent,
    addEventListener(_name, listener) { if (!f.listeners.includes(listener)) f.context.addMessageListener(listener); },
    postMessage(data, origin) { io.push(['self.post', data, origin]); },
  };
  const frame = { startTime: 0, endTime: 0, isValid: () => true, destory() {}, postMessage(data, origin) { io.push(['frame.post', data, origin]); packets.push(data.data); } };
  return Object.assign(f, { io, local, packets, window, frame, value });
}
function native(f, config) {
  const sandbox = vm.createContext({ Promise, window: f.window, document: f.context.document, navigator: f.context.navigator,
    performance: f.context.performance, Date: f.context.Date, Math: f.context.Math, location: f.window.location,
    setTimeout: f.context.setTimeout, clearTimeout: f.context.clearTimeout, localStorage: { getItem: f.context.readLocalStorage, setItem() {} },
    Local: function(config) { f.io.push(['local.create', config]); return f.local; },
  }); vm.runInContext(raw, sandbox); return new sandbox.Cross(config);
}
function sdk(f, config, modules) {
  const host = new modules.iframe.DesktopWebSecureIframeHost(f.context), bridges = new modules.bridge.DesktopWebSecureBridgeHost(f.context);
  return new modules.cross.DesktopWebSecureCrossStorage(host, bridges, { window: f.window, hostname: 'synthetic.invalid', writeLocalStorage() {},
    createLocalStorage(config) { f.io.push(['local.create', config]); return f.local; },
  }, config);
}
async function run(kind, modules, mode) {
  const f = environment(), config = { protocol: 'SERCURE', disableReportLogger: true };
  if (mode.startsWith('signed')) config.verifySignMethod = values => { f.io.push(['verify', values]); return mode !== 'signed-false'; };
  const cross = kind === 'native' ? native(f, config) : sdk(f, config, modules);
  cross.on('metrics', event => f.io.push(['metrics', event])); cross.on('log', event => f.io.push(['log', event])); cross.on('error', error => f.io.push(['error', error.name, error.message, error.origin]));
  if (!mode.includes('no-url') && mode !== 'checker-wait' && mode !== 'config-only') {
    cross.client.config.url = 'https://store.example/frame'; cross.client.isConnection = true;
    cross.client.window = Promise.resolve({ target: f.frame, startTime: 0, endTime: 0 });
  }
  const respond = (value, reject = false) => { const packet = f.packets.shift(); assert(packet, 'missing remote request');
    cross.client.emit('message', { data: { id: packet.id, promiseStatus: reject ? 'reject' : 'resolve', message: value }, origin: 'https://store.example', type: 'function', sourceWindow: f.window }); };
  let pending;
  const remoteValue = data => ({ value: data, from: 1, origin: 'https://store.example' });
  if (mode === 'config-only') {
    pending = track(cross.setConfig({ url: 'https://new.example', debug: true })); await flush();
    f.io.push(['configs', cross.config, cross.client.config]);
  } else if (mode.startsWith('signed')) {
    const list = mode === 'signed-empty' ? [] : mode === 'signed-outside' ? ['other'] : [keys[2], keys[0], keys[2]];
    pending = track(cross.getItemByKeys(list)); await flush();
    if (f.packets.length) { respond(list.map(() => remoteValue('remote'))); await flush(); }
  } else if (mode.startsWith('get')) {
    if (mode === 'get-both-fail') f.local.getItemByKeys = list => { f.io.push(['local.get.fail', list]); return Promise.reject(Error('local')); };
    pending = track(cross.getItemByKeys(['key'], mode === 'get-async-false' || mode === 'get-async-remote' ? { async: false } : mode === 'get-no-log' ? { logger: false } : undefined)); await flush();
    if (mode === 'get-async-false') { f.fire(1000); await flush(); f.io.push(['early', structuredClone(pending)]); }
    if (f.packets.length) { respond(mode === 'get-missing' ? [remoteValue(undefined)] : mode === 'get-empty' ? [remoteValue('')] : mode === 'get-reject' || mode === 'get-both-fail' ? 'Rejected' : [remoteValue('remote')], ['get-reject', 'get-both-fail'].includes(mode)); await flush(); }
    if (mode === 'get-async-remote') { f.fire(1000); await flush(); }
  } else if (mode.startsWith('set')) {
    if (mode === 'set-local-fail' || mode === 'set-timeout-local-fail') f.local.setItemByKeys = entries => { f.io.push(['local.set.fail', entries]); return Promise.reject(Error('local')); };
    const slow = deferred();
    if (mode === 'set-wait-local') f.local.setItemByKeys = entries => { f.io.push(['local.set.wait', entries]); return slow.promise; };
    pending = track(cross.setItemByKeys([['key', 'value']], mode.startsWith('set-async') ? { async: false } : undefined)); await flush();
    if (mode === 'set-timeout-local-fail' || mode === 'set-timeout') { f.fire(2500); await flush(); f.io.push(['early', structuredClone(pending)]); }
    if (mode.startsWith('set-async')) {
      f.fire(1000); await flush(); f.io.push(['early', structuredClone(pending)]);
      respond(mode === 'set-async-retry' || mode === 'set-async-fail' ? 'FirstReject' : [remoteValue('remote')], mode !== 'set-async'); await flush();
      if (mode !== 'set-async') { respond(mode === 'set-async-fail' ? 'SecondReject' : [remoteValue('retry')], mode === 'set-async-fail'); await flush(); }
    } else if (f.packets.length) { respond(mode === 'set-reject' ? 'Rejected' : [remoteValue('remote')], mode === 'set-reject'); await flush(); }
    if (mode === 'set-wait-local') { f.io.push(['waiting', structuredClone(pending)]); slow.resolve([f.value('local-result')]); await flush(); }
  } else if (mode.startsWith('remove')) {
    pending = track(cross.removeItem('key')); await flush(); if (f.packets.length) { respond(mode === 'remove-reject' ? 'Rejected' : undefined, mode === 'remove-reject'); await flush(); }
  } else if (mode.startsWith('checker')) {
    pending = track(cross.startStorageChecker()); await flush();
    if (mode === 'checker-wait') { cross.client.emit('connectionFail', Error('failed')); await flush(); f.io.push(['still', structuredClone(pending)]); }
    else { respond('checked'); await flush(); }
  } else if (mode === 'origin-config') { pending = track(cross.setOriginStorageConfig({ a: 1 })); await flush(); respond('configured'); await flush(); }
  else if (mode === 'origin-config-no-url') { cross.client.isConnection = true; pending = track(cross.setOriginStorageConfig({ a: 1 })); await flush(); }
  else if (mode === 'event-error' || mode === 'event-error-origin' || mode === 'event-log') {
    cross.client.emit('message', { type: 'event', data: { message: { eventName: mode === 'event-log' ? 'log' : 'error', eventData: mode === 'event-log' ? { name: 'log' } : { name: 'RemoteError', message: 'bad', origin: mode === 'event-error-origin' ? 'https://remote.example' : undefined } } } });
    await flush(); pending = { status: 'observed' };
  } else if (mode.startsWith('inbound')) {
    const source = { postMessage(data, origin) { f.io.push(['inbound.reply', data, origin]); } };
    cross.client.emit('message', { type: 'function', origin: 'https://store.example', sourceWindow: source,
      data: { id: 'p-5', message: { callObj: mode === 'inbound-disallowed' ? 'unknown' : 'config', callName: mode === 'inbound-unknown' ? 'missing' : 'startChecker', callArgs: [] } } });
    await flush(); pending = { status: 'observed' };
  }
  assert(pending, mode);
  return structuredClone({ pending, io: f.io, timers: [...f.timers.values()].map(timer => timer.delay), packets: f.packets });
}
async function main() {
  const modules = {};
  for (const name of ['cross', 'iframe', 'bridge']) modules[name] = await import(pathToFileURL(resolve(`lib/anti-bot/desktop-web-secure-${name === 'cross' ? 'cross-storage' : name}.js`)).href);
  const modes = ['config-only', 'signed', 'signed-empty', 'signed-false', 'signed-outside', 'get', 'get-no-url', 'get-no-log', 'get-missing', 'get-empty', 'get-reject', 'get-both-fail', 'get-async-false', 'get-async-remote', 'set', 'set-no-url', 'set-reject', 'set-local-fail', 'set-timeout', 'set-timeout-local-fail', 'set-wait-local', 'set-async', 'set-async-retry', 'set-async-fail', 'remove', 'remove-no-url', 'remove-reject', 'checker', 'checker-wait', 'origin-config', 'origin-config-no-url', 'inbound', 'inbound-unknown', 'inbound-disallowed', 'event-error', 'event-error-origin', 'event-log'];
  for (const mode of modes) assert.deepStrictEqual(await run('sdk', modules, mode), await run('native', modules, mode), mode);
  console.log(`PASS ${modes.length} raw Ie + Se + De / built SDK cross-storage traces`);
}
module.exports = { raw, environment, track, flush, source };
if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
