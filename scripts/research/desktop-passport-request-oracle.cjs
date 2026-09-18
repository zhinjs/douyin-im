// Fixed installed-source request functions. Synthetic values and in-memory XHR only.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash, createHmac, hkdfSync } = require('node:crypto');
const vm = require('node:vm');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/desktop-passport-request-oracle.cjs /path/to/92.js');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),
  'e09879e27fb28e3a53b962a048cc51318295b6f067f1fec6a395bde2be661889', 'Re-audit changed source first');
const modules = {};
const requests = [];
let cookie = 'passport_csrf_token=offline-primary; passport_csrf_token_default=offline-default';
class OfflineXHR {
  constructor() { this.onloadend = null; this.headers = {}; this.status = 200; this.statusText = 'OK'; this.responseText = '{}'; }
  open(method, url, async) { Object.assign(this, { method, url, async }); }
  setRequestHeader(key, value) { this.headers[key] = value; }
  getAllResponseHeaders() { return ''; }
  send(body) { this.body = body; requests.push(this); queueMicrotask(() => this.onloadend()); }
}
const location = { href: 'https://offline.invalid/page', hostname: 'offline.invalid', protocol: 'https:' };
const document = {
  location,
  get cookie() { return cookie; },
  set cookie(value) { cookie = value; },
  createElement(tag) {
    assert.equal(tag, 'a', 'Only Axios URL parsing may access the synthetic DOM');
    return { setAttribute(key, value) {
      assert.equal(key, 'href'); const url = new URL(value, location.href);
      for (const key of ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) this[key] = url[key];
    } };
  },
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
sha256.hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex');
const fixedDate = new Date('2026-09-12T01:23:45Z');
class OfflineDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedDate.getTime()])); }
  static now() { return fixedDate.getTime(); }
}
const context = vm.createContext({
  global: { webpackChunkawemeim: { push(chunk) { Object.assign(modules, chunk[1]); } } },
  document, navigator: { userAgent: 'Offline fixture' }, window: { location }, location,
  XMLHttpRequest: OfflineXHR, URLSearchParams, TextEncoder, Date: OfflineDate,
  Math: Object.assign(Object.create(Math), { random: () => 0 }),
  r: { sha256 }, i: () => undefined,
});
// Bundle evaluation only registers module factories: never instantiate AccountSDK, ttwid or BDMS.
vm.runInContext(source, context, { timeout: 1000 });
const loaded = {};
function load(id) {
  assert(Object.hasOwn(modules, id), `Unexpected external dependency ${id}`);
  if (loaded[id]) return loaded[id].exports;
  const module = { exports: {} }; loaded[id] = module;
  modules[id](module, module.exports, load);
  return module.exports;
}
const buildURL = load(83270);
const xhrAdapter = load(64452);
function span(startText, endText, from = 113951) {
  const start = source.indexOf(startText, from);
  const end = source.indexOf(endText, start);
  assert(start >= from && end > start, `Missing source boundaries: ${startText}`);
  return source.slice(start, end);
}
vm.runInContext([
  span('function o(t)', 'function i(t,e,n)'),
  span('var a=function', ',l=function') + ';',
  span('var _l=function', ',wl=function', 227000) + ';',
  'var ' + span('El=function', ',Sl=function', 230000) + ';',
  'var ' + span('Sl=function', ',Il=function', 231900) + ';',
  span('var ql=function', 'var Fl=function', 240000),
  span('var Fl=function', ',zl=function', 241000) + ';',
  'globalThis.oracle={sign:s,prepare:El,derive:Gl,aidSign:Vl,Trace:Tl,trace:Cl};',
].join('\n'), context, { timeout: 1000 });
const oracle = context.oracle;
let passed = 0;
function pass(label) { passed++; console.log('PASS', label); }
function xor5(value) { return [...Buffer.from(value)].map(byte => (byte ^ 5).toString(16)).join(''); }
function expectedSign(query, body, key) {
  const selected = Object.keys(query).sort().slice(0, 10);
  const join = (obj, keys) => keys.map(key => `${key}=${typeof obj[key] === 'object' ? JSON.stringify(obj[key]) : obj[key]}`).join('&');
  return { sign: sha256(`${join(query, selected)}&${join(body, Object.keys(body).sort())}&app_key=${key}`), qs: xor5(selected.join(',')) };
}
(async () => {
  const savedCookie = cookie;
  const trace = new oracle.Trace({ autoTrace: true });
  const traceId = trace.traceID;
  const appendTrace = oracle.trace(trace);
  const tracedA = appendTrace({ params: {}, headers: {} });
  fixedDate.setTime(fixedDate.getTime() + 1000);
  const tracedB = appendTrace({ params: { biz_trace_id: 'caller' }, headers: { 'x-tt-passport-trace-id': 'caller' } });
  assert.equal(tracedA.params.biz_trace_id, traceId);
  assert.equal(tracedB.params.biz_trace_id, traceId);
  assert.equal(tracedB.headers['x-tt-passport-trace-id'], traceId);
  assert.notEqual(new oracle.Trace({ autoTrace: true }).traceID, traceId);
  trace.stop(); const stopped = appendTrace({ params: {}, headers: {} });
  assert.equal(stopped.params.biz_trace_id, undefined);
  trace.start(); assert.equal(appendTrace({ params: {}, headers: {} }).params.biz_trace_id, traceId);
  console.log('Synthetic original trace vector:', traceId);
  pass('trace belongs to the instance, overrides caller fields, and survives stop/start');
  fixedDate.setTime(0); context.performance = { now: () => 1 };
  assert.equal(new oracle.Trace({ autoTrace: true }).traceID, '8e300000');
  delete context.performance;
  pass('original trace falls back to performance.now when the wall clock is not positive');
  fixedDate.setTime(Date.parse('2026-09-12T01:23:45Z')); cookie = savedCookie;
  assert.equal(buildURL('/fixture', { text: 'a b:c$,[]+&=/?#', request_host: 'https%3A%2F%2Foffline.invalid' }),
    '/fixture?text=a+b:c$,[]%2B%26%3D%2F%3F%23&request_host=https%253A%252F%252Foffline.invalid');
  pass('actual Axios encoding and pre-encoded request_host');
  assert.equal(buildURL('/fixture?old=1#fragment', { z: 3, a: 1, middle: 2 }), '/fixture?old=1&z=3&a=1&middle=2');
  pass('query insertion order, old query, and fragment removal');
  assert.equal(buildURL('/fixture', { missing: undefined, nil: null, list: ['a b', 0], object: { x: 1 } }),
    '/fixture?list[]=a+b&list[]=0&object=%7B%22x%22:1%7D');
  pass('actual Axios null/undefined, array and JSON query handling');
  assert.deepEqual(JSON.parse(JSON.stringify(oracle.sign({ b: 'space +', a: { x: 1 } }, { z: false, a: 'x&y' }, 'offline-key'))),
    expectedSign({ b: 'space +', a: { x: 1 } }, { z: false, a: 'x&y' }, 'offline-key'));
  pass('original SHA256 sign/qs function and unescaped canonical input');
  const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${String(11 - i).padStart(2, '0')}`, i]));
  assert.equal(oracle.sign(twelve, {}, 'offline-key').qs, xor5(Object.keys(twelve).sort().slice(0, 10).join(',')));
  assert.equal(oracle.sign(twelve, {}, 'offline-key').sign, expectedSign(twelve, {}, 'offline-key').sign);
  pass('sign limits query to lexicographically first ten keys');
  assert.equal(Object.keys(oracle.sign({ a: 1 }, {}, '')).length, 0);
  pass('empty appKey does not produce sign/qs');
  const prepared = await oracle.prepare({ method: 'get', url: '/fixture', params: { b: 2, a: 1 }, headers: {} }, { appKey: 'offline-key' });
  assert.equal(prepared.data, undefined);
  assert.equal(prepared.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(prepared.headers.Accept, 'application/json, text/javascript');
  assert.equal(prepared.headers['x-tt-passport-csrf-token'], 'offline-primary');
  assert.equal(prepared.params.sign, expectedSign({ b: 2, a: 1 }, {}, 'offline-key').sign);
  pass('raw El GET preserves absent body and prepares Passport headers/sign');
  await xhrAdapter({ ...prepared, baseURL: 'https://offline.invalid', withCredentials: true, timeout: 0,
    xsrfCookieName: 'passport_csrf_token', xsrfHeaderName: 'x-tt-passport-csrf-token' });
  const sent = requests.at(-1);
  assert.equal(sent.method, 'GET'); assert.equal(sent.body, null); assert.equal(sent.withCredentials, true);
  assert.equal(sent.timeout, 0); assert.equal(sent.headers['Content-Type'], undefined);
  assert.equal(sent.headers.Accept, 'application/json, text/javascript');
  assert(sent.url.startsWith('https://offline.invalid/fixture?b=2&a=1&sign='));
  pass('original XHR adapter removes GET undefined-body Content-Type and sends null');
  cookie = 'passport_csrf_token_default=offline-fallback';
  const fallback = await oracle.prepare({ method: 'GET', url: '/fixture', params: {}, headers: {} }, {});
  assert.equal(fallback.headers['x-tt-passport-csrf-token'], 'offline-fallback');
  cookie = '';
  const empty = await oracle.prepare({ method: 'GET', url: '/fixture', params: {}, headers: {} }, {});
  assert.equal(empty.headers['x-tt-passport-csrf-token'], '');
  pass('raw El primary, fallback and empty CSRF semantics');
  const merged = await oracle.prepare({ method: 'GET', url: '/fixture', data: { a: 'body', c: undefined, z: 3 }, params: { a: 'query' }, headers: {} }, { appKey: 'offline-key' });
  assert.equal(merged.params.a, 'query'); assert.equal(merged.params.c, undefined);
  assert.equal(merged.params.sign, expectedSign({ a: 'query', z: 3 }, {}, 'offline-key').sign);
  pass('raw El GET query beats data after undefined-body-field filtering');
  const post = await oracle.prepare({ method: 'post', url: '/fixture', data: { a: 'a b', absent: undefined, object: { x: 1 } }, params: { z: 3 }, headers: {} }, { appKey: 'offline-key' });
  assert.equal(post.data, 'a=a%20b&object=%7B%22x%22%3A1%7D');
  assert.equal(post.params.sign, expectedSign({ z: 3 }, { a: 'a b', object: { x: 1 } }, 'offline-key').sign);
  pass('raw El POST filters undefined, signs raw values, then form-encodes');
  const retry = await oracle.prepare({ method: 'get', url: '/fixture', params: { isResend: true, sign: 'prior', qs: 'prior' }, headers: {} }, { appKey: 'offline-key' });
  assert.equal(retry.params.isResend, undefined); assert.equal(retry.params.sign, 'prior');
  pass('isResend removes only marker and does not recompute sign');
  const salt = Buffer.from('1789214400'); const ikm = Buffer.from('offline-app-key');
  const derived = Buffer.from(oracle.derive(salt, ikm, new Uint8Array(), 32));
  assert.equal(derived.toString('hex'), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.alloc(0), 32)).toString('hex'));
  const prk = createHmac('sha256', salt).update(ikm).digest();
  assert.equal(derived.toString('hex'), createHmac('sha256', prk).update(Buffer.from([1])).digest('hex'));
  assert.notEqual(derived.toString('hex'), createHmac('sha256', prk).update(Buffer.concat([prk, Buffer.from([1])])).digest('hex'));
  pass('original Gl is standard HKDF: first expansion input is 0x01, not PRK || 0x01');
  const aidSigned = await oracle.aidSign({ aid: 339757, appKey: 'offline-app-key', host: 'https://offline.invalid' })({ url: '/passport/token/beat/web/?unused=1', params: {} });
  const ts = String(Date.UTC(2026, 8, 12, 12) / 1000);
  const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(ts), Buffer.alloc(0), 32));
  assert.equal(aidSigned.params.ts, ts);
  assert.equal(aidSigned.headers['x-tt-passport-aid-sign'], createHmac('sha256', key).update(`aid=339757&path=/passport/token/beat/web/&ts=${ts}`).digest('hex'));
  pass('raw Vl aid-sign uses UTC noon and strips query from path');
  const override = await oracle.aidSign({ aid: 339757, appKey: 'offline-app-key', host: 'https://offline.invalid' })({ url: '/passport/token/beat/web/', params: { ts: 'manual' } });
  assert.equal(override.params.ts, 'manual');
  assert.equal(override.headers['x-tt-passport-aid-sign'], aidSigned.headers['x-tt-passport-aid-sign']);
  pass('existing query ts overrides generated ts without changing header input');
  fixedDate.setTime(Date.parse('2026-09-12T23:59:59Z'));
  const signReplay = oracle.aidSign({ aid: 339757, appKey: 'offline-app-key', host: 'https://offline.invalid' });
  const beforeMidnight = await oracle.prepare(await signReplay({
    method: 'post', url: '/passport/web/user/login/', params: { biz_trace_id: 'fixture-trace' }, data: { account: 'fixture' },
  }), { appKey: 'offline-key' });
  const originalHeader = beforeMidnight.headers['x-tt-passport-aid-sign'];
  fixedDate.setTime(Date.parse('2026-09-13T00:00:01Z'));
  const afterMidnight = await oracle.prepare(await signReplay({
    ...beforeMidnight, headers: { ...beforeMidnight.headers },
    params: { ...beforeMidnight.params, isResend: true, fp: 'fixture-fp', verifyFp: 'fixture-fp' },
  }), { appKey: 'offline-key' });
  for (const name of ['ts', 'sign', 'qs', 'biz_trace_id']) assert.equal(afterMidnight.params[name], beforeMidnight.params[name]);
  assert.equal(afterMidnight.params.isResend, undefined);
  assert.equal(afterMidnight.data, beforeMidnight.data);
  assert.notEqual(afterMidnight.headers['x-tt-passport-aid-sign'], originalHeader);
  const nextTs = String(Date.UTC(2026, 8, 13, 12) / 1000);
  const nextKey = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(nextTs), Buffer.alloc(0), 32));
  assert.equal(afterMidnight.headers['x-tt-passport-aid-sign'], createHmac('sha256', nextKey)
    .update(`aid=339757&path=/passport/web/user/login/&ts=${nextTs}`).digest('hex'));
  pass('original aid-sign + El cross-day replay keeps original query/body but regenerates the header');
  fixedDate.setTime(Date.parse('2026-09-11T01:23:45Z'));
  const publicAppKey = '3c452fb664e3de0e936108429a0bc697';
  const qrKey = Buffer.from(hkdfSync('sha256', Buffer.from(publicAppKey), Buffer.from('1789128000'), Buffer.alloc(0), 32));
  for (const [path, expected] of [
    ['/passport/web/get_qrcode/', 'deeba488ad62369e0767c683ae27a63f201974a15726636c06df583936525394'],
    ['/passport/token/beat/web/', '4293b9850fe3633a1a62fddfa438a739738edbd0ff26144e0e38b3a924ff3101'],
    ['/passport/account/info/v2/', 'f36f98d9fc409db70391c98f4b31e19ea39f934a45666ece038aa1cc4571e04a'],
  ]) {
    const signed = await oracle.aidSign({ aid: 339757, appKey: publicAppKey, host: 'https://imdesktop.douyin.com' })({ url: path, params: {} });
    assert.equal(signed.params.ts, '1789128000');
    assert.equal(signed.headers['x-tt-passport-aid-sign'], expected);
    assert.equal(signed.headers['x-tt-passport-aid-sign'], createHmac('sha256', qrKey).update(`aid=339757&path=${path}&ts=1789128000`).digest('hex'));
    console.log('Public appKey aid-sign:', path, signed.headers['x-tt-passport-aid-sign']);
  }
  pass('installed public appKey three-path vectors at ts 1789128000');
  console.log(`${passed} request assertions passed; no network, SDK constructor, or account state accessed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
