// Pinned C860 wrappers + actual installed CryptoJS/JSEncrypt chunks. No core/network/account IO.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { createHash, webcrypto, generateKeyPairSync, privateDecrypt, constants } = require('node:crypto');
const { resolve, dirname } = require('node:path'), { pathToFileURL } = require('node:url');
function read(path, sha) { const text = fs.readFileSync(path, 'utf8'); assert.equal(createHash('sha256').update(text).digest('hex'), sha); return text; }
const source = read(process.argv[2], '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const root = resolve(dirname(process.argv[2]), '..');
const chunks = [read(resolve(root, '15/15_a560da5b694c15e2c957.js'), '46c5465c74945c1ca330e9b4f91f331db9346c5a658c7b543391207563ba63aa'), read(resolve(root, '458/458_326598f9093d3f1bb2a4.js'), '545b380a02c78d064f6412571cdd96482d5e6e86807385eb67497c1d47d85d24')];
// Shared CryptoJS modules reside in login. Parse factories only; never run its page/entrypoint.
const login = read(resolve(root, 'login/login_ae39b1e613d53592b6df.js'), '0579ce4fbaa0ecc0206910814ea5c795ffadb9bc6b42376e411b69e3951b2737');
const ts = require('typescript'), ast = ts.createSourceFile('login.js', login, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), shared = {};
function visit(node) { if (ts.isPropertyAssignment(node) && ts.isNumericLiteral(node.name) && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))) shared[node.name.text] = node.initializer.getText(ast); ts.forEachChild(node, visit); }
visit(ast);
const raw = 'var ' + source.slice(152220, 160778) + ';globalThis.AES=En;globalThis.RSA=In;globalThis.util={parseQuery:vn,getQuery:yn,isSupportSystemCrypto:gn,bufferConcat:mn,buff2base64:bn,base642buff:wn,hexToUint8Array:kn,uint8ArrayToHex:_n,unit8ArrayToString:Tn,getRandomValues:Sn};';
function environment(fallback, packaged = false) {
  const crypto = { subtle: webcrypto.subtle, getRandomValues(array) { for (let i = 0; i < array.length; i++) array[i] = i & 255; return array; } };
  const context = vm.createContext({ Uint8Array, ArrayBuffer, Promise, TextEncoder, atob, btoa, crypto, location: { search: fallback ? '?disableSystemCrypto=1' : '' }, navigator: { appName: 'Netscape' }, console });
  context.window = context; context.global = context; context.self = context; context.addEventListener = () => {}; context.removeEventListener = () => {}; context.webpackChunkawemeim = [];
  for (const chunk of chunks) vm.runInContext(chunk, context);
  const factories = Object.assign({}, ...context.webpackChunkawemeim.map(entry => entry[1])), cache = {};
  function requireModule(id) { if (cache[id]) return cache[id].exports; const module = cache[id] = { exports: {} }; if (!factories[id] && shared[id]) factories[id] = vm.runInContext('('+shared[id]+')', context); if (!factories[id]) throw Error('missing chunk module '+id); factories[id](module, module.exports, requireModule); return module.exports; }
  requireModule.r = value => Object.defineProperty(value, '__esModule', { value: true });
  requireModule.d = (value, getters) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(value, key, { enumerable: true, get }); };
  requireModule.n = value => { const getter = value?.__esModule ? () => value.default : () => value; requireModule.d(getter, { a: getter }); return getter; };
  requireModule.o = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  requireModule.e = async () => {}; requireModule.t = requireModule;
  context.r = requireModule; vm.runInContext(raw, context);
  const io = { window: { crypto }, crypto, location: context.location, Math, TextEncoder, atob, btoa,
    loadCryptoJS: async () => requireModule(21396), loadJSEncrypt: async () => requireModule(64458) };
  if (packaged) {
    const load = file => vm.runInContext('(function(){var module={exports:{}},exports=module.exports;'+fs.readFileSync(file, 'utf8')+'\n;return module.exports;})()', context, { timeout: 3000 });
    const aes = load(require.resolve('crypto-js/crypto-js.js'));
    const rsa = load(require.resolve('jsencrypt'));
    io.loadCryptoJS = async () => aes;
    io.loadJSEncrypt = async () => ({ default: rsa.default || rsa });
  }
  return { context, io };
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-dtrait-crypto.js')).href);
  let aesCases = 0, utilCases = 0, rsaCases = 0;
  for (const packaged of [false, true]) for (const fallback of [false, true]) {
    const f = environment(fallback, packaged), rawAes = new f.context.AES(), local = new sdk.DesktopDTraitAes(f.io);
    for (const length of [16, 24, 32]) for (const text of ['', 'hello', '中文 🥔', 'a'.repeat(32)]) {
      const key = Buffer.alloc(length, 7).toString('hex');
      assert.deepStrictEqual(await local.encryptData(key, text), JSON.parse(JSON.stringify(await rawAes.encryptData(key, text)))); aesCases++;
    }
    const util = sdk.createDesktopDTraitCryptoUtil(f.io), rawUtil = f.context.util;
    const vectors = [['parseQuery', '?a=b=c&a=last+word'], ['parseQuery', 'x=%E4%B8%AD'], ['getQuery', 'https://test/a?x=first?x=last#h'], ['getQuery', 'https://test/'], ['isSupportSystemCrypto'], ['hexToUint8Array', '0gzzf'], ['uint8ArrayToHex', new Uint8Array([0, 1, 255])], ['unit8ArrayToString', new Uint8Array([0, 65, 255])], ['buff2base64', new Uint8Array([0, 255])], ['base642buff', 'AP8=']];
    for (const [name, ...args] of vectors) { const normalize = value => value instanceof Uint8Array ? [...value] : JSON.parse(JSON.stringify(value)); assert.deepStrictEqual(normalize(util[name](...args)), normalize(rawUtil[name](...args))); utilCases++; }
  }
  const keys = generateKeyPairSync('rsa', { modulusLength: 1024, publicKeyEncoding: { type: 'pkcs1', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  for (const kind of ['raw', 'sdk', 'packaged']) {
    const f = environment(false, kind === 'packaged'), rsa = kind === 'raw' ? new f.context.RSA() : new sdk.DesktopDTraitRsa(f.io);
    for (const text of ['', '0123456789abcdef0123456789abcdef', '中文']) {
      const cipher = await rsa.encryptData(keys.publicKey, text); assert.equal(typeof cipher, 'string'); assert.notEqual(cipher, '');
      // Verify real PKCS#1 v1.5 encryption without relying on OpenSSL's privateDecrypt padding policy.
      const block = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(cipher, 'base64'));
      assert.equal(block[0], 0); assert.equal(block[1], 2); const end = block.indexOf(0, 2); assert.ok(end >= 10); assert.equal(block.subarray(end+1).toString('utf8'), text); rsaCases++;
    }
    assert.equal(await rsa.encryptData('not a key', 'text'), ''); rsaCases++;
  }
  console.log(`PASS ${aesCases} raw AES/System+CryptoJS vectors, ${utilCases} utility vectors, ${rsaCases} actual JSEncrypt wrapper/decryption cases, including packaged dependencies (no network)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
