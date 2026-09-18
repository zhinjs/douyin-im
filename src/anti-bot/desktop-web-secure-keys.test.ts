import { createHmac, createPublicKey, verify, webcrypto } from 'node:crypto';
import { DesktopWebSecureKeys, type DesktopWebSecureKeysStoreSettings } from './desktop-web-secure-keys.js';
import { DesktopWebSecureServerCertificates } from './desktop-web-secure-server-certificate.js';
import { DesktopWebSecureSystemCrypto, type DesktopWebSecurePemPair } from './desktop-web-secure-crypto.js';
import { DesktopWebSecureKeyStore } from './desktop-web-secure-key-store.js';
import { DesktopWebSecureStore } from './desktop-web-secure-store.js';
import { DesktopWebSecureIframeHost, type DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';
import { DesktopWebSecureBridgeHost } from './desktop-web-secure-bridge.js';
import { DesktopWebSecureLocalStorage, DesktopWebSecureMemoryArea, createDesktopWebSecureMemoryStorage } from './desktop-web-secure-local-storage.js';
import { createDesktopWebSecureCookieDigest } from './desktop-web-secure-cookie.js';
import { DesktopWebSecureRequestPipeline, type DesktopWebSecureRequest } from './desktop-web-secure-request.js';
import { DesktopWebSecureTransportHooks, type DesktopWebSecureXhr } from './desktop-web-secure-transport.js';

const KEY = 's_sdk_crypt_sdk';
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture(initType: 'pubKey' | 'cert' = 'pubKey', setup?: (store: DesktopWebSecureStore) => void) {
  const local = createDesktopWebSecureMemoryStorage(new DesktopWebSecureMemoryArea());
  const db = new DesktopWebSecureLocalStorage(local, local, local, 'https://synthetic.invalid');
  const io: DesktopStorageIframeContext = { origin: 'https://synthetic.invalid', navigator: { userAgent: 'synthetic' }, window: {}, Date: { now: () => 100 }, performance: { now: () => 1 }, Math: { random: () => 0.1 },
    document: { body: null, readyState: 'complete', visibilityState: 'visible', getElementById: () => null, createElement: () => { throw Error('unexpected iframe'); }, addEventListener() {}, removeEventListener() {} },
    readLocalStorage: () => null, setTimeout: () => 0, clearTimeout() {}, addMessageListener() {}, removeMessageListener() {},
  };
  const store = new DesktopWebSecureStore(new DesktopWebSecureIframeHost(io), new DesktopWebSecureBridgeHost(io), { window: { parent: { postMessage() {} }, postMessage() {} }, hostname: 'synthetic.invalid',
    createLocalStorage: () => db, writeLocalStorage() {}, readCookie: () => '', queryIframes: () => [] }, { disableCrossStorage: true });
  setup?.(store);
  const cookies = new Map<string, string>(), cookieWrites: string[] = [];
  const document = { location: { hostname: 'synthetic.invalid' },
    get cookie() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
    set cookie(value: string) {
      cookieWrites.push(value); const entry = value.split(';')[0]!, index = entry.indexOf('='), key = entry.slice(0, index);
      if (value.includes('expires=Thu, 01 Jan 1970')) cookies.delete(key); else cookies.set(key, entry.slice(index + 1));
    },
  };
  const keyStore = new DesktopWebSecureKeyStore({ document, Math: io.Math, createStore: () => store }, { enableCache: false });
  const crypto = new DesktopWebSecureSystemCrypto(webcrypto.subtle), create = jest.fn((_settings: DesktopWebSecureKeysStoreSettings) => { void _settings; return keyStore; });
  const certificate = jest.fn<Promise<{ cert: string; sn: string }>, [number | string, boolean?]>(async () => ({ cert: 'not-a-cert', sn: 'synthetic' }));
  const events: unknown[][] = [], background = jest.fn();
  const keys = new DesktopWebSecureKeys({ crypto, certificates: { get: certificate }, createKeyStore: create, Date, document, performance: { now: () => 100 }, onBackgroundError: background }, { aid: 1128, initType });
  for (const event of ['load', 'ready', 'error', 'execute']) keys.on(event, value => { events.push([event, value]); });
  return { keys, crypto, keyStore, store, local, create, certificate, events, background, cookies, cookieWrites, document };
}
function record(pair: DesktopWebSecurePemPair, csr = '') { return JSON.stringify({ ec_privateKey: pair.privatePem, ec_publicKey: pair.publicPem, ec_csr: csr }); }
afterEach(() => jest.restoreAllMocks());

it('generates, persists via real local Store/KeyStore, restores in another owner and signs', async () => {
  const f = fixture(); await f.keys.initIframeStore(); expect(await f.keys.checkCryptKeys()).toBe(true);
  expect(await f.keys.checkSigningKeys()).toBe(true);
  const text = await f.keyStore.getLocalItem(KEY); expect(typeof text).toBe('string');
  const data = JSON.parse(text as string); expect(data.ec_csr).toBe('');
  const restored = new DesktopWebSecureKeys({ crypto: f.crypto, certificates: { get: f.certificate }, createKeyStore: () => f.keyStore, Date });
  await restored.initIframeStore(); await restored.checkCryptKeys(); expect(await restored.checkSigningKeys()).toBe(true);
  const signature = await restored.cryptoSDK!.sign('synthetic');
  expect(verify('sha256', Buffer.from('synthetic'), data.ec_publicKey, Buffer.from(signature.buffer))).toBe(true);
  expect(await f.keyStore.getLocalItem(KEY)).toBe(text);
});

it('reuses store and key-check flights and caches successful lifecycle without claiming fresh validation', async () => {
  const f = fixture(); await Promise.all([f.keys.initIframeStore(), f.keys.initIframeStore()]); expect(f.create).toHaveBeenCalledTimes(1);
  const generation = jest.spyOn(f.crypto, 'generateNewKeyPairPEM'), a = f.keys.checkCryptKeys();
  expect(f.keys.checkCryptKeys()).toBe(a); await a;
  await f.keys.checkCryptKeys(); expect(generation).toHaveBeenCalledTimes(1);
});

it('await initIframeKeys does not wait for generation or falsely claim signing readiness', async () => {
  const f = fixture(), gate = deferred<DesktopWebSecurePemPair>();
  jest.spyOn(f.crypto, 'generateNewKeyPairPEM').mockReturnValue(gate.promise);
  await f.keys.initIframeKeys(); await flush();
  let done = false; void f.keys.checkCryptKeys().then(() => { done = true; }); await flush(); expect(done).toBe(false);
  gate.resolve(await new DesktopWebSecureSystemCrypto(webcrypto.subtle).generateNewKeyPairPEM());
  await f.keys.checkCryptKeys(); expect(await f.keys.checkSigningKeys()).toBe(true);
});

it('preserves truthy invalid PEM source-success but rejects real signing and diagnostic validation', async () => {
  const f = fixture(); await f.keyStore.setLocalItem(KEY, JSON.stringify({ ec_privateKey: 'bad', ec_publicKey: 'bad' }));
  await f.keys.initIframeStore(); expect(await f.keys.checkCryptKeys()).toBe(true); expect(await f.keys.checkSigningKeys()).toBe(false);
  await expect(f.keys.cryptoSDK!.sign('synthetic')).rejects.toThrow('[Func signWithECDSA]');
});

it('detects a valid but mismatched private/public pair without replacing stored keys', async () => {
  const f = fixture(), a = await f.crypto.generateNewKeyPairPEM(), b = await f.crypto.generateNewKeyPairPEM(), text = record({ privatePem: a.privatePem, publicPem: b.publicPem });
  await f.keyStore.setLocalItem(KEY, text); await f.keys.initIframeStore(); expect(await f.keys.checkCryptKeys()).toBe(true);
  expect(await f.keys.checkSigningKeys()).toBe(false); expect(await f.keyStore.getLocalItem(KEY)).toBe(text);
});

it('local race winner is adopted after generating, without overwriting it', async () => {
  const f = fixture(), old = await f.crypto.generateNewKeyPairPEM(), text = record(old);
  jest.spyOn(f.keyStore, 'getItems').mockResolvedValue({}); await f.keyStore.setLocalItem(KEY, text); await f.keys.initIframeStore();
  const generated = jest.spyOn(f.crypto, 'generateNewKeyPairPEM'); await expect(f.keys.checkCryptKeys()).resolves.toBe(true);
  expect(generated).toHaveBeenCalledTimes(1); expect(await f.keys.cryptoSDK!.getKeys()).toEqual({ privateKey: old.privatePem, publicKey: old.publicPem });
  expect(f.events).toContainEqual(['ready', { action: 'keys', op: 'init', status: 'fail', ctx: { type: 'check' } }]);
  expect(await f.keyStore.getLocalItem(KEY)).toBe(text);
});

it('local empty object returns source true while its replacement pipeline is still pending', async () => {
  const f = fixture(), first = await f.crypto.generateNewKeyPairPEM(), second = deferred<DesktopWebSecurePemPair>();
  jest.spyOn(f.crypto, 'generateNewKeyPairPEM').mockResolvedValueOnce(first).mockReturnValueOnce(second.promise);
  jest.spyOn(f.keyStore, 'getItems').mockResolvedValue({}); await f.keyStore.setLocalItem(KEY, '{}'); await f.keys.initIframeStore();
  await expect(f.keys.checkCryptKeys()).resolves.toBe(true);
  let checked = false; const diagnostic = f.keys.checkSigningKeys().then(value => { checked = true; return value; });
  await flush(); expect(checked).toBe(false); expect(f.keys._initData).toEqual({ cryptCacheKey: '{}' });
  second.resolve(first); expect(await diagnostic).toBe(true); expect(await f.keyStore.getLocalItem(KEY)).toBe('{}');
});

it('malformed local JSON fails but source still emits sdk/init success after keys/init fail', async () => {
  const f = fixture(); jest.spyOn(f.keyStore, 'getItems').mockResolvedValue({}); await f.keyStore.setLocalItem(KEY, '{'); await f.keys.initIframeStore();
  expect(await f.keys.checkCryptKeys()).toBe(false);
  expect(f.events).toContainEqual(['load', { action: 'keys', op: 'init', status: 'fail' }]);
  expect(f.events.at(-1)).toEqual(['load', { action: 'sdk', op: 'init', duration: 100, status: 'success' }]);
});

it('cert mode missing CSR regenerates but retains the native empty CSR instead of inventing issuance', async () => {
  const f = fixture('cert'), pair = await f.crypto.generateNewKeyPairPEM();
  jest.spyOn(f.keyStore, 'getItems').mockResolvedValue({ [KEY]: record(pair) });
  await f.keys.initIframeStore(); await expect(f.keys.checkCryptKeys()).resolves.toBe(true);
  expect(JSON.parse(await f.keyStore.getLocalItem(KEY) as string).ec_csr).toBe('');
});

it('Fe-swallowed persistence failure may yield source true while no cache was written', async () => {
  const f = fixture('pubKey', store => { jest.spyOn(store, 'setLocalItem').mockRejectedValue(Error('denied')); jest.spyOn(store, 'setItem').mockRejectedValue(Error('denied')); });
  await f.keys.initIframeStore(); expect(await f.keys.checkCryptKeys()).toBe(true); expect(await f.keys.checkSigningKeys()).toBe(true);
  expect(await f.keyStore.getLocalItem(KEY)).toBe('');
});

it('public initialization exports the uncompressed point as base64 and remembers it', async () => {
  const f = fixture(); await f.keys.initIframeStore(); const a = f.keys.initPubKey(); expect(f.keys.initPubKey()).toBe(a);
  const publicKey = Buffer.from((await a)!, 'base64'); expect(publicKey).toHaveLength(65); expect(publicKey[0]).toBe(4);
  expect(await f.keys.initPubKey()).toBe(publicKey.toString('base64'));
});

it('key init false still attempts server certificate and empty ECDH result is cached', async () => {
  const f = fixture(); jest.spyOn(f.keyStore, 'getItems').mockRejectedValue(Error('read')); await f.keys.initIframeStore();
  const bytes = await f.keys.initECDHKey(); expect(bytes).toHaveLength(0); expect(f.certificate).toHaveBeenCalledWith(1128, true);
  expect(await f.keys.initECDHKey()).toBe(bytes); expect(f.certificate).toHaveBeenCalledTimes(1);
  expect(await f.keys.checkSigningKeys()).toBe(false);
});

it('connects real store initialization, certificate XHR/cache and WebCrypto ECDH, then caches the result', async () => {
  const f = fixture(), server = await f.crypto.generateNewKeyPairPEM();
  const spki = createPublicKey(server.publicPem).export({ type: 'spki', format: 'der' });
  const sequence = (parts: Buffer[]) => { const bytes = Buffer.concat(parts); return Buffer.concat([Buffer.from([48, bytes.length]), bytes]); };
  const cert = `-----BEGIN CERTIFICATE-----\n${sequence([sequence([...Array.from({ length: 6 }, () => Buffer.from([5, 0])), spki])]).toString('base64')}\n-----END CERTIFICATE-----`;
  const cache = new Map<string, string>(), requests: string[] = [];
  class Xhr {
    readonly readyState = 4; readonly status = 200;
    readonly response = JSON.stringify({ message: 'success', data: { server_cert: cert, server_sn: 'synthetic' } });
    onreadystatechange: (() => void) | null = null;
    open(_method: string, url: string) { requests.push(url); }
    setRequestHeader() {}
    send() { this.onreadystatechange?.(); }
  }
  const certificates = new DesktopWebSecureServerCertificates({ XMLHttpRequest: Xhr, window: { XMLHttpRequest: true, FormData: true }, Date,
    localStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value); } }, setTimeout() {},
  });
  f.certificate.mockImplementation(async (aid, useCache) => {
    const value = await certificates.get(aid, useCache); return { cert: value.cert as string, sn: value.sn as string };
  });
  await f.keys.initIframeStore();
  const bytes = await f.keys.initECDHKey(); expect(bytes).toHaveLength(32);
  const { privateKey } = await f.keys.cryptoSDK!.getKeys(); expect(bytes).toEqual((await f.crypto.deriveEcdhKey(privateKey as string, cert)).bytes);
  expect(await f.keys.initECDHKey()).toBe(bytes); expect(f.certificate).toHaveBeenCalledTimes(1);
  expect(requests).toEqual(['/passport/ticket_guard/get_client_cert/?aid=1128&is_from_ttaccountsdk=1']); expect(cache.size).toBe(1);
});

