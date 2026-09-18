import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';
import { DesktopWebSecureIframeHost } from './desktop-web-secure-iframe.js';
import { DesktopWebSecureBridgeHost } from './desktop-web-secure-bridge.js';
import { DesktopWebSecureCrossStorage, type DesktopCrossStorageContext, type DesktopCrossStorageValue } from './desktop-web-secure-cross-storage.js';
import { type DesktopWebSecureLocalStorage } from './desktop-web-secure-local-storage.js';
import { readDesktopWebSecureCookie, verifyDesktopWebSecureCookie } from './desktop-web-secure-cookie.js';

export interface DesktopWebSecureStoreConfig {
  url?: string;
  namespace?: string;
  disableCrossStorage?: boolean;
  ztIframe?: boolean;
  agid?: unknown;
  fallbackCacheOriginURL?: unknown;
  sendEvent?: (event: { name: string; metrics: unknown; categories: unknown }) => unknown;
}
export interface DesktopWebSecureStoreContext extends DesktopCrossStorageContext {
  readCookie(): string;
  queryIframes(): { length: number; forEach(callback: (frame: { src?: string }) => void): void } | undefined;
}
export interface DesktopWebSecureOriginValues {
  data: Record<string, { key: string; value: unknown; from: string; origin: string }>;
  from?: string;
}
type Metadata = Partial<DesktopCrossStorageValue> | null | undefined;

/** Xe/Qe, Desktop-only. Cache fingerprints and iframe status are not certificate readiness. */
export class DesktopWebSecureStore extends DesktopWebSecureEvents {
  readonly config: DesktopWebSecureStoreConfig;
  readonly disableCrossStorage: boolean | undefined;
  readonly localStore: DesktopWebSecureLocalStorage;
  readonly storage: DesktopWebSecureCrossStorage | undefined;
  readonly loadIframePromise: Promise<void> | undefined;
  hasCheckIframeStatus: boolean | undefined;
  iframeStatus: boolean | undefined;
  crossStatus: boolean | undefined;

