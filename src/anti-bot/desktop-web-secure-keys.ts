import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';
import { DesktopWebSecureSystemCrypto } from './desktop-web-secure-crypto.js';
import { DESKTOP_WEB_SECURE_INIT_KEYS, type DesktopWebSecureKeyStore } from './desktop-web-secure-key-store.js';
import type { DesktopWebSecureServerCertificates } from './desktop-web-secure-server-certificate.js';
import { isDesktopWebSecureModernBrowser, type DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';
import { createDesktopWebSecureCookieDigest, desktopWebSecureCookieDomain, readDesktopWebSecureCookie, verifyDesktopWebSecureCookie } from './desktop-web-secure-cookie.js';

const [CRYPT_KEY, CERT_KEY, WEB_SIGN_KEY] = DESKTOP_WEB_SECURE_INIT_KEYS;
const CRYPT_COOKIE = '_bd_ticket_crypt_cookie';
const SERVER_COOKIE = 'bd_ticket_guard_server_data';
const DOMAIN_COOKIE = 'bd_ticket_guard_web_domain';

interface CryptRecord { ec_privateKey?: unknown; ec_publicKey?: unknown; ec_csr?: unknown }
export interface DesktopWebSecureKeysInfo {
  crypt?: CryptRecord;
  cryptData?: unknown;
  cert?: unknown;
  sign?: { ticket?: unknown; ts_sign?: unknown; client_cert?: unknown };
  b64Cert?: string;
  b64PubKey?: string;
  b64Csr?: string;
  serverData?: unknown;
  dataFrom?: string;
  items?: unknown[];
  getKeysInfoTime?: number;
  cacheEnabled?: boolean;
}
export interface DesktopWebSecureScene { certType?: 'header' | 'cookie'; scene: string }
export interface DesktopWebSecureSignInput extends DesktopWebSecureScene {
  keysInfo: DesktopWebSecureKeysInfo;
  sign_data?: string;
  req_content?: string;
  timestamp?: number;
  isNewCert?: boolean;
}
export interface DesktopWebSecureSignedData {
  result: string;
  times: { calTime: number; ecdhTime?: number; hmacTime?: number };
  algoType: 'hmac' | 'ecdsa';
}
export interface DesktopWebSecureKeysSettings {
  disableCrossStorage?: boolean | undefined;
  updateKeys?: boolean | undefined;
  storageNamespace?: string | undefined;
  iframeBackURL?: string | undefined;
  iframeURL?: string | undefined;
  signType?: 'pubKey' | 'cert' | undefined;
  initType?: 'pubKey' | 'cert' | undefined;
  disableStorageSignData?: boolean | undefined;
}
/** Snapshot passed when constructing a new store; later setters do not mutate an existing store. */
export interface DesktopWebSecureKeysStoreSettings extends DesktopWebSecureKeysSettings {
  agid: number | string | undefined;
  ztIframe: boolean | undefined;
  enableCache: boolean;
}
export interface DesktopWebSecureKeysContext {
  readonly crypto: DesktopWebSecureSystemCrypto;
  readonly certificates: Pick<DesktopWebSecureServerCertificates, 'get'>;
  readonly Date: { new(): { getTime(): number }; now(): number };
  readonly performance?: { now(): number };
  readonly browser?: Pick<DesktopStorageIframeContext, 'navigator' | 'window'>;
  /** Same browser document as KeyStore; supplies He's independent first-cookie fallback. */
  readonly document?: { readonly cookie: string; readonly location?: { readonly hostname: string } };
  createKeyStore?(settings: DesktopWebSecureKeysStoreSettings): DesktopWebSecureKeyStore;
  onBackgroundError?(error: unknown): void;
}

/** nr's key ownership/pipeline, without the misleading verify/comparePubKey constant-true stubs. */
class WebSecureKeyPair {
  readonly pipeline: Promise<unknown>;
  private privateKey: unknown;
  private publicKey: unknown;
  constructor(private readonly crypto: DesktopWebSecureSystemCrypto, private readonly clock: { now(): number }, keys: { privateKey?: unknown; publicKey?: unknown }) {
    if (keys.privateKey && keys.publicKey) {
      this.privateKey = keys.privateKey; this.publicKey = keys.publicKey; this.pipeline = Promise.resolve(null);
    } else {
      this.pipeline = this.crypto.generateNewKeyPairPEM().then(pair => { this.privateKey = pair.privatePem; this.publicKey = pair.publicPem; });
    }
  }
  getKeys = (): Promise<{ privateKey: unknown; publicKey: unknown }> => this.pipeline.then(() => ({ privateKey: this.privateKey, publicKey: this.publicKey }));
  sign = (text: string) => this.pipeline.then(() => this.crypto.signWithECDSA((this.privateKey || '') as string, text));
  signWithHmac = async (text: string, key: Uint8Array): Promise<{ result: string; times: { hmacTime: number } }> => {
    if (!this.privateKey) throw new Error('private key is empty');
    await this.pipeline; this.clock.now(); const start = this.clock.now();
    const result = await this.crypto.hmacSha256(key, text);
    return { result, times: { hmacTime: this.clock.now() - start } };
  };
  getCSR = (): string => ''; // Source nr has no CSR generator. Never interpret this as a client certificate.
}

/**
 * Rr key initialization subsystem. Source lifecycle true can contain invalid PEM,
 * absent persistence or a still-running replacement key pair; use checkSigningKeys
 * separately. start/refresh preserve the source's detached work and incomplete invalidation;
 * neither is an authenticated Session runtime or a safe account reset operation.
 */
export class DesktopWebSecureKeys extends DesktopWebSecureEvents {
  private _storeSDK: DesktopWebSecureKeyStore | undefined;
  private _cryptData: string | undefined;
  private _cryptObject: CryptRecord | null | undefined;
  /** Raw initialization input for later Rr consumers; may contain private keys. Never log this. */
  _initData: Record<string, unknown> = {};
  private _ecdh_key: Uint8Array | undefined;
  private _hasProcessServerData = false;
  /** Cache fingerprint match only, never a certificate trust or Session readiness signal. */
  initMatch = false;
  cryptoSDK: WebSecureKeyPair | undefined;
  private readonly scheduler: SignValueScheduler;
  /** Raw scene ticket snapshot, not proof of storage or authentication. Never log it. */
  _signData: string | undefined;
  private storageNamespace: string | undefined;
  private disableStorageSignData: boolean;
  private disableCrossStorage: boolean | undefined;
  private iframeURL: string | undefined;
  private iframeBackURL: string | undefined;
  private agid: number | string | undefined;
  private ztIframe: boolean | undefined;
  updateKeys: boolean | undefined;
  config: Record<string, unknown> | undefined;
  enableEcdh = true;
  enableCache = true;
  signType: 'pubKey' | 'cert' = 'pubKey';
  aid: number | string | undefined;
  initType: 'pubKey' | 'cert';

  constructor(private readonly context: DesktopWebSecureKeysContext, options: { aid?: number; initType?: 'pubKey' | 'cert'; storageNamespace?: string; disableStorageSignData?: boolean } = {}) {
    super(); this.aid = options.aid ?? 0; this.initType = options.initType ?? 'pubKey';
    this.storageNamespace = options.storageNamespace; this.disableStorageSignData = options.disableStorageSignData ?? false;
    this.scheduler = new SignValueScheduler(error => this.backgroundError(error));
  }

  setType = ({ initType = 'pubKey', signType = 'pubKey' }: Pick<DesktopWebSecureKeysSettings, 'initType' | 'signType'>): void => { this.initType = initType; this.signType = signType; };
  setDisableStorageSignData = (value: boolean): void => { this.disableStorageSignData = value; };
  setCrossStorageURL = (value: string): void => { this.iframeURL = value; };
  setCrossStorageBackURL = (value: string): void => { this.iframeBackURL = value; };
  setDisableCrossStorage = (value: boolean): void => { this.disableCrossStorage = value; };
  setStorageNamespace = (value: string): void => { this.storageNamespace = value; };
  setAgidAndHost = (agid: number | string, host?: string): void => {
    this.agid = agid;
    if (host) this.storageNamespace = `${agid}_${host}`;
    else {
      const domain = desktopWebSecureCookieDomain(() => this.context.document!.location!.hostname);
      if (agid !== 1 || domain !== 'douyin.com') this.storageNamespace = `${agid}_${domain.split('.')[0] || 'default'}`;
      else this.ztIframe = true;
    }
  };
  setUpdateKeys = (value: boolean): void => { this.updateKeys = value; };
  setConfig = (value: Record<string, unknown>): void => { this.config = value; };
  setAid = (value: number | string | undefined): void => { this.aid = value; };
  isTopBrowser = (): boolean => isDesktopWebSecureModernBrowser(this.context.browser!);
  setEnableCache = (value: boolean): void => { this.enableCache = value; };
  setEnableEcdh = (value: boolean): void => { this.enableEcdh = value; };
  setContext = ({ disableCrossStorage = false, updateKeys = false, storageNamespace, iframeBackURL, iframeURL,
    signType = 'pubKey', initType = 'pubKey', disableStorageSignData = false }: DesktopWebSecureKeysSettings): void => {
    this.signType = signType; this.initType = initType; this.disableCrossStorage = disableCrossStorage;
    this.storageNamespace = storageNamespace; this.iframeBackURL = iframeBackURL; this.iframeURL = iframeURL;
    this.updateKeys = updateKeys; this.disableStorageSignData = disableStorageSignData;
  };
  /** Rr.start: launches work synchronously; no readiness promise or deduplication. */
  start = (): void => {
    this.observe(this.initIframeKeys());
    if (this.enableEcdh) try { this.observe(this.initECDHKey()); } catch (error) { this.reportError(error, 'Pre init ECDH key'); }
    this.observe(this.initPubKey());
    Object.keys(this.config || {}).forEach(name => {
      const entries = this.config?.[name], first = Array.isArray(entries) && entries.length > 0 && entries[0] || {};
      const { scene = '', certType } = first;
      if (certType === 'cookie') this.observe(this.initCookie(scene));
    });
  };
  /** Source refresh deletes key/cert only. Not logout, ticket rotation or full cache invalidation. */
  refresh = async (): Promise<void> => {
    this._cryptData = undefined; this._cryptObject = undefined; this._signData = undefined;
    await this._storeSDK?.delete(CRYPT_KEY);
    await this._storeSDK?.delete(CERT_KEY);
    this._storeSDK = undefined;
    return this.start();
  };

  initIframeStore = async (): Promise<void> => {
    if (this._storeSDK) return;
    const store = this.context.createKeyStore?.({ agid: this.agid, ztIframe: this.ztIframe, enableCache: this.enableCache,
      disableCrossStorage: this.disableCrossStorage, storageNamespace: this.storageNamespace, iframeURL: this.iframeURL,
      iframeBackURL: this.iframeBackURL, disableStorageSignData: this.disableStorageSignData, updateKeys: this.updateKeys,
      signType: this.signType, initType: this.initType });
    if (!store) return;
    this._storeSDK = store;
    for (const event of ['error', 'load', 'execute', 'log']) store.on(event, value => { this.emit(event, value); });
  };

  // As in Rr, awaiting this does not wait for key restoration/generation.
  initIframeKeys = async (): Promise<void> => {
    await this.initIframeStore(); this.observe(this.checkCryptKeys());
  };

  checkCryptKeys = rememberTruthy(async (): Promise<boolean> => {
    try {
      const data = await this._storeSDK?.getItems([...DESKTOP_WEB_SECURE_INIT_KEYS]), text = data && data[DESKTOP_WEB_SECURE_INIT_KEYS[0]];
      this._initData = data || {};
      if (text && typeof text === 'string') {
        try {
          const parsed = JSON.parse(text) as CryptRecord | null, { ec_privateKey: privateKey, ec_publicKey: publicKey, ec_csr: csr } = parsed || {};
          if (!privateKey || !publicKey || (this.initType === 'cert' && !csr)) {
            this._initData = {}; this.emit('load', { action: 'keys', op: 'check', status: 'fail' });
            return await this.initCert();
          }
          this.cryptoSDK = this.makePair({ privateKey, publicKey }); await this.cryptoSDK.pipeline;
          this._cryptObject = parsed; this._cryptData = text;
          this.emit('load', { action: 'sdk', op: 'init', duration: this.performanceTime(), status: 'success' }); return true;
        } catch (error) {
          this.emit('load', { action: 'keys', op: 'check', status: 'fail' });
          this.emit('error', { error, name: 'check crypt data error' }); this._initData = {};
          return await this.initCert();
        }
      }
      const result = await this.initCert();
      this.emit('load', { action: 'sdk', op: 'init', duration: this.performanceTime(), status: 'success' }); return result;
    } catch (error) {
      this.emit('load', { action: 'sdk', op: 'init', status: 'fail' }); this.reportError(error, 'check_crypt_keys_error'); return false;
    }
  });

  initPubKey = rememberTruthy(async (): Promise<string | undefined> => {
    await this.checkCryptKeys();
    const { privateKey, publicKey } = await this.cryptoSDK?.getKeys() || {};
    if (privateKey && publicKey) {
      const { rawHex } = await this.context.crypto.extractPublicKeyHexFromPem(publicKey as string);
      return base64Hex(rawHex);
    }
    return undefined;
  });

  initECDHKey = rememberTruthy(async (): Promise<Uint8Array> => {
    if (this._ecdh_key) return this._ecdh_key;
    await this.checkCryptKeys();
    const { cert } = await this.context.certificates.get(this.aid || 0, true);
    const { privateKey, publicKey } = await this.cryptoSDK?.getKeys() || {};
    if (!privateKey || !publicKey) return new Uint8Array();
    this._ecdh_key = (await this.context.crypto.deriveEcdhKey(privateKey as string, cert as string)).bytes;
    return this._ecdh_key;
  });

  /** Explicit real sign/verify probe; doesn't repair, delete, persist or bind anything. */
  async checkSigningKeys(): Promise<boolean> {
    const { privateKey, publicKey } = await this.cryptoSDK?.getKeys() || {};
    return typeof privateKey === 'string' && typeof publicKey === 'string' && this.context.crypto.validateKeyPair(privateKey, publicKey);
  }

  getCookieCryptStatus(): boolean { return !!this._storeSDK?.cookieOperate.getCookie(CRYPT_COOKIE); }
  getIframeStatus(): boolean | undefined { return this._storeSDK?.getIframeStatus(); }
  getStorageStatus(): ReturnType<DesktopWebSecureKeyStore['getStorageStatus']> { return this._storeSDK?.getStorageStatus(); }
  /** This owner currently uses only the system WebCrypto provider, not the optional fallback bundle. */
  async getUsage(): Promise<'system'> { return 'system'; }
  async checkSignData(info: DesktopWebSecureKeysInfo | null | undefined): Promise<{ match_md5_local: string; match_md5_iframe: string }> {
    try {
      const cookie = this._storeSDK?.cookieOperate.getCookie(CRYPT_COOKIE) || '';
      if (!cookie) return { match_md5_local: '-99', match_md5_iframe: '-99' };
      const { cryptData, cert, serverData } = info || {};
      const match = verifyDesktopWebSecureCookie(cookie, cryptData, cert, serverData);
      const local = await this._storeSDK?.getLocalItems([...DESKTOP_WEB_SECURE_INIT_KEYS]);
      return { match_md5_local: verifyDesktopWebSecureCookie(cookie, local?.[CRYPT_KEY], local?.[CERT_KEY], local?.[WEB_SIGN_KEY]) ? '1' : '-99', match_md5_iframe: match ? '1' : '-99' };
    } catch (error) { this.emit('error', { error, name: 'check sign data error' }); }
    return { match_md5_local: '-99', match_md5_iframe: '-99' };
  }

  /** Actual Rr request getter. Its first Cookie init intentionally receives no scene. */
  async getKeysInfoWithOrigin({ certType, scene }: DesktopWebSecureScene): Promise<DesktopWebSecureKeysInfo> {
    const start = this.context.Date.now(), times = { current: start, check: 0, wait: 0, get: 0, parse: 0 };
    try {
      await this.checkCryptKeys();
      times.check = this.context.Date.now() - times.current; times.current = this.context.Date.now();
      if (certType === 'cookie') { await this.initCookie(); await this.processServerCookie(scene); }
      else if (certType === 'header') await this.scheduler?.wait(); // Native wait returns void, NOT a drain barrier.
      times.wait = this.context.Date.now() - times.current; times.current = this.context.Date.now();
      const response = await this._storeSDK?.getItemsWithOrigin([DESKTOP_WEB_SECURE_INIT_KEYS[0], DESKTOP_WEB_SECURE_INIT_KEYS[1], `s_sdk_sign_data_key/${scene}`]);
      times.get = this.context.Date.now() - times.current; times.current = this.context.Date.now();
      if (!response) { this.emit('log', { content: 'get keysinfo fail', level: 'error' }); return {}; }
      const { data = {}, from = '0' } = response, items = Object.values(data);
      const { value: cryptData = '' } = data[DESKTOP_WEB_SECURE_INIT_KEYS[0]] || {};
      const { ec_privateKey, ec_publicKey, ec_csr } = JSON.parse((cryptData || '{}') as string) || {};
      const serverData = data[`s_sdk_sign_data_key/${scene}`]?.value || '', cert = data[DESKTOP_WEB_SECURE_INIT_KEYS[1]]?.value || '';
      const { ticket, ts_sign, client_cert, log_id = '' } = JSON.parse((serverData || '{}') as string) || {};
      const b64PubKey = await this.publicKeyBase64(ec_privateKey, ec_publicKey) || '';
      times.parse = this.context.Date.now() - times.current;
      this.emit('log', { extra: { log_id, ts_sign: redact(ts_sign) }, content: 'get keysinfo success', level: 'info' });
      return { crypt: { ec_privateKey, ec_publicKey }, cryptData, cert, sign: { ticket, ts_sign, client_cert },
        b64Cert: encodeText((cert || '') as string), b64PubKey, b64Csr: encodeText(ec_csr || ''), serverData,
        dataFrom: from, items, getKeysInfoTime: this.context.Date.now() - start || 0, cacheEnabled: this._storeSDK?.memoryCache.isEnabled() || false };
    } catch (error) { this.reportError(error, 'Get Ticket catch'); return {}; }
  }

  async signWithKeysInfo(input: DesktopWebSecureSignInput): Promise<DesktopWebSecureSignedData | null> {
    const { sign_data, req_content, timestamp, certType, scene, keysInfo, isNewCert = true } = input;
    try {
      await this.checkCryptKeys();
      if (certType === 'cookie') { await this.initCookie(); await this.processServerCookie(scene || ''); }
      if (certType === 'header') await this.scheduler?.wait();
      const { sign, crypt } = keysInfo;
      if (!sign) { this.emit('log', { content: 'sign data fail', level: 'info', extra: { content: 'sign data is null' } }); return null; }
      const { ticket, ts_sign } = sign;
      if (!sign_data && !ticket) { this.emit('log', { content: 'sign data fail', level: 'info', extra: { content: 'sign data and ticket is null' } }); return null; }
      this.cryptoSDK = this.makePair({ privateKey: crypt?.ec_privateKey, publicKey: crypt?.ec_publicKey });
      let req_sign = '', hmac = this.enableEcdh && isNewCert;
      const started = this.context.Date.now(), times: { ecdhTime?: number; hmacTime?: number } = {};
      if (hmac) {
        try {
          const start = this.context.Date.now(), key = this._ecdh_key || await this.initECDHKey();
          times.ecdhTime = this.context.Date.now() - start;
          const signed = await this.cryptoSDK!.signWithHmac((sign_data || ticket) as string, key);
          req_sign = signed.result; Object.assign(times, signed.times);
        } catch (error) {
          hmac = false; this.emit('log', { level: 'error', content: 'sign with hmac failed', extra: { message: (error as Error | undefined)?.message || '' } });
        }
      }
      if (!hmac) req_sign = base64Hex((await this.cryptoSDK!.sign((sign_data || ticket) as string)).hex || '');
      const calTime = this.context.Date.now() - started;
      const envelope = { ts_sign, req_content: req_content || sign_data || ticket, req_sign, timestamp: timestamp || Math.floor(new this.context.Date().getTime() / 1000) };
      this.emit('log', { extra: { ts_sign: redact(ts_sign) }, content: 'sign data success', level: 'info' });
      return { result: encodeText(JSON.stringify(envelope) || ''), times: { calTime, ...times }, algoType: hmac ? 'hmac' : 'ecdsa' };
    } catch (error) {
      // Deliberate credential redaction; do not reproduce the source's ticket/CSR/certificate log leak.
      this.emit('log', { extra: { sign_data: redact(sign_data || ''), req_content: redact(req_content || ''), certType: certType || '', scene: scene || '',
        csr: redact(keysInfo?.crypt?.ec_csr || ''), cert: redact(keysInfo.cert || ''), sign: redact(keysInfo.sign?.ticket || '') }, content: 'sign data with keys Info is error', level: 'error' });
      this.reportError(error, 'sign error'); return null;
    }
  }

  setSignValue = (input: { sign: unknown; scene: string; namespace?: string; logCtx?: { url: string; logId: unknown } }): boolean => {
    try {
      if (typeof input.sign !== 'string' && typeof input.sign !== 'object') return false;
      const text = this.signText(input.sign);
      this.scheduler?.provider(() => this.signValueWithIframe(text as string, input.scene, input.namespace)); return true;
    } catch (error) { this.reportError(error, 'set signValue Error'); return false; }
  };
  async setSignValueAsync(input: { sign: unknown; scene: string; namespace?: string; logCtx?: { url: string; logId: unknown } }): Promise<boolean> {
    try {
      if (typeof input.sign !== 'string' && typeof input.sign !== 'object') return false;
      await this.signValueWithIframe(this.signText(input.sign) as string, input.scene, input.namespace); return true; // Source ignores inner false.
    } catch (error) { this.reportError(error, 'set signValue Error'); return false; }
  }
  async clearSignData(scene: string): Promise<boolean> {
    try {
      await this._storeSDK?.delete(`s_sdk_sign_data_key/${scene}`); this._signData = '';
      if (this.storageNamespace) await this._storeSDK?.delete(DESKTOP_WEB_SECURE_INIT_KEYS[1]); return true;
    } catch { return false; }
  }

  b642str(text: string): string { return this.signText(text) as string; }
  /** Response-side Cookie repair is detached and does not rebuild in-memory keys or prove persistence. */
  setKeysAndValues(keys: string[], values: unknown[]): void {
    let crypt: unknown = '', cert: unknown = '', sign: unknown = '';
    const pending = this._storeSDK?.setItems(keys, values, 2).then(() => {
      keys.forEach((key, index) => { if (key === CRYPT_KEY) crypt = values[index]; else if (key === CERT_KEY) cert = values[index]; else if (key === WEB_SIGN_KEY) sign = values[index]; });
      const digest = createDesktopWebSecureCookieDigest(crypt, cert, sign);
      if (digest) this._storeSDK?.cookieOperate.setCookieWithDomain(CRYPT_COOKIE, digest);
      this.emit('log', { extra: { md5: redact(digest), md5Cookie: redact(this._storeSDK?.cookieOperate.getCookie(CRYPT_COOKIE) || '') }, content: 'generate crypt key success sign success', level: 'info' });
    }).catch(error => { this.emit('error', { error, name: 'update keys when sign error' }); });
    if (pending) this.observe(pending);
  }

  private async signValueWithIframe(text: string, scene: string, namespace?: string): Promise<boolean> {
    try {
      const { client_cert } = JSON.parse(text) || {};
      if (!this.disableStorageSignData) await this._storeSDK?.set(`s_sdk_sign_data_key/${scene}`, text, true);
      this._signData = text;
      if ((namespace || this.storageNamespace) && client_cert) await this._storeSDK?.set(DESKTOP_WEB_SECURE_INIT_KEYS[1], client_cert, true);
      if (scene === 'web_protect') this._storeSDK?.cookieOperate.setCookieWithDomain('_bd_ticket_crypt_cookie', createDesktopWebSecureCookieDigest(this._cryptData, client_cert, text));
      return true;
    } catch (error) { this.reportError(error, 'sign value error'); return false; }
  }
  private signText(sign: unknown): string | undefined {
    if (typeof sign === 'string') return new TextDecoder().decode(Uint8Array.from(atob(sign), char => char.charCodeAt(0)));
    if (typeof sign === 'object') return JSON.stringify(sign);
    return undefined;
  }
  private async publicKeyBase64(privateKey: unknown, publicKey: unknown): Promise<string> {
    if (publicKey) return base64Hex((await this.context.crypto.extractPublicKeyHexFromPem(publicKey as string)).rawHex);
    if (privateKey) return base64Hex((await this.context.crypto.extractPublicKeyFromPrivateKey(privateKey as string)).rawHex);
    return '';
  }
  /** We caches the first successful lifecycle, even when an inner operation returned false. */
  initCookie = rememberTruthy(async (scene?: string): Promise<boolean> => {
    try { await this.processServerCookie(scene); await this.processCookie(); return true; }
    catch (error) { this.reportError(error, 'Init Cookie Error'); return false; }
  });

  async processCookie(): Promise<void> {
    try {
      await this.checkCryptKeys();
      if (!this._hasProcessServerData || this.initType === 'pubKey') await this.checkCookieMd5();
      this._storeSDK?.startStorageChecker?.(); // Native does not await this checker.
      const { ec_privateKey, ec_publicKey, ec_csr } = this._cryptObject || {};
      if ((this.initType === 'cert' && !ec_csr) || !ec_privateKey) return;
      const publicKey = await this.publicKeyBase64(ec_privateKey, ec_publicKey);
      const fields = this.initType === 'cert' ? { 'bd-ticket-guard-client-csr': ec_csr || '' }
        : { 'bd-ticket-guard-ree-public-key': publicKey, 'bd-ticket-guard-web-version': 2 };
      const value = encodeText(JSON.stringify({ 'bd-ticket-guard-version': 2, 'bd-ticket-guard-iteration-version': 1, ...fields }));
      this._storeSDK?.cookieOperate.deleteAllCookie('bd_ticket_guard_client_data');
      this._storeSDK?.cookieOperate.setCookieWithDomain('bd_ticket_guard_client_data', value);
      this._storeSDK?.cookieOperate.setCookieWithDomain('bd_ticket_guard_client_web_domain', '2');
      this.emit('execute', { action: 'cookie', op: 'setItem', status: 'success', ctx: { type: 'client' } });
    } catch (error) {
      this.emit('log', { extra: { err: String(error), cookie: redact(this._storeSDK?.cookieOperate.getCookie('bd_ticket_guard_client_data') || '') }, content: 'process cookie fail', level: 'error' });
      this.reportError(error, 'Process Cookie Error');
      this.emit('execute', { action: 'cookie', op: 'setItem', status: 'fail', ctx: { type: 'client' } });
    }
  }

  async checkCookieMd5(): Promise<false | void> {
    try {
      const cookie = this._storeSDK?.cookieOperate.getCookie(CRYPT_COOKIE) || '';
      if (!cookie) return false;
      if (verifyDesktopWebSecureCookie(cookie, this._cryptData, this._initData[CERT_KEY], this._initData[WEB_SIGN_KEY])) {
        this.syncCookieMatch('1', [this._cryptData || '', this._initData[CERT_KEY] || '', this._initData[WEB_SIGN_KEY] || '']); return;
      }
      const local = await this._storeSDK?.getLocalItem(CRYPT_KEY);
      if (verifyDesktopWebSecureCookie(cookie, local, this._initData?.[CERT_KEY] || '', this._initData?.[WEB_SIGN_KEY] || '')) {
        const values = [local || '', this._initData[CERT_KEY] || '', this._initData[WEB_SIGN_KEY] || ''];
        this.processCryptData(local, 'check cookie md5 error'); this.syncCookieMatch('2', values); return;
      }
      const data = await this._storeSDK?.getLocalItems([...DESKTOP_WEB_SECURE_INIT_KEYS]);
      if (verifyDesktopWebSecureCookie(cookie, data?.[CRYPT_KEY], data?.[CERT_KEY], data?.[WEB_SIGN_KEY])) {
        const values = [data?.[CRYPT_KEY], data?.[CERT_KEY], data?.[WEB_SIGN_KEY]];
        this.processCryptData(data?.[CRYPT_KEY] || '', 'check cookie md5 error'); this.syncCookieMatch('3', values); return;
      }
      this.emit('load', { action: 'cookie', op: 'process', status: 'fail' });
    } catch (error) { this.emit('error', { error, name: 'check cookie md5 fail' }); }
  }

  private syncCookieMatch(type: '1' | '2' | '3', values: unknown[]): void {
    const keys = [...DESKTOP_WEB_SECURE_INIT_KEYS];
    const pending = this._storeSDK?.loadIframePromise?.then(() => this._storeSDK?.setItems(keys, values, 2).then(result => {
      const { cross = '0' } = result || {};
      return this._storeSDK?.getItems(keys).then(data => {
        const cookie = this._storeSDK?.cookieOperate.getCookie(CRYPT_COOKIE) || '';
        const correct = verifyDesktopWebSecureCookie(cookie, data?.[CRYPT_KEY], data?.[CERT_KEY], data?.[WEB_SIGN_KEY]);
        this.emit('load', { action: 'cookie', op: 'process', status: 'success', ctx: { type, scene: 'callback', correct: correct ? '1' : '0', cross } });
      });
    })).catch(error => {
      this.emit('load', { action: 'cookie', op: 'process', status: 'fail', ctx: { type, scene: 'callback' } });
      this.emit('error', { error, name: 'async data fail' });
    });
    if (pending) this.observe(pending); // Observe observer failures; do not wait or force iframe connection.
    this.emit('load', { action: 'cookie', op: 'process', status: 'success', ctx: { type } }); this.initMatch = true;
  }

  private processCryptData(text: unknown, name?: string): void {
    try {
      if (!text || typeof text !== 'string') return;
      const parsed = JSON.parse(text) as CryptRecord | null, { ec_privateKey, ec_publicKey } = parsed || {};
      this._cryptData = text; this._initData[CRYPT_KEY] = text; this._cryptObject = parsed;
      this.cryptoSDK = this.makePair({ privateKey: ec_privateKey, publicKey: ec_publicKey });
      // Rr neither awaits the new pipeline nor clears We/ECDH/public-key caches here.
    } catch (error) { this.emit('error', { error, name: name || 'process crypt data error' }); }
  }

  /** Source Cookie import; true includes no data or failed key match. NOT authenticated acceptance. */
  async processServerCookie(scene?: string): Promise<boolean> {
    try {
      await this.checkCryptKeys();
      const first = this._storeSDK?.cookieOperate.getCookie(SERVER_COOKIE) || '';
      const fallback = readDesktopWebSecureCookie(() => this.context.document?.cookie || '', SERVER_COOKIE) || '';
      if (first || fallback) this.emit('log', { extra: { equal: first === fallback ? '1' : '0', s1: first ? '1' : '0', s2: fallback ? '1' : '0' }, content: 'get_cookie_two', level: 'info' });
      const input = first || fallback, domain = this._storeSDK?.cookieOperate.getCookie(DOMAIN_COOKIE) || '';
      if (domain) {
        this.emit('execute', { op: 'check', action: 'server_data', status: 'success', ctx: { server: input ? '1' : '0', server2: fallback ? '1' : '0', domain } });
        this._storeSDK?.cookieOperate.setCookieWithDomain('_bd_ticket_crypt_doamin', domain); // Installed source spelling.
      }
      if (input) {
        const start = new this.context.Date().getTime(), text = this.signText(decodeURIComponent(input)) as string;
        const { client_cert } = JSON.parse(text) || {}, keys = [`s_sdk_sign_data_key/${scene}`], values: unknown[] = [text];
        if (client_cert) {
          this._initData[CERT_KEY] = client_cert; keys.push(CERT_KEY); values.push(client_cert);
          const certificateMatches = await this.matchesCertificate(this._cryptData, client_cert);
          const publicMatches = await this.matchesPublicTicket(this._cryptData, client_cert); // Always evaluated, even after a cert match.
          if (!certificateMatches && !publicMatches) {
            const local = await this._storeSDK?.getLocalItem(CRYPT_KEY);
            const localCertificateMatches = await this.matchesCertificate(local, client_cert);
            const localPublicMatches = await this.matchesPublicTicket(local, client_cert);
            if (local && (localCertificateMatches || localPublicMatches)) {
              keys.push(CRYPT_KEY); values.push(local); this.processCryptData(local, 'process local server cert error');
              const before = new this.context.Date().getTime(), digest = createDesktopWebSecureCookieDigest(local, client_cert, text);
              if (digest) this._storeSDK?.cookieOperate.setCookieWithDomain(CRYPT_COOKIE, digest);
              const after = new this.context.Date().getTime();
              this.emit('log', { extra: { md5: redact(digest), md5Cookie: redact(this._storeSDK?.cookieOperate.getCookie(CRYPT_COOKIE) || ''), duration: after - before }, content: 'generate keys info success local', level: 'info' });
              this.emit('load', { action: 'cookie', op: 'check', status: 'success', ctx: { type: 'local' } });
            } else {
              this.emit('load', { action: 'cookie', op: 'check', status: 'fail', ctx: { type: 'local', local: local ? '1' : '0', localCorrect: localCertificateMatches ? '1' : '0' } });
              this.emit('log', { content: 'generate keys info success fail', level: 'info', extra: { csr: redact(this._cryptObject?.ec_csr || ''), pub: redact(this._cryptObject?.ec_publicKey || ''), cert: redact(client_cert || '') } });
            }
          } else {
            if (this._cryptData) { keys.push(CRYPT_KEY); values.push(this._cryptData); }
            const digest = createDesktopWebSecureCookieDigest(this._cryptData, client_cert, text);
            if (digest) this._storeSDK?.cookieOperate.setCookieWithDomain(CRYPT_COOKIE, digest);
            this.emit('log', { extra: { md5: redact(digest), md5Cookie: redact(this._storeSDK?.cookieOperate.getCookie(CRYPT_COOKIE) || '') }, content: 'gen keys cookie', level: 'info' });
            this.emit('load', { action: 'cookie', op: 'check', status: 'success', ctx: { type: 'init' } });
          }
        }
        await this._storeSDK?.setItems(keys, values); // Native persists even after both key matches fail.
        this._storeSDK?.cookieOperate.deleteAllCookie(SERVER_COOKIE);
        if (domain) this._storeSDK?.cookieOperate.deleteAllCookie(DOMAIN_COOKIE);
        try {
          const { ts_sign = '', log_id = '' } = JSON.parse(text || '{}') || {};
          this.emit('log', { extra: { ts_sign: redact(ts_sign), log_id }, content: 'process server cookie', level: 'info' });
        } catch { /* Source treats this reporting failure as nonfatal. */ }
        const deleteStatus = this._storeSDK?.cookieOperate.getCookie(SERVER_COOKIE) ? '0' : '1', end = new this.context.Date().getTime();
        this.emit('execute', { action: 'cookie', op: 'setItem', status: 'success', duration: end > start ? end - start : 0, ctx: { type: 'server', deleteStatus } });
        try {
          this._storeSDK?.cookieOperate.setCookieWithDomain('__security_server_data_status', '1');
          this.emit('execute', { action: 'cookie', op: 'process', status: 'success' });
        } catch {
          this.emit('execute', { action: 'cookie', op: 'process', status: 'fail' }); this.emit('log', { content: 'set process server cookie error', level: 'error' });
        }
        this._hasProcessServerData = true;
      } else if (domain) {
        this._storeSDK?.cookieOperate.deleteAllCookie(DOMAIN_COOKIE);
        this.emit('log', { content: 'process_web_domain', level: 'info', extra: { cookie: redact(this.context.document?.cookie || ''), domain: this._storeSDK?.cookieOperate.getCookie(DOMAIN_COOKIE) || '' } });
      }
      return true;
    } catch (error) {
      this.emit('log', { extra: { cookie: redact(this.context.document?.cookie) }, content: 'Process server Cookie Error', level: 'error' });
      this.reportError(error, 'process server cookie Error');
      this.emit('execute', { action: 'cookie', op: 'setItem', status: 'fail', ctx: { type: 'server' } }); return false;
    }
  }

  private async matchesCertificate(text: unknown, certificate: unknown): Promise<boolean> {
    try {
      if (!text || !certificate || typeof text !== 'string') return false;
      const parsed = JSON.parse(text), spki = await this.context.crypto.extractPublicKeyFromX509Cert(certificate as string);
      // je compares SPKI HEX to the stored field, not PEM to PEM. Do not silently fix this source quirk.
      return Array.from(spki, byte => byte.toString(16).padStart(2, '0')).join('') === (parsed || {}).ec_publicKey;
    } catch { return false; }
  }
  private async matchesPublicTicket(text: unknown, certificate: unknown): Promise<boolean> {
    try {
      if (!text || !certificate || typeof text !== 'string') return false;
      const { ec_privateKey, ec_publicKey } = JSON.parse(text) || {};
      return await this.publicKeyBase64(ec_privateKey, ec_publicKey) === (certificate as string).split('.')[1];
    } catch { return false; }
  }

  private async initCert(): Promise<boolean> {
    try {
      const generated = await this.generateCertificatePem(), old = await this._storeSDK?.getLocalItem(DESKTOP_WEB_SECURE_INIT_KEYS[0]);
      if (old && typeof old === 'string') {
        this._cryptData = old; this._cryptObject = JSON.parse(old) as CryptRecord | null;
        this.cryptoSDK = this.makePair({ privateKey: this._cryptObject?.ec_privateKey, publicKey: this._cryptObject?.ec_publicKey });
        this._initData = { cryptCacheKey: old }; this.emit('ready', { action: 'keys', op: 'init', status: 'fail', ctx: { type: 'check' } }); return true;
      }
      this._cryptObject = { ec_privateKey: generated.ec_privateKey, ec_publicKey: generated.ec_publicKey, ec_csr: generated.ec_csr };
      this._cryptData = JSON.stringify(this._cryptObject);
      await this._storeSDK?.setLocalItem(DESKTOP_WEB_SECURE_INIT_KEYS[0], this._cryptData);
      await this._storeSDK?.set(DESKTOP_WEB_SECURE_INIT_KEYS[0], this._cryptData);
      this._initData = { cryptCacheKey: this._cryptData }; return true;
    } catch (error) {
      this.emit('load', { action: 'keys', op: 'init', status: 'fail' }); this.reportError(error, 'init_cert_error'); return false;
    }
  }

  private async generateCertificatePem(): Promise<CryptRecord> {
    const start = new this.context.Date().getTime(); this.cryptoSDK = this.makePair({});
    const { publicKey = '', privateKey = '' } = await this.cryptoSDK.getKeys(), csr = this.cryptoSDK.getCSR(), end = new this.context.Date().getTime();
    this.emit('load', { action: 'keys', op: 'init', duration: end > start ? end - start : 0, status: 'success', ctx: { pri: privateKey ? '1' : '0', pub: publicKey ? '1' : '0' } });
    return { ec_publicKey: publicKey, ec_privateKey: privateKey, ec_csr: csr };
  }
  private makePair(keys: { privateKey?: unknown; publicKey?: unknown }): WebSecureKeyPair {
    const pair = new WebSecureKeyPair(this.context.crypto, this.context.Date, keys); this.observe(pair.pipeline); return pair;
  }
  private performanceTime(): number {
    try { return this.context.performance?.now() || new this.context.Date().getTime(); } catch { return 0; }
  }
  private reportError(error: unknown, name: string): void {
    try { this.emit('error', { error, name }); } catch (failure) { this.emit('error', { error: failure, name: 'report error' }); }
  }
  private observe(promise: Promise<unknown>): void {
    void promise.catch(error => this.backgroundError(error));
  }
  private backgroundError(error: unknown): void {
    try { this.context.onBackgroundError?.(error); } catch { /* Additive observation, not recovery. */ }
  }
}

/** qe: preserves void wait and a rejected task's stuck count, but observes background rejection. */
class SignValueScheduler {
  private readonly list: Array<() => Promise<unknown>> = [];
  private count = 0;
  constructor(private readonly observe: (error: unknown) => void) {}
  provider(operation: () => Promise<unknown>): Promise<unknown> {
    return new Promise(resolve => {
      this.list.push(() => new Promise((done, reject) => { operation().then(done).catch(reject); }).then(value => {
        this.count--; this.consume(); resolve(value); return value;
      })); this.consume();
    });
  }
  wait(): void { this.provider(() => Promise.resolve(true)); }
  private consume(): void {
    if (this.count < 1 && this.list.length) { this.count++; const operation = this.list.shift(); if (operation) void operation().catch(this.observe); }
  }
}

/** We: caches truthy results (including empty typed arrays), not just pending calls. */
function rememberTruthy<T, A extends unknown[]>(operation: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let cached: T | undefined, pending: Promise<T> | undefined;
  return (...args: A) => {
    if (cached) return Promise.resolve(cached);
    if (!pending) pending = new Promise((resolve, reject) => {
      operation(...args).then(value => { if (value) cached = value; resolve(value); pending = undefined; }).catch(error => { reject(error); pending = undefined; });
    });
    return pending;
  };
}
function base64Hex(hex: string): string {
  let binary = ''; for (let offset = 0; offset < hex.length; offset += 2) binary += String.fromCharCode(parseInt(hex.slice(offset, offset + 2), 16)); return btoa(binary);
}
function encodeText(text: string): string { return btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join('')); }
function redact(value: unknown): unknown { return value ? '[redacted]' : value; }