it('observer failures can escape source catch blocks but background rejections are observed', async () => {
  const f = fixture(); f.keys.on('load', () => { throw Error('observer'); });
  await f.keys.initIframeKeys(); await expect(f.keys.checkCryptKeys()).rejects.toThrow('observer'); await flush();
  expect(f.background).toHaveBeenCalledWith(expect.objectContaining({ message: 'observer' }));
});

async function signedFixture() {
  const f = fixture(); await f.keys.initIframeStore(); await f.keys.checkCryptKeys();
  await f.keys.setSignValueAsync({ sign: { ticket: 'synthetic-ticket', ts_sign: 'synthetic-ts', client_cert: 'pub.synthetic' }, scene: 'web_protect', namespace: 'synthetic' });
  return { ...f, info: await f.keys.getKeysInfoWithOrigin({ certType: 'header', scene: 'web_protect' }) };
}
function envelope(value: { result: string } | null) { expect(value).not.toBeNull(); return JSON.parse(Buffer.from(value!.result, 'base64').toString('utf8')); }

it('persists a header response ticket and certificate, reads origin metadata and distinct encodings', async () => {
  const f = await signedFixture();
  expect(f.info.sign).toEqual({ ticket: 'synthetic-ticket', ts_sign: 'synthetic-ts', client_cert: 'pub.synthetic' });
  expect(f.info.b64Cert).toBe(Buffer.from('pub.synthetic').toString('base64')); expect(f.info.b64Csr).toBe('');
  expect(Buffer.from(f.info.b64PubKey!, 'base64')).toHaveLength(65); expect(f.info.items).toHaveLength(3); expect(f.info.cacheEnabled).toBe(false);
  expect(await f.keyStore.getLocalItem('s_sdk_cert_key')).toBe('pub.synthetic');
});

