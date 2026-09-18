// Raw installed bundle, synthetic inputs only. No network, account, or browser storage access.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash, createHmac } = require('node:crypto');
const vm = require('node:vm');
if (!process.argv[2]) throw Error('Provide the audited C860 path');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
let factories;
const environment = { global: { webpackChunkawemeim: { push(data) { factories = data[1]; } } }, window: { atob, btoa },
  TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Promise, atob, btoa };
vm.runInNewContext(source, environment);
const cache = {};
function requireRaw(id) {
  if (cache[id]) return cache[id].exports;
  const module = { exports: {} }; cache[id] = module;
  if (!factories[id]) throw Error(`Missing raw dependency ${id}`);
  factories[id](module, module.exports, requireRaw); return module.exports;
}
requireRaw.d = (exports, values) => { for (const [name, get] of Object.entries(values)) Object.defineProperty(exports, name, { get }); };
const raw = requireRaw(71312).sha256.hmac, encoding = requireRaw(76868);
// Independent transliteration of the bundle's UTF-16 loop, not standard UTF-8 replacement.
function sourceStringBytes(text) {
  const result = [];
  for (let index = 0; index < text.length; index++) {
    let unit = text.charCodeAt(index);
    if (unit < 128) result.push(unit);
    else if (unit < 2048) result.push(192 | unit >>> 6, 128 | unit & 63);
    else if (unit < 55296 || unit >= 57344) result.push(224 | unit >>> 12, 128 | unit >>> 6 & 63, 128 | unit & 63);
    else {
      unit = 65536 + ((unit & 1023) << 10 | text.charCodeAt(++index) & 1023);
      result.push(240 | unit >>> 18, 128 | unit >>> 12 & 63, 128 | unit >>> 6 & 63, 128 | unit & 63);
    }
  }
  return Buffer.from(result);
}
const native = (key, message) => createHmac('sha256', key).update(message).digest('hex');
let hmacVectors = 0, encodingVectors = 0, wrapperVectors = 0;
const valid = ['', 'key', '关注 🔐', '\u0000\uffff', 'a'.repeat(65), '😀'.repeat(33)];
for (const key of valid) for (const message of valid) {
  assert.equal(raw(key, message), native(key, message)); hmacVectors++;
}
const invalid = ['\ud800', '\udc00', '\ud800A', '\udc00A', '\ud800\ud800', '\udc00\ud800', 'x'.repeat(63) + '\ud800A'];
for (const text of invalid) {
  const legacy = sourceStringBytes(text), standard = Buffer.from(text);
  assert.notDeepEqual(legacy, standard);
  assert.equal(raw('key', text), native('key', legacy));
  assert.notEqual(raw('key', text), native('key', standard));
  assert.equal(raw(text, 'message'), native(legacy, 'message'));
  assert.notEqual(raw(text, 'message'), native(standard, 'message'));
  hmacVectors += 2;
  assert.equal(encoding.JR(text), standard.toString('base64')); encodingVectors++;
}
const bytes = Uint8Array.from([0, 255, 128, 65, 0]);
for (const key of [bytes, bytes.subarray(1, 4), bytes.buffer, [], new Uint8Array(0)]) {
  for (const message of [bytes, bytes.subarray(1, 4), bytes.buffer, []]) {
    const nodeKey = key instanceof ArrayBuffer ? Buffer.from(key) : Buffer.from(key);
    const nodeMessage = message instanceof ArrayBuffer ? Buffer.from(message) : Buffer.from(message);
    assert.equal(raw(key, message), native(nodeKey, nodeMessage)); hmacVectors++;
  }
}
for (const value of [undefined, null, 0, true, {}]) {
  assert.throws(() => raw(value, ''), /input is invalid type/);
  assert.throws(() => raw('', value), /input is invalid type/); hmacVectors += 2;
}
// ArrayBuffer.isView admits DataView but the algorithm uses .length and numeric indexes.
const view = new DataView(bytes.buffer);
assert.equal(raw(view, ''), raw('', ''));
assert.equal(raw('', view), raw('', '')); hmacVectors += 2;
for (const text of ['', '关注 🔐', '\u0000A', '\ufeffA']) {
  assert.equal(encoding.JR(text), Buffer.from(text).toString('base64'));
  assert.equal(encoding.Zj(encoding.JR(text)), text.startsWith('\ufeff') ? text.slice(1) : text); encodingVectors++;
}
assert.equal(encoding.Zj('/w=='), '\ufffd'); encodingVectors++;
assert.equal(encoding.Zj('YQ'), 'a'); encodingVectors++;
assert.equal(encoding.Zj(' Y Q ==\n'), 'a'); encodingVectors++;
for (const text of ['a', '-w==', '_w==', '???']) { assert.throws(() => encoding.Zj(text)); encodingVectors++; }
assert.equal(encoding.JR(undefined), '');
assert.equal(encoding.JR(null), Buffer.from('null').toString('base64'));
assert.equal(encoding.JR(123), Buffer.from('123').toString('base64')); encodingVectors += 3;
async function main() {
  const { pathToFileURL } = require('node:url'), { resolve } = require('node:path'), { webcrypto } = require('node:crypto');
  const { DesktopWebSecureSystemCrypto } = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-crypto.js')).href);
  const system = new DesktopWebSecureSystemCrypto(webcrypto.subtle); let sdkVectors = 0;
  for (const key of [new Uint8Array(), bytes, bytes.subarray(1, 4), new Uint8Array(65).fill(9)]) {
    for (const message of [...valid, ...invalid]) {
      assert.equal(await system.hmacSha256(key, message), Buffer.from(raw(key, message), 'hex').toString('base64')); sdkVectors++;
    }
  }
  const trace = [];
  const context = vm.createContext({ ...environment, r: requireRaw, Je: fn => fn, Q: () => Promise.resolve({ publicPem: 'synthetic-public', privatePem: 'synthetic-private' }),
    v: { LE(hex) { trace.push('base64'); return encoding.LE(hex); } }, Date: { now() { trace.push('now'); return trace.length; } } });
  vm.runInContext('var ' + source.slice(source.indexOf('Ye=r(71312)'), source.indexOf('const nr=')).replace(/;\s*$/, '') + ';globalThis.RawKeys=rr;globalThis.originalEr=er;er=(key,message)=>{globalThis.trace.push("hmac");return originalEr(key,message)};', context);
  context.trace = trace;
  const keys = new context.RawKeys({ privateKey: 'synthetic-private', publicKey: 'synthetic-public' });
  let resolvePipeline;
  keys.pipeline = new Promise(resolve => { resolvePipeline = resolve; });
  const pending = keys.signWithHmac('message', new Uint8Array(0));
  assert.deepEqual(trace, []);
  resolvePipeline();
  const result = await pending;
  assert.equal(result.result, Buffer.from(raw('', 'message'), 'hex').toString('base64'));
  assert.deepEqual(trace, ['now', 'now', 'hmac', 'base64', 'now']);
  assert.equal(result.times.hmacTime, 3); wrapperVectors++;
  trace.length = 0;
  keys._private_key = '';
  keys.pipeline = new Promise(() => {});
  await assert.rejects(keys.signWithHmac('message', bytes), /private key is empty/);
  assert.deepEqual(trace, []); wrapperVectors++;
  keys._private_key = 'synthetic-private';
  keys.pipeline = Promise.reject(Error('pipeline synthetic failure'));
  await assert.rejects(keys.signWithHmac('message', bytes), /pipeline synthetic failure/);
  assert.deepEqual(trace, []); wrapperVectors++;
  console.log(`PASS ${hmacVectors} raw HMAC vectors, ${encodingVectors} raw JR/Zj encoding vectors, ${wrapperVectors} raw rr ordering cases; synthetic only`);
  console.log(`PASS ${sdkVectors} raw HMAC / built system-crypto differential vectors`);
  console.log('Lone U+D800: bundle bytes=' + sourceStringBytes('\ud800').toString('hex') + ', TextEncoder bytes=' + Buffer.from('\ud800').toString('hex'));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
