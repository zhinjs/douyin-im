const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Provide the audited C860 path');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const code = 'var ' + source.slice(65953, source.indexOf(',Le=function', 65953)) + ';' + source.slice(68721, 68981) +
  ';' + source.slice(source.indexOf('var or=function(t,e,r,n)'), source.indexOf(',ar=function', 85060)) +
  ';var ' + source.slice(87955, 88234) + ';' + source.slice(91242, 92715) + ';globalThis.get=_r;';
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function track(promise) { const result = { status: 'pending' }; void promise.then(value => Object.assign(result, { status: 'fulfilled', value }), error => Object.assign(result, { status: 'rejected', name: error.name, ...(['TypeError', 'SyntaxError'].includes(error.name) ? {} : { message: error.message }) })); return result; }
function fixture(mode) {
  let stored = null, now = 100_000_000;
  const calls = [], timers = [], requests = [];
  if (mode === 'fresh') stored = JSON.stringify({ cert: 'cached', sn: 'old', createdTime: now });
  if (mode === 'incomplete') stored = JSON.stringify({ createdTime: now });
  if (mode === 'string-date') stored = JSON.stringify({ cert: 'cached', sn: 'old', createdTime: '1' });
  if (mode === 'expired') stored = JSON.stringify({ cert: 'cached', sn: 'old', createdTime: 13_600_000 });
  if (mode === 'bad-cache' || mode === 'bypass') stored = '{';
  if (mode === 'null-cache') stored = 'null';
  class Xhr {
    readyState = 0; status = 0; response = ''; onreadystatechange = null;
    constructor() { requests.push(this); }
    open(...args) { calls.push(['open', ...args]); if (mode === 'open-error') throw Error('open'); }
    setRequestHeader(...args) { calls.push(['header', ...args]); }
    send(...args) { calls.push(['send', ...args]); if (mode === 'send-error') throw Error('send'); }
  }
  const context = { XMLHttpRequest: Xhr, window: { XMLHttpRequest: mode !== 'no-xhr', FormData: mode !== 'no-form' },
    Date: { now: () => now }, localStorage: {
      getItem(key) { calls.push(['get', key]); if (mode === 'get-error') throw Error('read'); return stored; },
      setItem(key, value) { calls.push(['set', key, value]); if (mode === 'set-error') throw Error('write'); stored = value; },
    }, setTimeout(callback, delay) { calls.push(['timer', delay]); timers.push(callback); },
  };
  const respond = (index, body, status = 200, readyState = 4) => { const xhr = requests[index]; xhr.readyState = readyState; xhr.status = status; xhr.response = body; xhr.onreadystatechange?.(); };
  return { context, calls, timers, requests, respond, setNow(value) { now = value; } };
}
async function scenario(kind, sdk, mode) {
  const f = fixture(mode); let get;
  if (kind === 'raw') { const context = vm.createContext({ ...f.context, Promise }); vm.runInContext(code, context); get = context.get; }
  else get = new sdk.DesktopWebSecureServerCertificates(f.context).get;
  const first = get(1128, mode !== 'bypass'), tracked = track(first), second = get(6383, false), identity = first === second;
  const states = []; await flush(); states.push(structuredClone(tracked));
  const success = JSON.stringify({ message: 'success', data: { server_cert: 'CERT', server_sn: 'SN' } });
  if (mode === 'late') {
    f.timers[0](); await flush(); states.push(structuredClone(tracked));
    const next = track(get(6383)); f.respond(0, success); await flush(); states.push(structuredClone(next));
    f.respond(1, success); await flush(); states.push(next);
  } else if (f.requests.length && !['open-error', 'send-error'].includes(mode)) {
    const status = mode === 'http500' ? 500 : mode === 'nan-status' ? NaN : mode === 'http299' ? 299 : 200;
    const response = mode === 'bad-json' ? '{' : mode === 'null-response' ? 'null' : mode === 'null-data' ? '{"message":"success","data":null}' :
      mode === 'empty' ? '{"message":"success"}' : mode === 'business-error' ? '{"message":"fail","data":{"description":"denied"}}' : success;
    f.setNow(100_000_021); f.respond(0, response, status, mode === 'not-ready' ? 3 : 4); await flush(); states.push(structuredClone(tracked));
    if (tracked.status === 'pending') { f.timers[0](); await flush(); }
  }
  states.push(structuredClone(tracked));
  if (mode === 'success') { const next = track(get(999)); await flush(); states.push(next); }
  for (const timer of f.timers) timer(); await flush();
  return structuredClone({ calls: f.calls, states, identity });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-server-certificate.js')).href);
  const modes = ['success', 'fresh', 'incomplete', 'string-date', 'expired', 'bad-cache', 'null-cache', 'bypass', 'get-error', 'set-error',
    'no-xhr', 'no-form', 'open-error', 'send-error', 'late', 'http500', 'nan-status', 'http299', 'not-ready', 'bad-json', 'null-response', 'null-data', 'empty', 'business-error'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', {}, mode), mode);
  console.log(`PASS ${modes.length} raw wr/_r/hr/Je / SDK server-certificate traces (synthetic XHR/storage only)`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
