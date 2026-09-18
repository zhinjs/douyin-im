const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Usage: node scripts/research/desktop-web-secure-bridge-oracle.cjs /path/to/860.js');
const source = readFileSync(resolve(process.argv[2]), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const errorCode = 'var yt;var ' + source.slice(source.indexOf('St=(yt='), source.indexOf(',Tt={}')) + ';';
const bridgeCode = errorCode + 'var ' + source.slice(38707, 38794) + ';var ne=false;var ' + source.slice(54697, 56586) + ';globalThis.bridge=De;globalThis.snapshot=()=>({entries:Ee,nextId:Ce,retryBeforeId:xe,retry:!!Te});';
const dispatchCode = 'var ' + source.slice(48367, 48561) + ';var ' + source.slice(38795, 38888) + ';' + source.slice(51357, 52441) + ';';
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function track(promise) {
  const state = { status: 'pending' };
  void promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => {
    state.status = 'rejected'; state.error = { name: error?.name, message: error?.message, origin: error?.origin };
  }); return state;
}
function fixture() {
  let clock = 10, timerId = 0;
  const timers = new Map(), trace = [], listeners = [], globalListeners = [];
  const context = { origin: 'https://synthetic.invalid', performance: { now: () => clock++ }, Date: { now: () => 999 },
    setTimeout(callback, delay) { trace.push(['timer', ++timerId, delay]); timers.set(timerId, callback); return timerId; },
    clearTimeout(id) { trace.push(['clear', id]); timers.delete(id); },
    addMessageListener(listener) { trace.push(['globalListener']); globalListeners.push(listener); },
  };
  const client = { config: {}, window: Promise.resolve(), isConnection: true,
    preCheck() { trace.push(['preCheck']); return Promise.resolve(); },
    postIframeMessage(message) { trace.push(['post', message]); return Promise.resolve(); },
    getIframeState() { return { connection: 1 }; },
    reStartConection(reason) { trace.push(['restart', reason]); },
    emit(name, event) { trace.push([name, event]); },
    on(name, listener) { trace.push(['on', name]); listeners.push(listener); },
    off(name, listener) { trace.push(['off', name]); const i = listeners.indexOf(listener); if (i !== -1) listeners.splice(i, 1); },
  };
  return { context, client, trace, timers, listeners, globalListeners,
    fire(id) { const callback = timers.get(id); assert(callback); timers.delete(id); callback(); },
    receive(data) { [...listeners].forEach(listener => listener({ data })); },
  };
}
function original(f) {
  const sandbox = vm.createContext({ Promise, performance: f.context.performance, Date: f.context.Date,
    location: { origin: f.context.origin }, setTimeout: f.context.setTimeout, clearTimeout: f.context.clearTimeout,
    window: { addEventListener(name, listener) { assert.equal(name, 'message'); f.context.addMessageListener(listener); } },
  });
  vm.runInContext(bridgeCode, sandbox); return { create: sandbox.bridge, snapshot: sandbox.snapshot };
}
async function run(create, scenario) {
  const f = fixture(), states = []; let release;
  if (scenario === 'precheck') f.client.preCheck = () => new Promise(resolve => { release = resolve; });
  if (scenario === 'window' || scenario === 'late-window') f.client.window = new Promise(resolve => { release = resolve; });
  if (scenario === 'post-failure') f.client.postIframeMessage = () => Promise.reject(Object.assign(new Error('synthetic'), { name: 'PostFailure' }));
  if (scenario === 'debug-retry') f.client.config.debug = true;
  if (scenario === 'not-connected') f.client.isConnection = false;
  const host = create(f), retry = scenario.startsWith('retry') || scenario === 'debug-retry' || scenario === 'not-connected';
  const bridge = host.create(f.client, retry, 3000);
  if (scenario === 'invalid') { states.push(track(bridge(1, 'get'))); await flush(); }
  states.push(track(bridge('storage', 'get', ['synthetic-key']))); await flush();
  const id = scenario === 'invalid' ? '1' : '0';
  if (scenario === 'precheck') { assert.equal(f.timers.size, 0); release(); await flush(); f.receive({ id, message: 'value' }); }
  else if (scenario === 'window') { assert.equal(f.listeners.length, 0); release(); await flush(); f.receive({ id, message: 'value' }); }
  else if (scenario === 'late-window') { f.fire(1); await flush(); release(); await flush(); f.receive({ id, message: 'late' }); }
  else if (scenario === 'reject') f.receive({ id, promiseStatus: 'reject', message: '' });
  else if (scenario === 'malformed') { f.receive(null); await flush(); f.receive({ id, message: 'late' }); }
  else if (scenario === 'timeout' || scenario === 'not-connected') { f.fire(1); await flush(); }
  else if (scenario === 'late') { f.fire(1); await flush(); f.receive({ id, message: 'late' }); }
  else if (retry) {
    f.fire(1); await flush();
    if (scenario === 'retry-late') f.receive({ id, message: 'late' });
    else { for (const listener of f.globalListeners) listener({ data: 'log:synthetic' }); f.fire(2); }
  } else { f.receive({ id: Number(id), message: 'wrong' }); f.receive({ id, message: false }); }
  await flush();
  return structuredClone({ states, trace: f.trace, timers: [...f.timers.keys()], listeners: f.listeners.length, snapshot: host.snapshot() });
}
function gateTrace(dispatch, config, origin, data, fail) {
  const trace = [], sourceWindow = { postMessage(message, target) { trace.push(['post', message, target]); } };
  const emit = (name, event) => { if (name === 'message' && fail) throw Error('synthetic consumer failure');
    trace.push([name, name === 'message' ? { ...event, sourceWindow: event.sourceWindow === sourceWindow ? 'source' : 'other' } : event]); };
  dispatch(config, { origin, data, source: sourceWindow }, { originSuffix: '.douyin.com', emit });
  return structuredClone(trace);
}
void (async () => {
  const sdk = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-bridge.js')).href);
  let count = 0;
  for (const scenario of ['success', 'invalid', 'precheck', 'window', 'late-window', 'reject', 'malformed', 'post-failure', 'timeout', 'late', 'retry-timeout', 'retry-late', 'debug-retry', 'not-connected']) {
    const reference = await run(original, scenario);
    const actual = await run(f => { const host = new sdk.DesktopWebSecureBridgeHost(f.context); return { create: (...args) => host.createBridge(...args),
      snapshot: () => ({ entries: host.entries, nextId: host.nextId, retryBeforeId: host.retryBeforeId, retry: !!host.retry }) }; }, scenario);
    assert.deepEqual(actual, reference, scenario); count++;
  }
  const originalGate = (config, event, dispatcher) => {
    const sandbox = vm.createContext({ r: { config, emit: dispatcher.emit }, _e: dispatcher.originSuffix });
    vm.runInContext(dispatchCode, sandbox); sandbox.r.onMessage(event);
  };
  for (const url of ['https://store.example/frame', '', '/relative']) for (const origin of ['https://store.example', 'https://a.douyin.com.untrusted.example', 'https://elsewhere.invalid', '']) {
    for (const data of ['ACK_0_test', { protocol: 'SERCURE', type: 'function', data: { id: '0' } }, { protocol: 'other' }, null]) {
      for (const fail of [false, true]) {
        const config = { url, protocol: 'SERCURE', allowOrigin: ['elsewhere.invalid'] };
        assert.deepEqual(gateTrace(sdk.dispatchDesktopWebSecureSocketMessage, config, origin, data, fail), gateTrace(originalGate, config, origin, data, fail), `gate ${url}/${origin}/${JSON.stringify(data)}/${fail}`); count++;
      }
    }
  }
  console.log(`PASS ${count} original / built SDK bridge and origin/protocol dispatch traces`);
})().catch(error => { console.error(error); process.exitCode = 1; });