it('signs sign_data, not req_content, and creates the exact ECDSA JSON envelope', async () => {
  const f = await signedFixture(), sign_data = 'ticket=synthetic-ticket&path=/synthetic&timestamp=123';
  const signed = await f.keys.signWithKeysInfo({ keysInfo: f.info, certType: 'header', scene: 'web_protect', sign_data, req_content: 'ticket,path,timestamp', timestamp: 123, isNewCert: false });
  const value = envelope(signed); expect(signed!.algoType).toBe('ecdsa');
  expect(value).toEqual({ ts_sign: 'synthetic-ts', req_content: 'ticket,path,timestamp', req_sign: expect.any(String), timestamp: 123 });
  expect(verify('sha256', Buffer.from(sign_data), f.info.crypt!.ec_publicKey as string, Buffer.from(value.req_sign, 'base64'))).toBe(true);
  expect(verify('sha256', Buffer.from('ticket,path,timestamp'), f.info.crypt!.ec_publicKey as string, Buffer.from(value.req_sign, 'base64'))).toBe(false);
});

it('falls back to ECDSA on server-certificate/ECDH failure instead of fabricating an HMAC success', async () => {
  const f = await signedFixture(); const signed = await f.keys.signWithKeysInfo({ keysInfo: f.info, certType: 'header', scene: 'web_protect', timestamp: 1 });
  expect(signed!.algoType).toBe('ecdsa');
  const value = envelope(signed); expect(value.req_content).toBe('synthetic-ticket');
  expect(verify('sha256', Buffer.from('synthetic-ticket'), f.info.crypt!.ec_publicKey as string, Buffer.from(value.req_sign, 'base64'))).toBe(true);
});

it.each([0, 32])('HMAC signs with a %d-byte derived key; empty result is not a binding guarantee', async size => {
  const f = await signedFixture(), key = new Uint8Array(size).fill(3);
  jest.spyOn(f.crypto, 'deriveEcdhKey').mockResolvedValue({ bytes: key, hex: Buffer.from(key).toString('hex') });
  const signed = await f.keys.signWithKeysInfo({ keysInfo: f.info, certType: 'header', scene: 'web_protect', sign_data: 'payload', timestamp: 100 });
  expect(signed!.algoType).toBe('hmac'); expect(envelope(signed).req_sign).toBe(createHmac('sha256', key).update('payload').digest('base64'));
  expect(signed!.times).toEqual({ calTime: expect.any(Number), ecdhTime: expect.any(Number), hmacTime: expect.any(Number) });
});

it('retains the source cached ECDH across a changed keysInfo instead of claiming automatic key rebinding', async () => {
  const f = await signedFixture(), key = new Uint8Array(32).fill(3), derive = jest.spyOn(f.crypto, 'deriveEcdhKey').mockResolvedValue({ bytes: key, hex: '' });
  await f.keys.signWithKeysInfo({ keysInfo: f.info, scene: 'web_protect' });
  const other = await f.crypto.generateNewKeyPairPEM();
  const signed = await f.keys.signWithKeysInfo({ keysInfo: { ...f.info, crypt: { ec_privateKey: other.privatePem, ec_publicKey: other.publicPem } }, scene: 'web_protect' });
  expect(derive).toHaveBeenCalledTimes(1); expect(signed!.algoType).toBe('hmac');
});

it('HMAC checks private-key presence before waiting for replacement generation, then ECDSA waits for that pipeline', async () => {
  const f = await signedFixture(), key = new Uint8Array(32).fill(3);
  jest.spyOn(f.crypto, 'deriveEcdhKey').mockResolvedValue({ bytes: key, hex: '' }); await f.keys.initECDHKey();
  const generated = await f.crypto.generateNewKeyPairPEM(), gate = deferred<DesktopWebSecurePemPair>();
  jest.spyOn(f.crypto, 'generateNewKeyPairPEM').mockReturnValue(gate.promise);
  const logs: unknown[] = []; f.keys.on('log', value => { logs.push(value); });
  const pending = f.keys.signWithKeysInfo({ keysInfo: { ...f.info, crypt: {} }, scene: 'web_protect' });
  let done = false; void pending.then(() => { done = true; }); await flush(); expect(done).toBe(false);
  expect(logs).toContainEqual({ level: 'error', content: 'sign with hmac failed', extra: { message: 'private key is empty' } });
  gate.resolve(generated); const result = await pending; expect(result!.algoType).toBe('ecdsa');
  expect(verify('sha256', Buffer.from('synthetic-ticket'), generated.publicPem, Buffer.from(envelope(result).req_sign, 'base64'))).toBe(true);
});

it('timestamp zero falls back to current seconds while a negative timestamp is retained', async () => {
  const f = await signedFixture(), before = Math.floor(Date.now() / 1000);
  const zero = envelope(await f.keys.signWithKeysInfo({ keysInfo: f.info, scene: 'web_protect', timestamp: 0, isNewCert: false }));
  expect(zero.timestamp).toBeGreaterThanOrEqual(before);
  const negative = envelope(await f.keys.signWithKeysInfo({ keysInfo: f.info, scene: 'web_protect', timestamp: -1, isNewCert: false })); expect(negative.timestamp).toBe(-1);
});

it('refuses missing sign/ticket and does not treat initialized keys alone as signed-session readiness', async () => {
  const f = await signedFixture();
  expect(await f.keys.signWithKeysInfo({ keysInfo: {}, scene: 'web_protect' })).toBeNull();
  expect(await f.keys.signWithKeysInfo({ keysInfo: { sign: {} }, scene: 'web_protect' })).toBeNull();
});

