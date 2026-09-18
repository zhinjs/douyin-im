// Original ln/fn with actual synthetic XHR and cache, versus built SDK. No account/network IO.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createHash } = require('node:crypto'), { resolve } = require('node:path'), { pathToFileURL } = require('node:url');
const source = fs.readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const raw = source.slice(source.indexOf('var or=function(t,e,r,n)'), source.indexOf(',lr=function')) + ';var ' + source.slice(87955, 88234) +
  ';var ' + source.slice(89048, source.indexOf(',gr=function', 89048)) + ';var ' + source.slice(146513, source.indexOf(',hn=function', 150737)) + ';globalThis.get=fn;';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const track = promise => { const state = { status: 'pending' }; void promise.then(value => Object.assign(state, { status: 'fulfilled', value }), error => Object.assign(state, { status: 'rejected', name: error.name, ...(['TypeError', 'SyntaxError', 'URIError'].includes(error.name) ? {} : { message: error.message }) })); return state; };
function fixture(mode) {
  let now = 100_000_000, stored = null;
  const calls = [], requests = [], timers = [];
  const cache = value => { stored = btoa(JSON.stringify(value)); };
  if (mode === 'fresh') cache({ createdTime: now, centralRsaPub: 'cached', extra: 0, dataFrom: 'override' });
  if (mode === 'incomplete') cache({ createdTime: now });
  if (mode === 'empty-cache') cache({ createdTime: now, extra: '' });
  if (mode === 'shadow-cache') cache({ createdTime: now, hasOwnProperty: 1 });
  if (mode === 'string-date') cache({ createdTime: '1', centralVersion: 'cached' });
  if (mode === 'expired') cache({ createdTime: 13_600_000 });
  if (mode === 'null-cache') cache(null);
  if (mode === 'bad-cache' || mode === 'bypass') stored = '%';
  class Xhr {
    readyState = 0; status = 0; response = ''; onreadystatechange = null;
    constructor() { if (mode === 'constructor-error') throw Error('constructor'); requests.push(this); }
    open(...args) { calls.push(['open', ...args]); if (mode === 'open-error') throw Error('open'); }
    setRequestHeader(...args) { calls.push(['header', ...args]); }
    send(...args) { calls.push(['send', ...args]); if (mode === 'send-error') throw Error('send'); }
  }
  const context = { XMLHttpRequest: Xhr, window: { XMLHttpRequest: mode !== 'no-xhr', FormData: mode !== 'no-form' },
    document: { cookie: mode === 'bad-cookie' ? 'passport_csrf_token=%ZZ' : mode === 'cookie-first' ? 'passport_csrf_token=first; passport_csrf_token=second' : 'passport_csrf_token_default=synthetic%2Bcsrf' },
    Date: { now: () => now }, atob, btoa: value => { if (mode === 'btoa-error') throw Error('btoa'); return btoa(value); },
    localStorage: {
      getItem(key) { calls.push(['get', key]); if (mode === 'get-error') throw Error('get'); return stored; },
      setItem(key, value) { calls.push(['set', key, value]); if (mode === 'set-error') throw Error('set'); stored = value; },
      removeItem(key) { calls.push(['remove', key]); if (mode === 'remove-error') throw Error('remove'); stored = null; },
    }, setTimeout(callback, delay) { calls.push(['timer', delay]); timers.push(callback); },
  };
  const respond = (i, body, status = 200, readyState = 4) => { const xhr = requests[i]; Object.assign(xhr, { readyState, status, response: body }); xhr.onreadystatechange?.(); };
  return { context, calls, requests, timers, respond, setNow(value) { now = value; } };
}
async function scenario(kind, sdk, mode) {
  const f = fixture(mode); let get;
  if (kind === 'raw') { const context = vm.createContext({ ...f.context, Promise, atob: f.context.atob, decodeURIComponent, encodeURIComponent }); vm.runInContext(raw, context); get = context.get; }
  else get = new sdk.DesktopDTraitParameters(f.context).get;
  const first = get(mode === 'undefined-aid' ? undefined : 6383, mode !== 'bypass'), state = track(first), second = get(1, false), identity = first === second;
  const states = []; await flush(); states.push(structuredClone(state));
  const success = JSON.stringify({ message: 'success', data: { 'x-tt-session-dtrait-pk1': 'central', 'x-tt-session-dtrait-pk1-version': 'c1', 'x-tt-session-dtrait-pk2': 'edge', 'x-tt-session-dtrait-pk2-version': 'e1', 'x-tt-session-dtrait-fe-url-version': '1.0.31', 'x-tt-session-dtrait-version': '0' } });
  if (mode === 'late') {
    f.timers[0](); await flush(); states.push(structuredClone(state)); const next = track(get(1));
    f.respond(0, success); await flush(); states.push(structuredClone(next)); f.respond(1, success); await flush(); states.push(structuredClone(next));
  } else if (f.requests.length && state.status === 'pending') {
    const body = mode === 'bad-json' ? '{' : mode === 'null-response' ? 'null' : mode === 'empty-data' ? '{"message":"success","data":{}}' : mode === 'null-data' ? '{"message":"success","data":null}' : mode === 'missing-data' ? '{"message":"success"}' : mode === 'empty-field' ? '{"message":"success","data":{"extra":""}}' : mode === 'shadow-data' ? '{"message":"success","data":{"hasOwnProperty":1}}' : mode === 'business-error' ? '{"message":"error","data":{"description":"denied"}}' : success;
    f.setNow(100_000_021); f.respond(0, body, mode === 'http500' ? 500 : mode === 'nan-status' ? NaN : mode === 'http299' ? 299 : 200, mode === 'not-ready' ? 3 : 4);
    await flush(); states.push(structuredClone(state)); if (state.status === 'pending') { f.timers[0](); await flush(); }
  }
  states.push(structuredClone(state));
  if (mode === 'success' || mode === 'empty-data') { const next = track(get(999)); await flush(); states.push(structuredClone(next)); }
  // Raw hr leaks its timer when XHR construction throws before race; don't trigger that unrelated unhandled rejection.
  if (mode !== 'constructor-error') for (const timer of f.timers) timer();
  await flush(); return structuredClone({ calls: f.calls, states, identity });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-parameters.js')).href);
  const modes = ['success', 'fresh', 'incomplete', 'empty-cache', 'shadow-cache', 'string-date', 'expired', 'bad-cache', 'null-cache', 'bypass', 'get-error', 'remove-error', 'set-error', 'btoa-error', 'no-xhr', 'no-form', 'constructor-error', 'open-error', 'send-error', 'late', 'http500', 'nan-status', 'http299', 'not-ready', 'bad-json', 'null-response', 'empty-data', 'null-data', 'missing-data', 'empty-field', 'shadow-data', 'business-error', 'bad-cookie', 'cookie-first', 'undefined-aid'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', sdk, mode), mode);
  console.log(`PASS ${modes.length} raw ln/fn / SDK DTrait parameter traces (synthetic XHR/storage only)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