  constructor(private readonly host: DesktopWebSecureIframeHost, bridges: DesktopWebSecureBridgeHost,
    private readonly context: DesktopWebSecureStoreContext, config: DesktopWebSecureStoreConfig = {}) {
    super(); this.config = config; this.disableCrossStorage = config.disableCrossStorage;
    const sendEvent = config.sendEvent;
    const log = (event: unknown): void => { const { name, content } = (event || {}) as { name?: string; content?: unknown }; this.emit('log', { extra: { content: content || '' }, content: name, level: 'info' }); };
    const error = (error: unknown): void => { this.emit('error', { error, name: 'storage error' }); };
    if (this.disableCrossStorage) {
      this.localStore = context.createLocalStorage(); this.localStore.on('log', log); this.localStore.on('error', error);
    } else {
      const base = !config.agid && context.hostname.indexOf('douyin.com') !== -1 || config.ztIframe
        ? 'https://lf-zt.douyin.com/obj/uc-assets/zt/' : 'https://lf-ucenter-web.yhgfb-cn-static.com/obj/passport-fe/ucenter_fe/';
      const defaultURL = host.resourceURL(base);
      this.localStore = context.createLocalStorage();
      this.storage = new DesktopWebSecureCrossStorage(host, bridges, context, { url: config.url || defaultURL || '', protocol: 'SERCURE', fallback: config.fallbackCacheOriginURL, verifySignMethod: this.verifySignMethod });
      this.hasCheckIframeStatus = false; this.iframeStatus = false; this.crossStatus = false;
      this.storage.on('error', error); this.storage.on('log', log);
      this.storage.on('metrics', event => {
        const { name, metrics, categories } = (event || {}) as { name?: unknown; metrics: unknown; categories: unknown };
        sendEvent?.({ name: name && typeof name === 'string' ? `storage_${name}` : 'storage_event_without_name', metrics, categories });
      });
      this.loadIframePromise = this.initLoadIframePromise();
    }
  }
  startStorageChecker = (): void => {
    if (this.storage) this.observe(this.storage.startStorageChecker().catch(error => { this.emit('error', { name: 'start storage checker error', error }); }));
  };
  initLoadIframePromise = (): Promise<void> => new Promise(resolve => {
    if (this.storage) this.storage.client.on('connection', () => { this.crossStatus = true; resolve(); }); else resolve();
  });
  getStorageStatus = (): ReturnType<DesktopWebSecureCrossStorage['client']['getIframeState']> | undefined => this.storage?.client.getIframeState();
  _createStorageKey = (key: string): string => this.config.namespace ? `security-sdk/${this.config.namespace}/${key}` : `security-sdk/${key}`;
  getItem = async (key: string): Promise<unknown> => {
    const stored = await (this.disableCrossStorage ? this.localStore.getItem(this._createStorageKey(key)) : this.storage?.getItem(this._createStorageKey(key)));
    return stored?.value || '';
  };
  getLocalItem = async (key: string): Promise<unknown> => {
    const name = this._createStorageKey(key), start = this.time();
    const stored: Metadata = await (this.disableCrossStorage ? this.localStore.getItem(name) : this.storage?.storage.getItem(name)), end = this.time();
    this.emit('execute', { action: 'localstorage', op: 'getItem', status: stored?.value ? 'success' : 'success_null', duration: end > start ? end - start : 0,
      ctx: stored ? { key, from: typeof stored.from === 'number' ? stored.from.toString() : '-99', origin: stored.origin || '', type: 'localStorage' } : { key, type: 'localStorage' } });
    return stored?.value || '';
  };
  setLocalItem = async (key: string, value: unknown): Promise<void> => {
    const name = this._createStorageKey(key), start = this.time();
    const stored: Metadata = await (this.disableCrossStorage ? this.localStore.setItem(name, value) : this.storage?.storage.setItem(name, value)), end = this.time();
    this.emit('execute', { action: 'localstorage', op: 'setItem', status: 'success', duration: end > start ? end - start : 0,
      ctx: { key, from: typeof stored?.from === 'number' ? stored.from.toString() : '-99', origin: stored?.origin || '' } });
  };
  getLocalItemsWithKeys = async (keys: string[]): Promise<Record<string, unknown>> => {
    const names = keys.map(this._createStorageKey), start = this.time();
    const result = await (this.disableCrossStorage ? this.localStore.getItemByKeys(names) : this.storage?.storage.getItemByKeys(names)), end = this.time();
    const { values, categories, valid } = this.project(keys, result);
    this.emit('execute', { action: 'localstorage', op: 'getKeys', status: valid ? 'success' : 'success_null', duration: end > start ? end - start : 0, ctx: categories });
    return values;
  };
  getItemWithKeys = async (keys: string[]): Promise<Record<string, unknown>> => {
    const names = keys.map(this._createStorageKey), result = await (this.disableCrossStorage ? this.localStore.getItemByKeys(names) : this.storage?.getItemByKeys(names));
    return this.project(keys, result, true).values;
  };
  getItemsWithOrigin = async (keys: string[]): Promise<DesktopWebSecureOriginValues> => {
    const names = keys.map(this._createStorageKey), result = await (this.disableCrossStorage ? this.localStore.getItemByKeys(names) : this.storage?.getItemByKeys(names));
    const data: DesktopWebSecureOriginValues['data'] = {};
    if (Array.isArray(result) && result.length === keys.length) {
      let cross = '1';
      result.forEach((entry, index) => {
        const key = keys[index]!, { value, from, origin } = entry || {};
        if (origin && origin.indexOf('lf-zt.douyin.com') === -1) cross = '0';
        key.replace(/\//g, '_'); data[key] = { key, value, from: typeof from === 'number' ? from.toString() : '-99', origin: origin || '-1' };
      }); return { data, from: cross || '0' };
    }
    keys.forEach(key => { data[key] = { key, value: '', from: '-98', origin: '-2' }; key.replace(/\//g, '_'); }); return { data };
  };
  setItemWithKeys = async (keys: string[], values: unknown[], _ignored?: unknown): Promise<{ cross: string }> => {
    void _ignored; // Source accepts but does not use its third argument.
    if (keys.length !== values.length) throw new Error('set item with Keys need equal length');
    const entries: Array<[string, unknown]> = keys.map((key, index) => [this._createStorageKey(key), values[index]]);
    const result = await (this.disableCrossStorage ? this.localStore.setItemByKeys(entries) : this.storage?.setItemByKeys(entries, { async: 3000 }));
    if (!Array.isArray(result) || result.length !== keys.length) return { cross: '0' };
    let cross = '1'; result.forEach((entry, index) => {
      const { from, origin } = entry || {}; if (origin && origin.indexOf('lf-zt.douyin.com') === -1) cross = '0';
      // Source computes diagnostic key fields even though this method does not emit them.
      keys[index]!.replace(/\//g, '_'); if (typeof from === 'number') from.toString();
    }); return { cross };
  };
  setItem = async (key: string, value: unknown, sync?: unknown): Promise<{ cross: string }> => {
    const name = this._createStorageKey(key); this.time();
    const stored = await (this.disableCrossStorage ? this.localStore.setItem(name, value) : sync ? this.storage?.setItem(name, value) : this.storage?.setItem(name, value, { async: true }));
    const origin = stored?.origin; this.time(); return { cross: origin && origin.indexOf('lf-zt.douyin.com') !== -1 ? '1' : '0' };
  };
  deleteItem = async (key: string): Promise<void> => {
    const name = this._createStorageKey(key); await (this.disableCrossStorage ? this.localStore.removeItem(name) : this.storage?.removeItem(name));
  };
  checkIframeStatus = (unload?: unknown): void => {
    const report = (success: boolean): void => { this.emit('execute', { action: 'iframe', op: unload ? 'check' : 'getKeys', status: success ? 'success' : 'fail', ctx: { type: unload ? 'unload' : 'getKeys' } }); };
    try {
      if (this.hasCheckIframeStatus && !unload) return; this.hasCheckIframeStatus = true;
      const frames = this.context.queryIframes(); let found = false;
      if (frames && frames.length > 0) frames.forEach(frame => { if (frame.src && frame.src.indexOf('lf-zt.douyin.com') !== -1) { report(true); found = true; } });
      if (!found) report(false);
    } catch (error) { this.emit('error', { error, name: 'check iframe status error' }); report(false); }
  };
  getIframeStatus = (): boolean | undefined => this.crossStatus || this.iframeStatus;
  verifySignMethod = (values: unknown[]): boolean => {
    try {
      const cookie = readDesktopWebSecureCookie(() => this.context.readCookie(), '_bd_ticket_crypt_cookie') || '';
      if (values && Array.isArray(values) && values.length === 3) return verifyDesktopWebSecureCookie(cookie, values[0], values[1], values[2]);
    } catch (error) { this.emit('error', { error, name: 'verify sign method error' }); }
    return false;
  };
  private time(): number { return this.host.context.Date.now(); }
  private project(keys: string[], result: Metadata[] | undefined, cross = false): { values: Record<string, unknown>; categories: Record<string, string>; valid: boolean } {
    const values: Record<string, unknown> = {}, categories: Record<string, string> = cross ? { cross: '1' } : {};
    const valid = Array.isArray(result) && result.length === keys.length;
    if (valid) result.forEach((entry, index) => {
      const { value, from, origin } = entry || {}, key = keys[index]!, field = key.replace(/\//g, '_');
      if (cross && origin && origin.indexOf('lf-zt.douyin.com') === -1) categories['cross'] = '0';
      categories[`${field}_origin`] = origin || ''; categories[`${field}_from`] = typeof from === 'number' ? from.toString() : '-99';
      categories[`${field}_status`] = value ? 'success' : 'success_null'; values[key] = value;
    }); else keys.forEach(key => { values[key] = ''; categories[`${key.replace(/\//g, '_')}_status`] = 'success_null'; });
    return { values, categories, valid };
  }
  private observe(pending: Promise<unknown>): void { void pending.catch(error => { try { this.context.onBackgroundError?.(error); } catch { /* Background observers do not imply success. */ } }); }
}