it('base64 ticket decoding follows atob/TextDecoder, including BOM removal', async () => {
  const f = await signedFixture(), text = JSON.stringify({ ticket: '中文' });
  expect(await f.keys.setSignValueAsync({ sign: Buffer.from(`\ufeff${text}`).toString('base64'), scene: 'other' })).toBe(true);
  expect(await f.keyStore.getLocalItem('s_sdk_sign_data_key/other')).toBe(text);
  expect(await f.keys.setSignValueAsync({ sign: '-w==', scene: 'other' })).toBe(false);
});

it('preserves outer true after inner parse failure and does not claim persistence from the return value', async () => {
  const f = await signedFixture();
  expect(await f.keys.setSignValueAsync({ sign: Buffer.from('{').toString('base64'), scene: 'bad' })).toBe(true);
  expect(await f.keyStore.getLocalItem('s_sdk_sign_data_key/bad')).toBe('');
  expect(await f.keys.setSignValueAsync({ sign: { toJSON: () => undefined }, scene: 'bad' })).toBe(true);
});

it('scheduler.wait remains a void non-barrier while a scene write is pending', async () => {
  const f = await signedFixture(), gate = deferred<void>(), original = f.keyStore.set;
  jest.spyOn(f.keyStore, 'set').mockImplementation((key, value, sync) => key === 's_sdk_sign_data_key/delayed' ? gate.promise.then(() => original(key, value, sync)) : original(key, value, sync));
  expect(f.keys.setSignValue({ sign: { ticket: 'delayed' }, scene: 'delayed' })).toBe(true);
  const early = await f.keys.getKeysInfoWithOrigin({ scene: 'delayed', certType: 'header' }); expect(early.sign?.ticket).toBeUndefined();
  gate.resolve(); await flush();
  const late = await f.keys.getKeysInfoWithOrigin({ scene: 'delayed', certType: 'header' }); expect(late.sign?.ticket).toBe('delayed');
});

it('scene clearing leaves a certificate written through per-call namespace when instance namespace is absent', async () => {
  const f = await signedFixture(); expect(await f.keys.clearSignData('web_protect')).toBe(true);
  expect(await f.keyStore.getLocalItem('s_sdk_sign_data_key/web_protect')).toBe(''); expect(await f.keyStore.getLocalItem('s_sdk_cert_key')).toBe('pub.synthetic');
  expect(f.keys._signData).toBe('');
});

it('does not log raw ticket/signature/CSR material on success or sign failure', async () => {
  const f = await signedFixture(), logs: unknown[] = []; f.keys.on('log', value => { logs.push(value); });
  await f.keys.getKeysInfoWithOrigin({ scene: 'web_protect' });
  await f.keys.signWithKeysInfo({ keysInfo: { ...f.info, crypt: { ec_privateKey: 'invalid-private', ec_publicKey: 'invalid-public', ec_csr: 'secret-csr' } },
    scene: 'web_protect', sign_data: 'secret-sign-data', req_content: 'secret-content', isNewCert: false });
  const text = JSON.stringify(logs);
  for (const secret of ['synthetic-ts', 'synthetic-ticket', 'secret-csr', 'pub.synthetic', 'secret-sign-data', 'secret-content']) expect(text).not.toContain(secret);
  expect(text).toContain('[redacted]');
});

it('connects Cookie preparation to both the modern getter and signer', async () => {
  const f = await signedFixture();
  const info = await f.keys.getKeysInfoWithOrigin({ scene: 'web_protect', certType: 'cookie' });
  expect(info.sign?.ticket).toBe('synthetic-ticket');
  const signed = await f.keys.signWithKeysInfo({ keysInfo: info, scene: 'web_protect', certType: 'cookie', isNewCert: false });
  expect(signed?.algoType).toBe('ecdsa');
  const header = JSON.parse(Buffer.from(f.keyStore.cookieOperate.getCookie('bd_ticket_guard_client_data')!, 'base64').toString());
  expect(header).toEqual({ 'bd-ticket-guard-version': 2, 'bd-ticket-guard-iteration-version': 1,
    'bd-ticket-guard-ree-public-key': info.b64PubKey, 'bd-ticket-guard-web-version': 2 });
  expect(f.keyStore.cookieOperate.getCookie('bd_ticket_guard_client_web_domain')).toBe('2');
});

const CERT = 's_sdk_cert_key', SIGN = 's_sdk_sign_data_key/web_protect', SERVER = 'bd_ticket_guard_server_data', DIGEST = '_bd_ticket_crypt_cookie';
async function cookieFixture() {
  const f = fixture(); await f.keys.initIframeStore(); await f.keys.checkCryptKeys();
  const keyText = await f.keyStore.getLocalItem(KEY) as string, info = await f.keys.getKeysInfoWithOrigin({ scene: 'web_protect' });
  const cert = `pub.${info.b64PubKey}.unchecked`, ticket = { ticket: 'synthetic-cookie-ticket', ts_sign: 'synthetic-cookie-ts', client_cert: cert };
  return { ...f, keyText, info, cert, ticket, put(value: unknown = ticket) {
    f.keyStore.cookieOperate.setCookieWithDomain(SERVER, Buffer.from(JSON.stringify(value)).toString('base64'));
  } };
}

it('imports matching public ticket, fingerprints the bundle, deletes server cookies and signs with real keys', async () => {
  const f = await cookieFixture(); f.put(); f.keyStore.cookieOperate.setCookieWithDomain('bd_ticket_guard_web_domain', '2');
  expect(await f.keys.initCookie('web_protect')).toBe(true);
  const info = await f.keys.getKeysInfoWithOrigin({ certType: 'cookie', scene: 'web_protect' });
  expect(info.sign?.ticket).toBe(f.ticket.ticket); expect(info.cert).toBe(f.cert);
  expect(f.keyStore.cookieOperate.getCookie(DIGEST)).toBe(createDesktopWebSecureCookieDigest(f.keyText, f.cert, JSON.stringify(f.ticket)));
  expect(f.keyStore.cookieOperate.getCookie(SERVER)).toBeNull(); expect(f.keyStore.cookieOperate.getCookie('bd_ticket_guard_web_domain')).toBeNull();
  expect(f.keyStore.cookieOperate.getCookie('_bd_ticket_crypt_doamin')).toBe('2');
  expect(f.keyStore.cookieOperate.getCookie('__security_server_data_status')).toBe('1');
  const signed = envelope(await f.keys.signWithKeysInfo({ keysInfo: info, scene: 'web_protect', certType: 'cookie', isNewCert: false }));
  expect(verify('sha256', Buffer.from(f.ticket.ticket), JSON.parse(f.keyText).ec_publicKey, Buffer.from(signed.req_sign, 'base64'))).toBe(true);
});

it('preserves undefined-scene first initialization in getter rather than inventing the requested scene', async () => {
  const f = await cookieFixture(); f.put();
  const result = await f.keys.getKeysInfoWithOrigin({ certType: 'cookie', scene: 'web_protect' });
  expect(result.sign?.ticket).toBeUndefined(); expect(await f.keyStore.getLocalItem('s_sdk_sign_data_key/undefined')).toBe(JSON.stringify(f.ticket));
  expect(await f.keyStore.getLocalItem(SIGN)).toBe('');
  f.put({ ...f.ticket, ticket: 'later' });
  expect((await f.keys.getKeysInfoWithOrigin({ certType: 'cookie', scene: 'web_protect' })).sign?.ticket).toBe('later');
});

