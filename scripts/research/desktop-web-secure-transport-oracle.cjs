// Raw _o hooks vs compiled hooks with synthetic XHR/fetch and pipeline. Never sends network traffic.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { source, flush } = require('./desktop-web-secure-keys-oracle.cjs');
const raw = '"use strict";var ' + source.slice(source.indexOf('zn=['), source.indexOf('var Zn,')) +
  'var ' + source.slice(source.indexOf('vo=function', 183000), source.indexOf(';const So=')) + ';globalThis.Hooks=_o;globalThis.parse=Gn;';
const compact = value => JSON.parse(JSON.stringify(value, (_key, item) => item && Object.prototype.toString.call(item) === '[object Error]' ? { name: item.name } : item));
function fixture(mode) {
  const calls = [], receiver = { receiver: true }, match = { needProxy: mode !== 'unmatched' }, background = [];
  let finish, prepare, sent = 0;
  class Headers {
    constructor(values = {}) { this.values = { ...values }; }
    set(name, value) { calls.push(['headers-set', name, value]); this.values[name] = value; }
  }
  class Request { constructor() { this.url = 'https://synthetic.invalid/request'; this.method = 'POST'; this.headers = new Headers({ keep: 'request' }); } }
  class Xhr {
    constructor() { this.readyState = 0; this.onloadend = null; this.onreadystatechange = null; }
    open(...args) { calls.push(['open', args, this instanceof Xhr]); return 'native-open'; }
    send(...args) { sent++; calls.push(['send', args, this instanceof Xhr]); return 'native-send'; }
    setRequestHeader(...args) { calls.push(['set-header', args, this instanceof Xhr]); }
    getAllResponseHeaders() { calls.push(['get-all']); if (mode === 'xhr-response-throw') throw Error('read'); return 'X-CUSTOM: first\nX-Custom: second\nContent-Type: a\nContent-Type: b\nSet-Cookie: a=b\nSet-Cookie: c=d'; }
  }
  const pipeline = {
    on() {}, // This transport-control-flow fixture does not emit pipeline telemetry.
    classify(request, config, signType, initType) { calls.push(['classify', compact(request), config, signType, initType]); if (mode === 'classify-throw') throw Error('classify'); return match; },
    prepare(request, route) {
      assert.equal(route, match); calls.push(['prepare', compact(request)]);
      if (mode === 'prepare-throw') throw Error('prepare');
      if (mode === 'prepare-undefined') return undefined;
      if (mode === 'prepare-reject') return Promise.reject(Error('prepare'));
      const result = { ...request, headers: { 'x-first': 'one', 'x-second': 'two' }, extras: { fixture: 'synthetic' } };
      if (mode === 'prepare-null') return Promise.resolve(null);
      if (mode === 'xhr-prepare-pending') return new Promise(resolve => { prepare = () => resolve(result); });
      return Promise.resolve(result);
    },
    complete(response, route, updateData) {
      assert.equal(route, match); calls.push(['complete', compact(response), updateData]);
      if (mode === 'complete-throw') throw Error('complete');
      if (mode === 'complete-undefined') return undefined;
      if (mode === 'complete-reject' || mode === 'xhr-complete-reject') return Promise.reject(Error('complete'));
      if (mode === 'complete-pending' || mode === 'xhr-complete-pending') return new Promise(resolve => { finish = () => resolve(response); });
      return Promise.resolve(response);
    },
  };
  const response = { headers: { forEach(callback) { calls.push(['response-forEach']); if (mode === 'response-forEach-throw') throw Error('headers'); callback('data', 'Bd-Ticket-Guard-Server-Data'); callback('log', 'x-tt-logid'); } }, body: 'unread' };
  if (mode === 'get-only') response.headers = { get(name) { calls.push(['response-get', name]); return name.includes('data') ? 'data' : 0; } };
  if (mode === 'no-reader') response.headers = {};
  if (mode === 'no-response-headers') delete response.headers;
  const nativeFetch = function(...args) {
    calls.push(['fetch', compact(args), this === receiver, args.length]);
    if (mode === 'native-throw') throw Error('fetch'); if (mode === 'native-reject') return Promise.reject(Error('fetch'));
    return Promise.resolve(response);
  };
  const window = { XMLHttpRequest: Xhr, Request, Headers, fetch: nativeFetch };
  if (mode === 'fetch-added-late') delete window.fetch;
  const context = { window, XMLHttpRequest: Xhr, Request, Headers, URL, location: { href: 'https://synthetic.invalid/base/' }, onBackgroundError: error => background.push(error.name) };
  return { calls, receiver, match, pipeline, Xhr, Request, Headers, window, context, response, nativeFetch, background, sent: () => sent, release: () => { prepare?.(); finish?.(); } };
}
async function scenario(kind, sdk, mode, transport) {
  const f = fixture(mode); let hooks;
  if (kind === 'raw') {
    const scope = vm.createContext({ window: { ...f.window, location: f.context.location }, XMLHttpRequest: f.Xhr, Request: f.Request, Headers: f.Headers, URL, Promise,
      dt: function() { this.emit = () => {}; },
      so: (...args) => f.pipeline.classify(...args), uo: (request, _params, route) => f.pipeline.prepare(request, route), ho: (response, _params, route, updateData) => f.pipeline.complete(response, route, updateData) });
    // Preserve the same window object identity for patched surfaces and feature snapshots.
    f.window = scope.window; vm.runInContext(raw, scope);
    if (mode === 'fetch-added-late') f.window.fetch = f.nativeFetch;
    hooks = new scope.Hooks({});
  } else {
    sdk.captureDesktopWebSecureTransportFeatures(f.window);
    if (mode === 'fetch-added-late') f.window.fetch = f.nativeFetch;
    hooks = new sdk.DesktopWebSecureTransportHooks(f.context, f.pipeline);
  }
  hooks.config = { fixture: true }; hooks.updateData = true;
  let value, failure, synchronous = false, pending = false;
  if (transport === 'fetch') {
    let input = '/fetch', options = { method: 'PUT', headers: { keep: 'options' } };
    if (mode === 'request') { input = new f.Request(); options = { method: 'DELETE', headers: { override: 'kept' } }; }
    if (mode === 'headers-instance') options.headers = new f.Headers({ keep: 'bag' });
    if (mode === 'headers-array') options.headers = [['x-first', 'old']];
    if (mode === 'frozen-init') Object.freeze(options);
    if (mode === 'frozen-headers') Object.freeze(options.headers);
    if (mode === 'partial-headers') Object.defineProperty(options.headers, 'x-second', { set() { throw Error('setter'); }, enumerable: true });
    if (mode === 'absent-options') options = undefined;
    if (mode === 'null-options') options = null;
    let promise;
    try { promise = Reflect.apply(f.window.fetch, f.receiver, [input, options, 'ignored-third']); }
    catch (error) { failure = error; synchronous = true; }
    if (!failure) {
      let done = false; const tracked = Promise.resolve(promise).then(result => { done = true; return result; }, error => { done = true; throw error; });
      if (mode === 'complete-pending') { await flush(); pending = !done; f.release(); }
      try { const result = await tracked; value = { sameResponse: result === f.response, input, options, response: result }; } catch (error) { failure = error; }
    }
  } else {
    const xhr = new f.Xhr();
    const callback = function(...args) { f.calls.push(['callback', args, this === xhr]); return 'callback-result'; };
    if (mode === 'xhr-ready-change' || mode === 'xhr-state3') xhr.onreadystatechange = callback;
    else if (mode !== 'xhr-no-callback') xhr.onloadend = callback;
    if (mode === 'xhr-no-response-reader') xhr.getAllResponseHeaders = undefined;
    try {
      const openArgs = ['POST', '../xhr'];
      if (mode === 'xhr-sync' || mode === 'xhr-explicit-undefined') openArgs.push(mode === 'xhr-sync' ? false : undefined);
      const openReturn = Reflect.apply(xhr.open, xhr, openArgs);
      const sendReturn = Reflect.apply(xhr.send, xhr, ['body', 'second-arg']);
      const sentBefore = f.sent(); await flush();
      if (mode === 'xhr-prepare-pending') { pending = f.sent() === 0; f.release(); for (let i = 0; i < 3; i++) await flush(); }
      hooks.config = { changed: true }; xhr.readyState = mode === 'xhr-state3' ? 3 : 4;
      const handler = typeof xhr.onloadend === 'function' ? xhr.onloadend : xhr.onreadystatechange;
      let callbackResult;
      if (handler) {
        const task = Reflect.apply(handler, { wrongReceiver: true }, ['event']);
        if (mode === 'xhr-complete-pending') { await flush(); pending = !f.calls.some(row => row[0] === 'callback'); f.release(); }
        callbackResult = await task;
        if (mode === 'xhr-repeat') await Reflect.apply(handler, null, ['again']);
      }
      value = { openReturn, sendReturn, sentBefore, callbackResult, sent: f.sent(), pending };
    } catch (error) { failure = error; }
  }
  return compact({ value, failure, synchronous, pending, calls: f.calls });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-transport.js')).href);
  const fetchModes = ['plain', 'request', 'headers-instance', 'headers-array', 'frozen-init', 'frozen-headers', 'partial-headers', 'absent-options', 'null-options', 'unmatched',
    'classify-throw', 'prepare-throw', 'prepare-undefined', 'prepare-reject', 'prepare-null', 'complete-throw', 'complete-undefined', 'complete-reject', 'complete-pending',
    'native-throw', 'native-reject', 'get-only', 'no-reader', 'no-response-headers', 'response-forEach-throw', 'fetch-added-late'];
  const xhrModes = ['xhr-loadend', 'xhr-ready-change', 'xhr-state3', 'xhr-no-callback', 'xhr-no-response-reader', 'xhr-response-throw', 'xhr-sync', 'xhr-explicit-undefined',
    'xhr-repeat', 'xhr-prepare-pending', 'xhr-complete-pending', 'xhr-complete-reject', 'unmatched'];
  for (const [transport, modes] of [['fetch', fetchModes], ['xhr', xhrModes]]) {
    for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode, transport), await scenario('raw', sdk, mode, transport), `${transport}: ${mode}`);
    console.log(`PASS ${modes.length} raw ${transport} hook / SDK traces (synthetic transport and pipeline)`);
  }
  const context = vm.createContext({ window: {}, XMLHttpRequest: function() {}, dt: function() {} }); vm.runInContext(raw, context);
  const inputs = ['', null, 'NoColon\n: empty\nA: b:c\n', 'X: one\nX: two\nContent-Type: a\nContent-Type: b\nset-cookie: a=b\nset-cookie: c=d', 'constructor: x\n__proto__: y'];
  for (const input of inputs) assert.deepStrictEqual(compact(sdk.parseDesktopWebSecureResponseHeaders(input)), compact(context.parse(input)));
  console.log(`PASS ${inputs.length} raw Gn / SDK header parsing vectors`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
