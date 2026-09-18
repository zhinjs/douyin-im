const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Usage: node scripts/research/desktop-web-secure-iframe-oracle.cjs /path/to/860.js');
const source = readFileSync(resolve(process.argv[2]), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const code = 'var lt={proxy:function(){}};var ' + source.slice(source.indexOf('ht=(lt.proxy'), source.indexOf('const pt=')) +
  source.slice(source.indexOf('const pt='), 30511) + source.slice(30511, source.indexOf(',Tt={}')) + ';' +
  source.slice(source.indexOf('var Jt=window'), source.indexOf(',Yt=function')) + ';var ' + source.slice(39692, 40096) + ';var ' +
  source.slice(42922, source.indexOf(',ge=function', 43763)) + ';globalThis.out={Connection:ye,flightErrors:de,resourceURL:wt,fallbackURL:_t};';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  let clock = 10, id = 0;
  const trace = [], timers = new Map(), listeners = [], documentListeners = {}, frames = [], boxes = new Map();
  const parent = label => ({ parentNode: null,
    appendChild(node) { trace.push(['append', label, node.src ?? node.id]); node.parentNode = this; if (node.id) boxes.set(node.id, node); },
    removeChild(node) { trace.push(['remove', label, node.src ?? node.id]); node.parentNode = null; },
  });
  const body = parent('body');
  const target = { postMessage(data, origin) { trace.push(['post', data, origin]); } };
  const document = { body, readyState: 'complete', visibilityState: 'visible',
    getElementById(id) { trace.push(['getElement', id]); return boxes.get(id) ?? null; },
    createElement(tag) { trace.push(['create', tag]);
      if (tag === 'div') return { ...parent('box'), style: { display: '' }, id: '' };
      const frame = { parentNode: null, style: { display: '' }, src: '', contentWindow: target, onload: null }; frames.push(frame); return frame;
    },
    addEventListener(name, listener) { trace.push(['doc.on', name]); (documentListeners[name] ||= []).push(listener); },
    removeEventListener(name, listener) { trace.push(['doc.off', name]); const list = documentListeners[name] || [], i = list.indexOf(listener); if (i !== -1) list.splice(i, 1); },
  };
  const context = { origin: 'https://synthetic.invalid', document, navigator: { userAgent: 'synthetic' }, window: {},
    performance: { now: () => clock++ }, Date: { now: () => 9000 }, Math: { random: () => 0.25 },
    readLocalStorage(key) { trace.push(['storage', key]); return null; },
    setTimeout(callback, delay) { trace.push(['timer', ++id, delay]); timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { trace.push(['clear', id]); timers.delete(id); },
    addMessageListener(listener) { trace.push(['message.on']); listeners.push(listener); },
    removeMessageListener(listener) { trace.push(['message.off']); const i = listeners.indexOf(listener); if (i !== -1) listeners.splice(i, 1); },
  };
  return { context, trace, timers, listeners, frames, target, body, documentListeners,
    receive(data, origin = 'https://store.example', source = target) { [...listeners].forEach(listener => listener({ data, origin, source })); },
    fire(delay) { const pair = [...timers].find(([, timer]) => timer.delay === delay); assert(pair, `missing timer ${delay}`); timers.delete(pair[0]); pair[1].callback(); },
  };
}
function native(f) {
  const window = { ...f.context.window, location: { origin: f.context.origin },
    addEventListener(name, listener) { assert.equal(name, 'message'); f.context.addMessageListener(listener); },
    removeEventListener(name, listener) { assert.equal(name, 'message'); f.context.removeMessageListener(listener); },
  };
  const sandbox = vm.createContext({ Promise, window, document: f.context.document, navigator: f.context.navigator,
    performance: f.context.performance, Date: f.context.Date, Math: f.context.Math, location: window.location,
    localStorage: { getItem: key => f.context.readLocalStorage(key) }, setTimeout: f.context.setTimeout, clearTimeout: f.context.clearTimeout,
  }); vm.runInContext(code, sandbox);
  return { create: config => new sandbox.out.Connection(config), flightErrors: sandbox.out.flightErrors,
    resourceURL: sandbox.out.resourceURL, fallbackURL: sandbox.out.fallbackURL };
}
function track(promise) {
  const state = { status: 'pending' };
  void promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => { state.status = 'rejected'; state.error = { name: error?.name, message: error?.message, origin: error?.origin }; });
  return state;
}
async function run(create, scenario) {
  const f = fixture();
  if (scenario === 'dom-wait') { f.context.document.body = null; f.context.document.readyState = 'loading'; }
  if (scenario.startsWith('post-error')) f.target.postMessage = () => { throw Error('synthetic target failure'); };
  const host = create(f), connection = host.create({ url: 'https://store.example/frame', debug: true });
  for (const name of ['log', 'debug', 'metrics']) connection.on(name, event => f.trace.push([name, event]));
  if (scenario === 'post-error-exhausted') host.flightErrors.current = host.flightErrors.max;
  if (scenario.startsWith('flight-')) {
    const state = track(connection.createPostMessageFlight(data => {
      f.trace.push(['flight.send', data]);
      if (scenario === 'flight-sync') f.receive(`ACK_1_${data}`, 'https://unrelated.invalid', null);
      if (scenario === 'flight-throw') throw Error('synthetic');
    })); await flush();
    if (scenario === 'flight-timeout') { f.fire(3000); await flush(); }
    else if (scenario === 'flight-async') f.receive('ACK_1_ACK_0_0.25', 'https://unrelated.invalid', null);
    await flush(); return structuredClone({ state, trace: f.trace, timers: [...f.timers].map(([id, timer]) => [id, timer.delay]), listeners: f.listeners.length });
  }
  const state = track(connection.createIframeElement('https://store.example/frame')); await flush();
  if (scenario === 'dom-wait') { assert.equal(f.timers.size, 0); f.context.document.body = f.body; f.documentListeners.DOMContentLoaded[0](); await flush(); }
  if (scenario === 'main-timeout') f.fire(120000);
  else if (scenario === 'load-timeout') { f.frames[0].onload(); f.fire(2000); }
  else {
    f.receive('ACK', 'https://wrong.invalid');
    if (scenario === 'load-first') f.frames[0].onload();
    f.receive('ACK'); await flush();
    if (scenario === 'frame-flight-timeout') f.fire(3000);
    else if (!scenario.startsWith('post-error')) f.receive('ACK_1_ACK_0_0.25');
  }
  await flush();
  if (state.status === 'fulfilled') {
    const frame = state.value;
    const details = { startTime: frame.startTime, endTime: frame.endTime, valid: frame.isValid() };
    if (!scenario.startsWith('post-error')) frame.postMessage('synthetic-user-data', 'https://store.example');
    frame.destory(); details.afterDestroy = frame.isValid(); state.value = details;
  }
  return structuredClone({ state, trace: f.trace, timers: [...f.timers].map(([id, timer]) => [id, timer.delay]), listeners: f.listeners.length, flightErrors: host.flightErrors });
}
async function loadTrace(create, mode) {
  const f = fixture(); if (mode.startsWith('fallback')) f.context.readLocalStorage = () => '4.0.2';
  if (mode === 'hidden') f.context.document.visibilityState = 'hidden';
  const host = create(f), connection = host.create({ url: 'https://store.example/index.html?x=1' });
  const calls = [], failure = new Error('synthetic load failure'); let tries = 0;
  connection.autoLoadIframeConfig.max = 2;
  connection.createIframeElement = (url, timeout) => { calls.push([url, timeout]); tries++;
    if (mode === 'success' && tries === 3 || (mode === 'fallback' || mode === 'hidden') && tries === 4) return Promise.resolve({ done: true });
    return Promise.reject(tries === 4 ? new Error('synthetic fallback failure') : failure);
  };
  const first = connection.start(); assert.equal(connection.start(), first); const state = track(first);
  for (const delay of [0, 100, 100]) { f.fire(delay); await flush(); }
  if (mode === 'hidden') { f.context.document.visibilityState = 'visible'; f.documentListeners.visibilitychange[0](); await flush(); f.fire(100); await flush(); }
  await flush(); const before = { current: connection.autoLoadIframeConfig.current, max: connection.autoLoadIframeConfig.max };
  host.flightErrors.current = host.flightErrors.max; connection.reset(); connection.setConfig({ ackTimeout: 0, url: '' });
  return structuredClone({ state, calls, trace: f.trace, before, after: connection.autoLoadIframeConfig, config: connection.config, flightErrors: host.flightErrors });
}
async function main() {
  const { DesktopWebSecureIframeHost } = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-iframe.js')).href);
  const sdk = f => { const host = new DesktopWebSecureIframeHost(f.context); return { create: config => host.createConnection(config), flightErrors: host.flightErrors, resourceURL: (...args) => host.resourceURL(...args), fallbackURL: () => host.fallbackURL() }; };
  let count = 0;
  for (const scenario of ['success', 'load-first', 'dom-wait', 'main-timeout', 'load-timeout', 'frame-flight-timeout', 'post-error', 'post-error-exhausted', 'flight-async', 'flight-sync', 'flight-throw', 'flight-timeout']) {
    assert.deepEqual(await run(sdk, scenario), await run(native, scenario), scenario); count++;
  }
  for (const mode of ['success', 'failure', 'fallback', 'fallback-failure', 'hidden']) { assert.deepEqual(await loadTrace(sdk, mode), await loadTrace(native, mode), mode); count++; }
  for (const userAgent of ['synthetic', 'Chrome/75.0', 'Chrome/76.0', 'chrome/120.0']) for (const capability of ['none', 'userAgentData', 'getDirectory', 'canShare', 'viewport']) {
    const make = () => { const f = fixture(); f.context.navigator.userAgent = userAgent;
      if (capability === 'userAgentData') f.context.navigator.userAgentData = {};
      if (capability === 'getDirectory') f.context.navigator.storage = { getDirectory() {} };
      if (capability === 'canShare') f.context.navigator.canShare = true;
      if (capability === 'viewport') f.context.window = { Promise: { allSettled: Promise.allSettled }, visualViewport: {} };
      return f;
    };
    const a = sdk(make()), b = native(make());
    assert.equal(a.resourceURL('https://synthetic.invalid/'), b.resourceURL('https://synthetic.invalid/')); count++;
  }
  console.log(`PASS ${count} original / built SDK iframe, ACK, retry and resource-selection traces`);
}
module.exports = { fixture, code, source, flush };
if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