it('reads server cookie through independent He fallback and applies the additional URI decode', async () => {
  const f = await cookieFixture();
  const base64 = Buffer.from(JSON.stringify(f.ticket)).toString('base64');
  f.cookies.set(SERVER, encodeURIComponent(base64.replace(/./g, char => `%${char.charCodeAt(0).toString(16)}`)));
  const original = f.keyStore.cookieOperate.getCookie;
  jest.spyOn(f.keyStore.cookieOperate, 'getCookie').mockImplementation(name => name === SERVER ? null : original(name));
  expect(await f.keys.processServerCookie('web_protect')).toBe(true);
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(JSON.stringify(f.ticket));
});

it('returns false for malformed server payload but initCookie still caches outer true', async () => {
  const f = await cookieFixture(); f.keyStore.cookieOperate.setCookieWithDomain(SERVER, '%%%');
  expect(await f.keys.processServerCookie('bad')).toBe(false); expect(f.keyStore.cookieOperate.getCookie(SERVER)).toBe('%%%');
  expect(await f.keys.initCookie('bad')).toBe(true);
  f.put(); expect(await f.keys.initCookie('web_protect')).toBe(true);
  expect(f.keyStore.cookieOperate.getCookie(SERVER)).not.toBeNull(); expect(await f.keyStore.getLocalItem(SIGN)).toBe('');
  expect(f.events).toContainEqual(['execute', expect.objectContaining({ status: 'fail', ctx: { type: 'server' } })]);
});

it('writes mismatched ticket/cert and clears Cookie exactly like source without claiming trusted readiness', async () => {
  const f = await cookieFixture(), ticket = { ...f.ticket, client_cert: 'pub.mismatch' }; f.put(ticket);
  expect(await f.keys.processServerCookie('web_protect')).toBe(true);
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(JSON.stringify(ticket)); expect(await f.keyStore.getLocalItem(CERT)).toBe('pub.mismatch');
  expect(await f.keyStore.getLocalItem(KEY)).toBe(f.keyText); expect(f.keyStore.cookieOperate.getCookie(DIGEST)).toBeNull();
  expect(f.events).toContainEqual(['load', { action: 'cookie', op: 'check', status: 'fail', ctx: { type: 'local', local: '1', localCorrect: '0' } }]);
});

it.each([false, true])('compares extracted real SPKI hex strictly, not a same-key PEM (stored hex=%s)', async storedHex => {
  const f = await cookieFixture(), spki = createPublicKey(JSON.parse(f.keyText).ec_publicKey).export({ type: 'spki', format: 'der' });
  const sequence = (parts: Buffer[]) => { const bytes = Buffer.concat(parts); return Buffer.concat([Buffer.from([48, bytes.length]), bytes]); };
  // Unsigned synthetic ASN.1 container: source extraction checks no issuer/trust/signature.
  const cert = `-----BEGIN CERTIFICATE-----\n${sequence([sequence([...Array.from({ length: 6 }, () => Buffer.from([5, 0])), spki])]).toString('base64')}\n-----END CERTIFICATE-----`;
  expect(await f.crypto.extractPublicKeyFromX509Cert(cert)).toEqual(new Uint8Array(spki));
  let owner = f.keys;
  if (storedHex) {
    await f.keyStore.setLocalItem(KEY, JSON.stringify({ ...JSON.parse(f.keyText), ec_publicKey: spki.toString('hex') }));
    owner = new DesktopWebSecureKeys({ crypto: f.crypto, certificates: { get: f.certificate }, createKeyStore: () => f.keyStore, document: f.document, Date });
    owner.on('load', value => { f.events.push(['load', value]); }); await owner.initIframeStore(); await owner.checkCryptKeys();
  }
  f.put({ ...f.ticket, client_cert: cert }); expect(await owner.processServerCookie('web_protect')).toBe(true);
  expect(f.events).toContainEqual(['load', expect.objectContaining({ action: 'cookie', op: 'check', status: storedHex ? 'success' : 'fail',
    ctx: storedHex ? { type: 'init' } : { type: 'local', local: '1', localCorrect: '0' } })]);
  // A certificate-field match can coexist with a public key unusable by the signing provider.
  expect(await owner.checkSigningKeys()).toBe(!storedHex);
});

it('switches to a matching local key but leaves already-cached public key and ECDH unchanged', async () => {
  const f = await cookieFixture(), initialPublic = await f.keys.initPubKey();
  jest.spyOn(f.crypto, 'deriveEcdhKey').mockResolvedValue({ bytes: new Uint8Array([1, 2]), hex: '0102' });
  const ecdh = await f.keys.initECDHKey(), pair = await f.crypto.generateNewKeyPairPEM(), local = record(pair);
  await f.keyStore.setLocalItem(KEY, local);
  const pub = (await f.crypto.extractPublicKeyHexFromPem(pair.publicPem)).rawHex;
  const cert = `pub.${Buffer.from(pub, 'hex').toString('base64')}`; f.put({ ...f.ticket, client_cert: cert });
  expect(await f.keys.processServerCookie('web_protect')).toBe(true);
  expect(await f.keys.cryptoSDK!.getKeys()).toEqual({ privateKey: pair.privatePem, publicKey: pair.publicPem });
  expect(await f.keys.initPubKey()).toBe(initialPublic); expect(await f.keys.initECDHKey()).toBe(ecdh);
  expect(f.events).toContainEqual(['load', { action: 'cookie', op: 'check', status: 'success', ctx: { type: 'local' } }]);
});

it('writes a ticket without client_cert and does not overwrite the old certificate', async () => {
  const f = await cookieFixture(); await f.keyStore.setLocalItem(CERT, 'old'); f.put({ ticket: 'no-cert' });
  expect(await f.keys.processServerCookie('web_protect')).toBe(true);
  expect(await f.keyStore.getLocalItem(CERT)).toBe('old'); expect(await f.keyStore.getLocalItem(SIGN)).toBe('{"ticket":"no-cert"}');
});

it('cleans domain-only Cookie and keeps the installed doamin spelling', async () => {
  const f = await cookieFixture(); f.keyStore.cookieOperate.setCookieWithDomain('bd_ticket_guard_web_domain', '2');
  expect(await f.keys.processServerCookie()).toBe(true);
  expect(f.keyStore.cookieOperate.getCookie('bd_ticket_guard_web_domain')).toBeNull(); expect(f.keyStore.cookieOperate.getCookie('_bd_ticket_crypt_doamin')).toBe('2');
  expect(f.keyStore.cookieOperate.getCookie('__security_server_data_status')).toBeNull();
});

it('does not treat Fe-swallowed store write failure as verified persistence', async () => {
  const f = fixture('pubKey', store => { jest.spyOn(store, 'setItemWithKeys').mockRejectedValue(Error('synthetic write failure')); });
  await f.keys.initIframeStore(); await f.keys.checkCryptKeys();
  f.keyStore.cookieOperate.setCookieWithDomain(SERVER, Buffer.from('{"ticket":"lost"}').toString('base64'));
  expect(await f.keys.processServerCookie('web_protect')).toBe(true);
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(''); expect(f.keyStore.cookieOperate.getCookie(SERVER)).toBeNull();
});

