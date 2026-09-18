// Full source ye + Se + De composition, with only browser I/O replaced by a synthetic owner.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { fixture, code, source, flush } = require('./desktop-web-secure-iframe-oracle.cjs');
const sourceCode = code + 'var ' + source.slice(47681, 54510) + ';var ne=false;var ' + source.slice(54697, 56586) + ';globalThis.Socket=Se;globalThis.bridge=De;';
function track(promise) {
  const state = { status: 'pending' };
  void promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => { state.status = 'rejected'; state.error = { name: error?.name, message: error?.message, origin: error?.origin }; }); return state;
}
function environment(top) {
  const f = fixture(); f.context.origin = 'https://app.synthetic.invalid';
  const add = f.context.addMessageListener;
  f.context.addMessageListener = listener => {
    // Browser EventTarget deduplicates repeated type/callback registrations.
    if (f.listeners.includes(listener)) f.trace.push(['message.on']); else add(listener);
  };
  const window = { ...f.context.window, location: { origin: f.context.origin },
    postMessage(data, origin) { f.trace.push(['self.post', data, origin]); },
    addEventListener(name, listener) { assert.equal(name, 'message'); f.context.addMessageListener(listener); },
    removeEventListener(name, listener) { assert.equal(name, 'message'); f.context.removeMessageListener(listener); },
  };
  window.parent = top ? window : { postMessage(data, origin) { f.trace.push(['parent.post', data, origin]); } };
  f.socketContext = { window, writeLocalStorage(key, value) { f.trace.push(['storage.write', key, value]); } };
  return f;
}
function native(f, config) {
  const sandbox = vm.createContext({ Promise, window: f.socketContext.window, document: f.context.document,
    navigator: f.context.navigator, performance: f.context.performance, Date: f.context.Date, Math: f.context.Math,
    location: f.socketContext.window.location, localStorage: { getItem: key => f.context.readLocalStorage(key), setItem: f.socketContext.writeLocalStorage },
    setTimeout: f.context.setTimeout, clearTimeout: f.context.clearTimeout,
  }); vm.runInContext(sourceCode, sandbox);
  const socket = new sandbox.Socket(config);
  return { socket, bridge: (...args) => sandbox.bridge(socket, ...args), parentIndex: () => socket.callParentBridgetIndex };
}
async function handshake(f, delay = 0) {
  f.fire(delay); await flush();
  const frame = f.frames.at(-1); assert(frame, 'missing synthetic frame');
  const origin = frame.src.split('//').slice(0, 2).join('//').split('/').slice(0, 3).join('/');
  f.receive('ACK', origin); await flush(); f.receive('ACK_1_ACK_0_0.25', origin); await flush();
}
async function run(create, scenario) {
  const parentMode = scenario.startsWith('parent'), f = environment(scenario === 'parent-top');
  const config = parentMode ? { protocol: 'SERCURE' } : { protocol: 'SERCURE', url: 'https://store.example/index.html', enableFallback: true };
  if (scenario === 'csp') {
    config.downgradeCSPURL = true; let attempts = 0; const createElement = f.context.document.createElement;
    f.context.document.createElement = tag => { if (tag === 'iframe' && attempts++ < 11) throw Error('synthetic Content Security Policy failure'); return createElement(tag); };
  }
  if (scenario === 'storage-blocked') f.socketContext.writeLocalStorage = () => { throw Error('synthetic storage blocked'); };
  if (scenario === 'parent-post-failure') f.socketContext.window.parent.postMessage = () => { throw Error('synthetic post failure'); };
  const instance = create(f, config), { socket } = instance, states = [];
  for (const name of ['debug', 'log', 'metrics', 'error', 'connection', 'connectionFail']) socket.on(name, event => {
    if (name === 'connection') f.trace.push([name, { startTime: event.startTime, endTime: event.endTime, valid: event.target.isValid() }]);
    else if (name === 'error' || name === 'connectionFail') f.trace.push([name, { name: event.name, message: event.message, origin: event.origin }]);
    else f.trace.push([name, event]);
  });
  if (parentMode) {
    try { socket.listen(); } catch (error) { f.trace.push(['listen.error', error.name, error.message]); }
    await socket.dispatchParentEvent('synthetic', 1).catch(() => undefined);
    const pending = socket.callParentBridge('storage', 'get', ['synthetic']); states.push(track(pending)); await flush();
    if (scenario === 'parent-timeout' || scenario === 'parent-top') { f.fire(5000); await flush(); }
    if (scenario !== 'parent-top') f.receive({ protocol: 'SERCURE', type: 'function', data: { id: 'p-1', message: scenario === 'parent-reject' ? '' : 7, promiseStatus: scenario === 'parent-reject' ? 'reject' : 'resolve' } }, 'https://parent.synthetic.invalid');
  } else if (scenario === 'csp') {
    states.push(track(socket.window));
    for (const delay of [0, ...Array(10).fill(100)]) { f.fire(delay); await flush(); }
    // The old result is rejected while the new CSP connection is independently pending.
    void socket.window.catch(() => undefined); await handshake(f, 100);
  } else if (scenario === 'capture') {
    states.push(track(socket.postIframeMessage({ synthetic: 1 })));
    await socket.start({ url: 'https://changed.example/frame', protocol: 'Changed' });
    await handshake(f);
  } else {
    void socket.window.catch(() => undefined);
    const bridge = instance.bridge(); states.push(track(bridge('storage', 'getItemByKeys', [['synthetic']])));
    await handshake(f);
    f.receive({ protocol: 'SERCURE', data: { id: '0', message: 'ignored' } }, 'https://wrong.invalid');
    f.receive({ protocol: 'SERCURE', data: { id: '0', message: 'synthetic-value', promiseStatus: scenario === 'reject' ? 'reject' : 'resolve' } }); await flush();
    if (scenario === 'restart') { socket.reStartConection('manual'); await flush(); await handshake(f); }
    if (scenario === 'cached-reconnection') { await socket.reConnection(); }
    if (scenario === 'invalid-precheck') { f.frames[0].parentNode = null; states.push(track(socket.preCheck())); await flush(); states.push({ beforeNewAck: socket.getIframeState() }); await handshake(f); }
    if (scenario === 'diagnostic') { f.receive('prefix SOCKET_ERROR_synthetic', 'https://wrong.invalid'); f.receive('prefix Version:4.0.3:ignored', 'https://wrong.invalid'); }
  }
  await flush();
  return structuredClone({ states, trace: f.trace, config: socket.config, status: socket.getIframeState(), isStart: socket.isStart,
    parentIndex: instance.parentIndex(), timers: [...f.timers].map(([id, timer]) => [id, timer.delay]), listeners: f.listeners.length,
    frames: f.frames.map(frame => ({ src: frame.src, attached: !!frame.parentNode })),
  });
}
void (async () => {
  const { DesktopWebSecureIframeHost } = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-iframe.js')).href);
  const { DesktopWebSecureSocket } = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-socket.js')).href);
  const { DesktopWebSecureBridgeHost } = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-bridge.js')).href);
  const sdk = (f, config) => {
    const socket = new DesktopWebSecureSocket(new DesktopWebSecureIframeHost(f.context), f.socketContext, config);
    const bridge = new DesktopWebSecureBridgeHost(f.context);
    return { socket, bridge: (...args) => bridge.createBridge(socket, ...args), parentIndex: () => socket.parentCallIndex };
  };
  let count = 0;
  for (const scenario of ['success', 'reject', 'capture', 'restart', 'cached-reconnection', 'invalid-precheck', 'diagnostic', 'csp', 'storage-blocked', 'parent-success', 'parent-reject', 'parent-timeout', 'parent-top', 'parent-post-failure']) {
    assert.deepEqual(await run(sdk, scenario), await run(native, scenario), scenario); count++;
  }
  console.log(`PASS ${count} original / built SDK full iframe + socket + bridge integration traces`);
})().catch(error => { console.error(error); process.exitCode = 1; });
