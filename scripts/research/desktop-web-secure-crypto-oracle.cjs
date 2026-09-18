// Installed source functions + actual WebCrypto, synthetic keys only; no account/network/storage access.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, webcrypto, sign, verify, diffieHellman, hkdfSync } = require('node:crypto');
if (!process.argv[2]) throw Error('Provide the audited C860 path');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
let factories;
const environment = { global: { webpackChunkawemeim: { push(data) { factories = data[1]; } } }, window: { crypto: webcrypto, atob, btoa }, crypto: webcrypto,
  TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Promise, atob, btoa, navigator: { appName: 'Netscape' } };
vm.runInNewContext(source, environment);
const cache = {};
function requireRaw(id) {
  if (cache[id]) return cache[id].exports;
  const module = { exports: {} }; cache[id] = module;
  if (!factories[id]) throw Error(`Missing raw dependency ${id}`);
  factories[id](module, module.exports, requireRaw); return module.exports;
}
requireRaw.d = (exports, values) => { for (const [name, get] of Object.entries(values)) Object.defineProperty(exports, name, { get }); };
const context = vm.createContext({ ...environment, requireRaw });
const start = source.indexOf('b=function(t,e){var r="function"'), end = source.indexOf(',q=function');
assert(start > 0 && end > start);
vm.runInContext('var v=requireRaw(76868),g=()=>requireRaw(76984),m=requireRaw(2745);var ' + source.slice(start, end) + ';globalThis.Provider=J;globalThis.der=T;', context);
function pair() { return generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }); }
function seq(...parts) { const content = Buffer.concat(parts); return Buffer.concat([Buffer.from(content.length < 128 ? [48, content.length] : [48, 129, content.length]), content]); }
function certificate(publicKey) {
  const spki = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return '-----BEGIN CERTIFICATE-----\n' + seq(seq(...Array.from({ length: 6 }, () => Buffer.from([5, 0])), spki)).toString('base64') + '\n-----END CERTIFICATE-----';
}
const normalize = value => JSON.parse(JSON.stringify(value));
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-crypto.js')).href);
  const native = new context.Provider(), local = new sdk.DesktopWebSecureSystemCrypto(webcrypto.subtle);
  for (let seed = 0; seed < 64; seed++) {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i < seed ? 0 : (seed * 137 + i * 67) & 255);
    assert.deepEqual(Buffer.from(sdk.desktopWebSecureSignatureDer(bytes.buffer)), Buffer.from(context.der(bytes.buffer)));
  }
  let scenarios = 0;
  for (const keys of [pair(), pair()]) {
    for (const name of ['extractPrivateKeyHexFromPem', 'extractPublicKeyFromPrivateKey', 'extractPublicKeyHexFromPem']) {
      const input = name === 'extractPublicKeyHexFromPem' ? keys.publicKey : keys.privateKey;
      const actual = await local[name](input), expected = await native[name](input);
      assert.deepEqual(normalize(actual), normalize(expected), name);
      if (actual.buffer) assert.deepEqual(Buffer.from(actual.buffer), Buffer.from(expected.buffer));
      scenarios++;
    }
    for (const text of ['', 'synthetic', '关注 🔐', '\u0000\ud800']) {
      const raw = sign('sha256', Buffer.from(text), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
      for (const api of [native, local]) {
        const der = await api.signWithECDSA(keys.privateKey, text);
        assert.equal(der.hex, Buffer.from(der.buffer).toString('hex'));
        assert(verify('sha256', Buffer.from(text), keys.publicKey, Buffer.from(der.buffer)));
        assert.equal(await api.verifyWithECDSA(keys.publicKey, raw, text), true);
        assert.equal(await api.verifyWithECDSA(keys.publicKey, raw, text + '!'), false);
        assert.equal(await api.verifyWithECDSA(keys.publicKey, new Uint8Array(der.buffer), text), false);
      }
      scenarios++;
    }
    const server = pair(), pem = certificate(server.publicKey);
    assert.deepEqual(Buffer.from(await local.extractPublicKeyFromX509Cert(pem)), Buffer.from(await native.extractPublicKeyFromX509Cert(pem))); scenarios++;
    const derived = await local.deriveEcdhKey(keys.privateKey, pem), expected = await native.deriveEcdhKey(keys.privateKey, pem);
    assert.equal(derived.hex, expected.hex); assert.deepEqual(Buffer.from(derived.bytes), Buffer.from(expected.bytes));
    const shared = diffieHellman({ privateKey: createPrivateKey(keys.privateKey), publicKey: createPublicKey(server.publicKey) });
    assert.deepEqual(Buffer.from(derived.bytes), Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32))); scenarios++;
  }
  for (const [api, other] of [[native, local], [local, native]]) {
    const keys = await api.generateNewKeyPairPEM();
    assert.equal(keys.privatePem.split('\n').length, 3); assert.equal(keys.publicPem.split('\n').length, 3);
    const derived = await other.extractPublicKeyFromPrivateKey(keys.privatePem), exported = await other.extractPublicKeyHexFromPem(keys.publicPem);
    assert.equal(derived.rawHex, exported.rawHex);
    const signed = await other.signWithECDSA(keys.privatePem, 'cross-provider');
    assert(verify('sha256', Buffer.from('cross-provider'), keys.publicPem, Buffer.from(signed.buffer))); scenarios++;
  }
  console.log(`PASS ${scenarios} raw J / SDK real-crypto scenarios + 64 raw T DER vectors (synthetic keys, no certificate trust or live follow claim)`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