it.each(['1', '2', '3'] as const)('performs MD5 fallback %s before deferred iframe sync, then rechecks current Cookie', async type => {
  const f = await cookieFixture(), gate = deferred<void>(), original = f.keyText;
  Object.defineProperty(f.keyStore, 'loadIframePromise', { value: gate.promise });
  const local = type === '1' ? original : record(await f.crypto.generateNewKeyPairPEM());
  await f.keyStore.setLocalItem(KEY, local); await f.keyStore.setLocalItem(CERT, f.cert); await f.keyStore.setLocalItem(SIGN, JSON.stringify(f.ticket));
  f.keys._initData[CERT] = type === '3' ? 'wrong' : f.cert; f.keys._initData[SIGN] = JSON.stringify(f.ticket);
  f.keyStore.cookieOperate.setCookieWithDomain(DIGEST, createDesktopWebSecureCookieDigest(local, f.cert, JSON.stringify(f.ticket)));
  const writes = jest.spyOn(f.keyStore, 'setItems');
  expect(await f.keys.checkCookieMd5()).toBeUndefined(); expect(f.keys.initMatch).toBe(true); expect(writes).not.toHaveBeenCalled();
  if (type !== '1') expect(await f.keys.cryptoSDK!.getKeys()).toEqual({ privateKey: JSON.parse(local).ec_privateKey, publicKey: JSON.parse(local).ec_publicKey });
  f.keyStore.cookieOperate.setCookieWithDomain(DIGEST, 'changed-before-callback'); gate.resolve();
  // Real local Store's promise pipeline is deeper than a single microtask.
  for (let i = 0; i < 6; i++) await flush();
  expect(writes).toHaveBeenCalledWith([KEY, CERT, SIGN], [local, f.cert, JSON.stringify(f.ticket)], 2);
  expect(f.events).toContainEqual(['load', { action: 'cookie', op: 'process', status: 'success', ctx: { type, scene: 'callback', correct: '0', cross: '0' } }]);
});

it('returns false only for absent MD5, leaves a bad fingerprint untouched and does not fake initMatch', async () => {
  const f = await cookieFixture(); expect(await f.keys.checkCookieMd5()).toBe(false);
  f.keyStore.cookieOperate.setCookieWithDomain(DIGEST, 'bad'); expect(await f.keys.checkCookieMd5()).toBeUndefined();
  expect(f.keys.initMatch).toBe(false); expect(f.keyStore.cookieOperate.getCookie(DIGEST)).toBe('bad');
});

it('reports delayed sync rejection without creating unhandled rejections or changing initMatch', async () => {
  const f = await cookieFixture(), gate = deferred<void>(); Object.defineProperty(f.keyStore, 'loadIframePromise', { value: gate.promise });
  f.keys._initData[CERT] = f.cert; f.keys._initData[SIGN] = JSON.stringify(f.ticket);
  f.keyStore.cookieOperate.setCookieWithDomain(DIGEST, createDesktopWebSecureCookieDigest(f.keyText, f.cert, JSON.stringify(f.ticket)));
  jest.spyOn(f.keyStore, 'setItems').mockRejectedValue(Error('detached failure'));
  await f.keys.checkCookieMd5(); gate.resolve(); await flush();
  expect(f.events).toContainEqual(['error', expect.objectContaining({ name: 'async data fail' })]); expect(f.keys.initMatch).toBe(true);
  expect(f.background).not.toHaveBeenCalled();
});

it('cert-mode client Cookie carries raw CSR and skips MD5 after server data processing', async () => {
  const f = fixture('cert'), pair = await f.crypto.generateNewKeyPairPEM(); await f.keyStore.setLocalItem(KEY, record(pair, 'synthetic-raw-CSR'));
  await f.keys.initIframeStore(); await f.keys.checkCryptKeys();
  f.keyStore.cookieOperate.setCookieWithDomain(SERVER, Buffer.from('{"ticket":"synthetic"}').toString('base64')); await f.keys.processServerCookie('web_protect');
  const md5 = jest.spyOn(f.keys, 'checkCookieMd5'); await f.keys.processCookie(); expect(md5).not.toHaveBeenCalled();
  expect(JSON.parse(Buffer.from(f.keyStore.cookieOperate.getCookie('bd_ticket_guard_client_data')!, 'base64').toString())).toEqual({
    'bd-ticket-guard-version': 2, 'bd-ticket-guard-iteration-version': 1, 'bd-ticket-guard-client-csr': 'synthetic-raw-CSR',
  });
});

it('redacts raw Cookie, ticket signature, public key, certificate and fingerprint logs', async () => {
  const f = await cookieFixture(), logs: unknown[] = []; f.keys.on('log', data => { logs.push(data); });
  f.put(); await f.keys.processServerCookie('web_protect');
  f.put({ ...f.ticket, client_cert: 'pub.private-cert-marker' }); await f.keys.processServerCookie('web_protect');
  f.keyStore.cookieOperate.setCookieWithDomain(SERVER, '%%%secret-cookie'); await f.keys.processServerCookie();
  const serialized = JSON.stringify(logs);
  for (const secret of [f.ticket.ticket, f.ticket.ts_sign, f.cert, 'private-cert-marker', 'secret-cookie', JSON.parse(f.keyText).ec_publicKey]) expect(serialized).not.toContain(secret);
  expect(serialized).toContain('[redacted]');
});

it('start launches detached tasks in order and only initializes the first entry of each cookie scene', async () => {
  const f = fixture(), calls: unknown[] = [], pending = deferred<void>();
  jest.spyOn(f.keys, 'initIframeKeys').mockImplementation(() => { calls.push('store'); return pending.promise; });
  jest.spyOn(f.keys, 'initECDHKey').mockImplementation(async () => { calls.push('ecdh'); await pending.promise; return new Uint8Array(); });
  jest.spyOn(f.keys, 'initPubKey').mockImplementation(async () => { calls.push('public'); await pending.promise; return ''; });
  jest.spyOn(f.keys, 'initCookie').mockImplementation(async scene => { calls.push(['cookie', scene]); await pending.promise; return true; });
  f.keys.setConfig({ first: [{ scene: 'one', certType: 'cookie' }, { scene: 'ignored', certType: 'cookie' }],
    second: [{ certType: 'header' }, { scene: 'also-ignored', certType: 'cookie' }], emptyScene: [{ certType: 'cookie' }], object: { certType: 'cookie' } });
  expect(f.keys.start()).toBeUndefined(); expect(calls).toEqual(['store', 'ecdh', 'public', ['cookie', 'one'], ['cookie', '']]);
  f.keys.setEnableEcdh(false); f.keys.start(); expect(calls.filter(item => item === 'ecdh')).toHaveLength(1);
  expect(calls.filter(item => item === 'store')).toHaveLength(2); pending.resolve(); await flush();
});

it.each(['sync', 'async'])('start observes %s ECDH failure without blocking public-key initialization', async mode => {
  const f = fixture(); jest.spyOn(f.keys, 'initIframeKeys').mockResolvedValue();
  jest.spyOn(f.keys, 'initECDHKey').mockImplementation(() => { if (mode === 'sync') throw Error('synthetic ECDH'); return Promise.reject(Error('synthetic ECDH')); });
  const pub = jest.spyOn(f.keys, 'initPubKey').mockResolvedValue(''); f.keys.start(); await flush(); expect(pub).toHaveBeenCalledTimes(1);
  if (mode === 'sync') expect(f.events).toContainEqual(['error', expect.objectContaining({ name: 'Pre init ECDH key' })]);
  else expect(f.background).toHaveBeenCalledWith(expect.objectContaining({ message: 'synthetic ECDH' }));
});

it('captures runtime storage settings once, without reconfiguring an existing store', async () => {
  const f = fixture(); f.keys.setContext({ storageNamespace: 'before', iframeURL: 'https://synthetic.invalid/frame', initType: 'cert', signType: 'cert' });
  f.keys.setEnableCache(false); f.keys.setCrossStorageBackURL('https://synthetic.invalid/fallback'); f.keys.setDisableCrossStorage(true); f.keys.setAgidAndHost(3, 'scope');
  f.keys.setDisableStorageSignData(true); f.keys.setUpdateKeys(true); f.keys.setAid(999);
  await f.keys.initIframeStore(); const captured = f.create.mock.calls[0]![0];
  expect(captured).toEqual(expect.objectContaining({ storageNamespace: '3_scope', enableCache: false, disableCrossStorage: true, agid: 3,
    iframeURL: 'https://synthetic.invalid/frame', iframeBackURL: 'https://synthetic.invalid/fallback', initType: 'cert', signType: 'cert', disableStorageSignData: true, updateKeys: true }));
  f.keys.setContext({}); f.keys.setStorageNamespace('after'); f.keys.setEnableCache(true); await f.keys.initIframeStore();
  expect(f.create).toHaveBeenCalledTimes(1); expect(captured.storageNamespace).toBe('3_scope'); expect(f.keys.initType).toBe('pubKey'); expect(f.keys.signType).toBe('pubKey'); expect(f.keys.aid).toBe(999);
});

it.each([1, '1'])('agid=%s preserves strict numeric zt branch and existing namespace/zt state', async agid => {
  const f = fixture(); f.document.location.hostname = 'www.douyin.com';
  f.keys.setStorageNamespace('previous'); f.keys.setAgidAndHost(agid); f.keys.setAgidAndHost(4, 'explicit');
  await f.keys.initIframeStore(); expect(f.create.mock.calls[0]![0]).toEqual(expect.objectContaining({ storageNamespace: '4_explicit', agid: 4, ztIframe: agid === 1 ? true : undefined }));
});

it('refresh waits for two deletes but preserves source key memoization, ECDH and scene ticket', async () => {
  const f = await cookieFixture(), pair = f.keys.cryptoSDK, init = f.keys._initData, gate = deferred<void>();
  await f.keyStore.setLocalItem(SIGN, JSON.stringify(f.ticket)); f.keys._signData = JSON.stringify(f.ticket); f.keys.initMatch = true;
  const original = f.keyStore.delete, deletion = jest.spyOn(f.keyStore, 'delete').mockImplementation(async key => { if (key === KEY) await gate.promise; return original(key); });
  const start = jest.spyOn(f.keys, 'start').mockImplementation(() => {}), refresh = f.keys.refresh();
  expect(f.keys._signData).toBeUndefined(); expect(deletion).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled();
  gate.resolve(); await refresh; expect(deletion.mock.calls).toEqual([[KEY], [CERT]]); expect(start).toHaveBeenCalledTimes(1);
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(JSON.stringify(f.ticket)); expect(f.keys.cryptoSDK).toBe(pair); expect(f.keys._initData).toBe(init); expect(f.keys.initMatch).toBe(true);
  expect(await f.keys.checkCryptKeys()).toBe(true); expect(f.keys.cryptoSDK).toBe(pair);
  f.keys.setStorageNamespace('new'); await f.keys.initIframeStore(); expect(f.create).toHaveBeenCalledTimes(2); expect(f.create.mock.calls[1]![0].storageNamespace).toBe('new');
});

it('refresh propagates an unguarded delete rejection and does not restart or drop store', async () => {
  const f = await cookieFixture(); jest.spyOn(f.keyStore, 'delete').mockRejectedValue(Error('synthetic deletion'));
  const start = jest.spyOn(f.keys, 'start'); await expect(f.keys.refresh()).rejects.toThrow('synthetic deletion');
  expect(start).not.toHaveBeenCalled(); await f.keys.initIframeStore(); expect(f.create).toHaveBeenCalledTimes(1);
});

it('manual explicit ticket signs with the real local pair without persisting that ticket', async () => {
  const f = await cookieFixture(), Clock = class { getTime() { return 1000; } static now() { return 1000; } };
  const pipeline = new DesktopWebSecureRequestPipeline({ Date: Clock, pageHref: 'https://synthetic.invalid' }, f.keys);
  const result = await pipeline.createTicketGuardHeaders({ signData: { ticket: 'explicit-ticket', ts_sign: 'ts.2.explicit', path: '/follow' } });
  const data = JSON.parse(Buffer.from(result.bdTicketGuardHeaders['bd-ticket-guard-client-data'] as string, 'base64').toString());
  expect(verify('sha256', Buffer.from('ticket=explicit-ticket&path=/follow&timestamp=1'), JSON.parse(f.keyText).ec_publicKey, Buffer.from(data.req_sign, 'base64'))).toBe(true);
  expect(data.ts_sign).toBe('ts.2.explicit'); expect(await f.keyStore.getLocalItem(SIGN)).toBe('');
});

it('real start launches local key creation without returning a readiness Promise', async () => {
  const f = fixture(); f.keys.setEnableEcdh(false); f.keys.setConfig({});
  expect(f.keys.start()).toBeUndefined();
  // Deliberately wait on distinct primitive diagnostics, not start's void result.
  expect(await f.keys.checkCryptKeys()).toBe(true); expect(await f.keys.checkSigningKeys()).toBe(true);
  const stored = JSON.parse(await f.keyStore.getLocalItem(KEY) as string);
  expect(await f.keys.cryptoSDK!.getKeys()).toEqual({ privateKey: stored.ec_privateKey, publicKey: stored.ec_publicKey });
  expect(f.certificate).not.toHaveBeenCalled(); expect(f.background).not.toHaveBeenCalled();
});

it('connects provider request -> response ticket -> real store -> consumer DER signature without sending HTTP', async () => {
  const f = await cookieFixture(), Clock = class { getTime() { return 1000; } static now() { return 1000; } };
  const pipeline = new DesktopWebSecureRequestPipeline({ Date: Clock, pageHref: 'https://synthetic.invalid' }, f.keys);
  const initial: DesktopWebSecureRequest = { url: '/login', headers: {} };
  const provider = pipeline.classify(initial, { web: [{ scene: 'web_protect', namespace: 'synthetic', providerPathList: ['/login'] }] });
  await pipeline.prepare(initial, provider);
  expect(initial.headers).toEqual(expect.objectContaining({ 'bd-ticket-guard-ree-public-key': f.info.b64PubKey }));
  expect(initial.headers).not.toHaveProperty('bd-ticket-guard-client-data');
  await pipeline.complete({ config: initial, headers: { 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify(f.ticket)).toString('base64') } }, provider);
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(JSON.stringify(f.ticket)); expect(await f.keyStore.getLocalItem(CERT)).toBe(f.cert);
  const request: DesktopWebSecureRequest = { url: '/follow?ignored=query', method: 'POST', body: 'ignored', headers: {} };
  const consumer = pipeline.classify(request, { web: [{ scene: 'web_protect', consumerPathList: ['/follow'] }] });
  await pipeline.prepare(request, consumer);
  const data = JSON.parse(Buffer.from((request.headers as Record<string, string>)['bd-ticket-guard-client-data']!, 'base64').toString());
  expect(data).toEqual(expect.objectContaining({ ts_sign: f.ticket.ts_sign, req_content: 'ticket,path,timestamp', timestamp: 1 }));
  expect(verify('sha256', Buffer.from(`ticket=${f.ticket.ticket}&path=/follow&timestamp=1`), JSON.parse(f.keyText).ec_publicKey, Buffer.from(data.req_sign, 'base64'))).toBe(true);
  expect(request.extras).toEqual(expect.objectContaining({ match_md5_local: '1', match_md5_iframe: '1' }));
});

it.each(['fetch', 'xhr'])('connects %s hook response persistence to the next real P256 signing request offline', async transport => {
  const f = await cookieFixture(), Clock = class { getTime() { return 1000; } static now() { return 1000; } };
  const pipeline = new DesktopWebSecureRequestPipeline({ Date: Clock, pageHref: 'https://synthetic.invalid' }, f.keys);
  const responseTicket = Buffer.from(JSON.stringify(f.ticket)).toString('base64');
  const sent: { url: string; headers: Record<string, unknown>; body: unknown }[] = [];
  const providerSent = deferred<void>(), consumerSent = deferred<void>();
  class Xhr implements DesktopWebSecureXhr {
    secureOpenArgs?: IArguments;
    readyState = 0;
    onloadend: unknown = null;
    onreadystatechange: unknown = null;
    url = '';
    headers: Record<string, unknown> = {};
    open(...args: unknown[]) { this.url = String(args[1]); }
    setRequestHeader(...args: unknown[]) { this.headers[String(args[0])] = args[1]; }
    send(...args: unknown[]) {
      sent.push({ url: this.url, headers: this.headers, body: args[0] });
      (this.url === '/login' ? providerSent : consumerSent).resolve();
    }
    getAllResponseHeaders() { return `bd-ticket-guard-server-data: ${responseTicket}`; }
  }
  const window = { XMLHttpRequest: Xhr, Request, Headers,
    fetch: async (...args: unknown[]) => {
      const init = args[1] as { headers: Record<string, unknown>; body?: unknown };
      sent.push({ url: String(args[0]), headers: init.headers, body: init.body });
      return { headers: new Headers(String(args[0]) === '/login' ? { 'bd-ticket-guard-server-data': responseTicket } : {}) };
    },
  };
  const background = jest.fn();
  const hooks = new DesktopWebSecureTransportHooks({ window, XMLHttpRequest: Xhr, Request, Headers, URL,
    location: { href: 'https://synthetic.invalid' }, onBackgroundError: background }, pipeline);
  hooks.config = { web: [{ scene: 'web_protect', namespace: 'synthetic', providerPathList: ['/login'], consumerPathList: ['/follow'] }] };
  const body = { marker: 'unchanged-body' };
  if (transport === 'fetch') await window.fetch('/login', { method: 'POST', body });
  else {
    const xhr = new Xhr(), callback = jest.fn(async () => { expect(await f.keyStore.getLocalItem(SIGN)).toBe(JSON.stringify(f.ticket)); });
    xhr.onloadend = callback; xhr.open('POST', '/login'); xhr.send(body);
    await providerSent.promise;
    xhr.readyState = 4; await (xhr.onloadend as () => Promise<unknown>)(); expect(callback).toHaveBeenCalledTimes(1);
  }
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(JSON.stringify(f.ticket));
  expect(sent[0]?.headers).toEqual(expect.objectContaining({ 'bd-ticket-guard-ree-public-key': f.info.b64PubKey }));
  expect(sent[0]?.headers).not.toHaveProperty('bd-ticket-guard-client-data');
  if (transport === 'fetch') await window.fetch('/follow?ignored=query', { method: 'POST', body });
  else {
    const xhr = new Xhr(); xhr.open('POST', '/follow?ignored=query'); xhr.send(body);
    await consumerSent.promise;
  }
  expect(sent).toHaveLength(2); expect(sent[1]?.body).toBe(body);
  const data = JSON.parse(Buffer.from(sent[1]!.headers['bd-ticket-guard-client-data'] as string, 'base64').toString());
  expect(data).toEqual(expect.objectContaining({ ts_sign: f.ticket.ts_sign, req_content: 'ticket,path,timestamp', timestamp: 1 }));
  expect(verify('sha256', Buffer.from(`ticket=${f.ticket.ticket}&path=/follow&timestamp=1`), JSON.parse(f.keyText).ec_publicKey, Buffer.from(data.req_sign, 'base64'))).toBe(true);
  expect(background).not.toHaveBeenCalled();
});

it('non-namespaced response returns before the actual scheduler write completes', async () => {
  const f = await cookieFixture(), gate = deferred<void>(), original = f.keyStore.set;
  jest.spyOn(f.keyStore, 'set').mockImplementation((key, value, sync) => key === SIGN ? gate.promise.then(() => original(key, value, sync)) : original(key, value, sync));
  const pipeline = new DesktopWebSecureRequestPipeline({ Date, pageHref: 'https://synthetic.invalid' }, f.keys);
  await pipeline.complete({ config: { url: '/login', headers: {} }, headers: { 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify(f.ticket)).toString('base64') } },
    { needProxy: true, providerConfig: { scene: 'web_protect' } });
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(''); gate.resolve(); for (let i = 0; i < 6; i++) await flush();
  expect(await f.keyStore.getLocalItem(SIGN)).toBe(JSON.stringify(f.ticket)); expect(await f.keyStore.getLocalItem(CERT)).toBe('');
});

it('diagnoses request-time and local MD5 independently without switching keys or changing initMatch', async () => {
  const f = await cookieFixture(); await f.keys.setSignValueAsync({ sign: f.ticket, scene: 'web_protect', namespace: 'synthetic' });
  const info = await f.keys.getKeysInfoWithOrigin({ scene: 'web_protect' });
  expect(await f.keys.checkSignData(info)).toEqual({ match_md5_local: '1', match_md5_iframe: '1' });
  await f.keyStore.setLocalItem(CERT, 'changed'); expect(await f.keys.checkSignData(info)).toEqual({ match_md5_local: '-99', match_md5_iframe: '1' });
  expect(f.keys.initMatch).toBe(false); expect(await f.keys.cryptoSDK!.getKeys()).toEqual({ privateKey: JSON.parse(f.keyText).ec_privateKey, publicKey: JSON.parse(f.keyText).ec_publicKey });
});

it('response Cookie repair persists asynchronously without replacing the active key pair', async () => {
  const f = await cookieFixture(), pair = await f.crypto.generateNewKeyPairPEM(), text = record(pair), sign = JSON.stringify(f.ticket);
  expect(f.keys.setKeysAndValues([KEY, CERT, SIGN], [text, f.cert, sign])).toBeUndefined(); for (let i = 0; i < 6; i++) await flush();
  expect(await f.keyStore.getLocalItem(KEY)).toBe(text); expect(f.keyStore.cookieOperate.getCookie(DIGEST)).toBe(createDesktopWebSecureCookieDigest(text, f.cert, sign));
  expect(await f.keys.cryptoSDK!.getKeys()).toEqual({ privateKey: JSON.parse(f.keyText).ec_privateKey, publicKey: JSON.parse(f.keyText).ec_publicKey });
});
