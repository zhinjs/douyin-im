import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';
import { DesktopWebSecureKeys, type DesktopWebSecureKeysContext, type DesktopWebSecureKeysSettings } from './desktop-web-secure-keys.js';
import { DesktopWebSecureRequestPipeline, type DesktopWebSecureManualSignData } from './desktop-web-secure-request.js';
import { DesktopWebSecureTransportHooks, type DesktopWebSecureTransportContext } from './desktop-web-secure-transport.js';
import type { DesktopWebSecureSceneConfig } from './desktop-web-secure-config.js';
import type { DesktopWebSecureTcc } from './desktop-web-secure-tcc.js';
import { DesktopWebSecureIframeHost, type DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';
import { DesktopWebSecureBridgeHost } from './desktop-web-secure-bridge.js';
import { DesktopWebSecureStore, type DesktopWebSecureStoreContext, type DesktopWebSecureStoreConfig } from './desktop-web-secure-store.js';
import { DesktopWebSecureKeyStore } from './desktop-web-secure-key-store.js';
import type { DesktopWebSecureCacheContext } from './desktop-web-secure-cache.js';

export interface DesktopWebSecureTelemetry {
  setContext(value: Record<string, unknown>): void;
  dot(value: { name: unknown; metrics?: unknown; categories?: unknown }): void;
  log(value: { content: unknown; level: unknown; extra: Record<string, unknown> }): void;
  throw(value: { err: Error; extra: Record<string, unknown> }): void;
  setEventParams?(value: Record<string, unknown>): void;
  initTicketGuard?(value: Record<string, unknown>): void;
  setWebId?(value: string | undefined): void;
  setEnv?(value: unknown): void;
  initTea?(value: { appId: number | string; config: Record<string, unknown> }, options?: unknown): void;
  initDTrait?(value: Record<string, unknown>): void;
}
export interface DesktopWebSecureDTraitOptions {
  aid?: number | string | undefined;
  webId?: string | undefined;
  consumerPathList?: string[];
  urlRewriteRules?: unknown[];
  [key: string]: unknown;
}
export interface DesktopWebSecureSdkContext {
  readonly keys: Omit<DesktopWebSecureKeysContext, 'document' | 'browser'>;
  readonly transport: DesktopWebSecureTransportContext;
  readonly document: { readonly cookie: string; readonly location: { readonly hostname: string } };
  readonly browser: Pick<DesktopStorageIframeContext, 'navigator' | 'window'>;
  readonly tcc: Pick<DesktopWebSecureTcc, 'getConfig'>;
  /** Real storage composition, preferred over an externally supplied keys.createKeyStore. Same isolated realm throughout. */
  readonly storage?: {
    readonly iframe: DesktopStorageIframeContext;
    readonly store: DesktopWebSecureStoreContext;
    readonly cache: Omit<DesktopWebSecureCacheContext, 'document'>;
  };
  /** Explicit local/host telemetry sink. This class never installs an analytics uploader. */
  readonly telemetry?: DesktopWebSecureTelemetry;
  /** Explicit DTrait runtime binding. Missing binding is an error, never a fake successful initialization. */
  readonly dtrait?: { start(options: DesktopWebSecureDTraitOptions): Promise<unknown>; setWebId?(value: string | undefined): void };
  onBackgroundError?(error: unknown): void;
}
interface Activity {
  action: string; op: string; status?: unknown; duration?: unknown;
  ctx?: Record<string, unknown>; metrics?: Record<string, unknown>; extras?: unknown;
}

/**
 * Uo's ticket-guard owner, one instance per isolated account browser realm.
 * Constructs actual Keys/pipeline/hooks; start's Promise waits for TCC, NOT authentication.
 * No global singleton, external SDK download, default login wiring or account Session commit.
 */
export class DesktopWebSecureSdk extends DesktopWebSecureEvents {
  readonly cryptoSDK: DesktopWebSecureKeys;
  readonly pipeline: DesktopWebSecureRequestPipeline;
  readonly secureProxy: DesktopWebSecureTransportHooks;
  config: Record<string, DesktopWebSecureSceneConfig[]> = {};
  aid: number | string | undefined;
  enableEcdh: boolean | undefined;
  webid: string | undefined;
  private disableTcc: boolean | undefined;
  private loginStatus = '-1';
  private loginPromise: Promise<unknown> | undefined;

  constructor(private readonly context: DesktopWebSecureSdkContext, options: { containerVersion?: string; containerType?: string } = {}) {
    super();
    context.telemetry?.setContext({ containerVersion: options?.containerVersion || 'default', containerType: options?.containerType || 'sdk' });
    const keysContext: DesktopWebSecureKeysContext = { ...context.keys, document: context.document, browser: context.browser };
    if (context.storage) {
      const storage = context.storage, host = new DesktopWebSecureIframeHost(storage.iframe), bridges = new DesktopWebSecureBridgeHost(storage.iframe);
      keysContext.createKeyStore = settings => {
        const config: DesktopWebSecureStoreConfig = { agid: settings.agid, sendEvent: event => this.sendEvent(event as Parameters<DesktopWebSecureSdk['sendEvent']>[0]) };
        if (settings.ztIframe !== undefined) config.ztIframe = settings.ztIframe;
        if (settings.iframeURL !== undefined) config.url = settings.iframeURL;
        if (settings.iframeBackURL !== undefined) config.fallbackCacheOriginURL = settings.iframeBackURL;
        if (settings.disableCrossStorage !== undefined) config.disableCrossStorage = settings.disableCrossStorage;
        if (settings.storageNamespace !== undefined) config.namespace = settings.storageNamespace;
        return new DesktopWebSecureKeyStore({ ...storage.cache, document: context.document,
          createStore: () => new DesktopWebSecureStore(host, bridges, storage.store, config) },
        { agId: settings.agid || 1, enableCache: settings.enableCache });
      };
    }
    this.cryptoSDK = new DesktopWebSecureKeys(keysContext);
    this.cryptoSDK.on('error', event => this.forwardError(event, true));
    for (const name of ['load', 'execute', 'ready'] as const) this.cryptoSDK.on(name, event => this.forwardKeysActivity(name, event as Activity));
    this.cryptoSDK.on('log', event => this.forwardLog(event));
    this.pipeline = new DesktopWebSecureRequestPipeline({ Date: context.keys.Date, pageHref: context.transport.location.href }, this.cryptoSDK);
    this.secureProxy = new DesktopWebSecureTransportHooks(context.transport, this.pipeline);
    this.secureProxy.on('error', event => this.forwardError(event, false));
    this.secureProxy.on('execute', event => this.forwardProxyActivity(event as Activity));
    this.secureProxy.on('log', event => this.forwardLog(event));
    (context.transport.window as DesktopWebSecureTransportContext['window'] & { $SECURE_VERSION: string }).$SECURE_VERSION = '3.3.5';
  }

  setConfig = (value: DesktopWebSecureSceneConfig): void => {
    const { scene, aid } = value; this.aid = aid;
    if (!this.config) this.config = {};
    const key = String(scene), previous = this.config[key];
    if (previous && Array.isArray(previous)) previous.push(value); else this.config[key] = [value];
    this.cryptoSDK.setConfig(this.config); this.cryptoSDK.setAid(aid); this.secureProxy.setConfig(this.config);
    this.emit('load', { action: 'sdk', op: 'config', status: 'success' });
  };
  setType = (value: Pick<DesktopWebSecureKeysSettings, 'initType' | 'signType'>): void => {
    this.cryptoSDK.setType(value); this.secureProxy.setType(value);
    this.context.telemetry?.setEventParams?.({ init_type: value.initType, sign_type: value.signType });
    this.context.telemetry?.setContext({ initType: value.initType, signType: value.signType, type: value.signType });
  };
  setNamespace = (value: string): void => { this.context.telemetry?.setContext({ namespace: value }); this.cryptoSDK.setStorageNamespace(value); };
  setAgidAndHost = (agid: number | string, host?: string): void => {
    this.context.telemetry?.setContext({ agid, scope: host || this.context.document.location.hostname || '' }); this.cryptoSDK.setAgidAndHost(agid, host);
  };
  setDisableCrossStorage = (value: boolean): void => { this.cryptoSDK.setDisableCrossStorage(value); };
  setDisableStorageSignData = (value: boolean): void => { this.cryptoSDK.setDisableStorageSignData(value); };
  setCrossStorageURL = (value: string): void => { this.cryptoSDK.setCrossStorageURL(value); };
  setCrossStorageBackURL = (value: string): void => { this.cryptoSDK.setCrossStorageBackURL(value); };
  setUpdateKeys = (value: boolean): void => { this.cryptoSDK.setUpdateKeys(value); };
  setContext = (value: DesktopWebSecureKeysSettings): void => { this.cryptoSDK.setContext(value); };
  setEnableCache = (value: boolean): void => { this.cryptoSDK.setEnableCache(value); };
  setEnableEcdh = (value: boolean): void => { this.enableEcdh = value; this.cryptoSDK.setEnableEcdh(value); };
  setUpdateDataWhenVerifySuccess = (value: boolean): void => { this.secureProxy.setUpdateDataWhenVerifySuccess(value); };
  disableTccConfig = (value: boolean): void => { this.disableTcc = value; };
  setLoginStatus = (value: boolean | (() => Promise<unknown>)): void => {
    if (typeof value === 'boolean') { this.loginStatus = value ? '1' : '0'; this.secureProxy.setLogin(value); }
    if (typeof value === 'function') this.loginPromise = value().catch(() => false);
  };
  setWebId = (value?: string, appId?: number | string, options?: unknown): void => {
    this.context.telemetry?.setWebId?.(value);
    const webId = value === undefined ? '' : value;
    this.context.telemetry?.initTea?.({ appId: appId || 1661, config: { user_unique_id: webId, device_id: webId, user_id: webId,
      evtParams: { sdk_version: '3.3.5', self_platform: /TTElectron/.test(this.context.browser.navigator.userAgent) ? 'electron' : 'web' } } }, options);
    this.webid = value; this.context.dtrait?.setWebId?.(value);
    this.emit('load', { action: 'sdk', op: 'setwebid', status: 'success' });
  };
  setSlardarEnv = (value: unknown): void => { this.context.telemetry?.setEnv?.(value); };
  startDTrait = (options: DesktopWebSecureDTraitOptions): boolean => {
    const start = this.context.keys.Date.now();
    const input = { ...options, webId: this.webid,
      consumerPathList: [...(options.consumerPathList || []), '/passport', '/quick_login/v2', '/check_qrconnect', '/account_login/v2', '/one_login'],
      urlRewriteRules: [...(options.urlRewriteRules || []), ['/quick_login/v2', '/passport/sso/quick_login/v2/'], ['/check_qrconnect', '/passport/sso/check_qrconnect/'],
        ['/account_login/v2', '/passport/sso/account_login/v2/'], ['/one_login', '/passport/sso/one_login/']] };
    if (!this.context.dtrait) throw new Error('Desktop DTrait runtime is not bound');
    const report = (status: string) => {
      this.context.telemetry?.initDTrait?.({ status, duration: this.context.keys.Date.now() - start, performance_time: this.context.keys.performance?.now() });
      this.context.telemetry?.dot({ name: 'dtrait_init', metrics: { count: 1, duration: this.context.keys.Date.now() - start, performance_time: this.context.keys.performance?.now() }, categories: { status } });
    };
    this.observe(this.context.dtrait.start(input).then(() => { this.emit('init', { type: 'dtrait' }); report('success'); }).catch(() => { report('fail'); }));
    return true; // Source starts a detached Promise chain; does not report authenticated readiness.
  };
  start = async (): Promise<void> => {
    this.context.telemetry?.initTicketGuard?.({ status: 'success', performance_time: this.context.keys.performance?.now() });
    this.context.telemetry?.dot({ name: 'ticket_guard_init', metrics: { count: 1, performance_time: this.context.keys.performance?.now() }, categories: { status: 'success' } });
    this.cryptoSDK.start();
    this.emit('init', { type: 'bdTicket' }); this.emit('load', { action: 'sdk', op: 'init', status: 'start' });
    if (!this.disableTcc) try {
      const value = await this.context.tcc.getConfig({ tccPsm: 'ucenter.fe.ztsdk', zone: 'default', key: 'ztsdk_config' }) as Record<string, unknown> | undefined;
      if (value && this.aid && value[this.aid] && Array.isArray(value[this.aid])) (value[this.aid] as DesktopWebSecureSceneConfig[]).forEach(entry => this.setConfig(entry));
    } catch { this.emit('log', { level: 'error', content: 'tcc config merge error', extra: { aid: this.aid || 0 } }); }
  };
  refresh = async (): Promise<void> => this.cryptoSDK.refresh();
  getBdTicketGuardHeader = async (input?: DesktopWebSecureManualSignData | null) => this.secureProxy.getBdTicketGuardHeader(input);

  processSignCookie = (): Record<string, string> => {
    try {
      // ur differs from He: malformed URI throws; ^ wins at the start, otherwise .*; is greedy.
      const read = (name: string): string | null => decodeURIComponent(this.context.document.cookie.replace(new RegExp('(?:(?:^|.*;)\\s*' + encodeURIComponent(name).replace(/[-.+*]/g, '\\$&') + '\\s*\\=\\s*([^;]*).*$)|^.*$'), '$1')) || null;
      const domain = read('_bd_ticket_crypt_doamin') || '', clientDomain = read('bd_ticket_guard_client_web_domain') || '3', crypt = read('_bd_ticket_crypt_cookie') ? '1' : '0';
      return { cookieStatus: read('__security_server_data_status') || '0', signVersion: read('bd_sign_version') || '0', cookieCrypt: crypt,
        isTopBrowser: this.cryptoSDK?.isTopBrowser() ? '1' : '0', webDomain: domain || '3', webClientDomain: clientDomain };
    } catch (error) { this.context.telemetry?.throw({ err: error instanceof Error ? error : new Error('init sign cookie error'), extra: { content: 'init sign cookie error' } }); }
    return { cookieStatus: '0', signVersion: '0', cookieCrypt: '0', isTopBrowser: '0', webDomain: '3', webClientDomain: '3' };
  };
  sendEvent = (event: { name: unknown; metrics: unknown; categories?: Record<string, unknown> }): void => {
    const cookies = this.processSignCookie(); this.context.telemetry?.dot({ name: event.name, metrics: event.metrics, categories: { ...event.categories, ...cookies, loginStatus: this.loginStatus } });
  };

  private forwardError(event: unknown, keys: boolean): void {
    const { error, name } = event as { error: unknown; name: string };
    const extra: Record<string, unknown> = { content: name };
    if (keys && error instanceof Error) extra['origin'] = (error as Error & { origin?: unknown }).origin || '';
    extra['login'] = this.loginStatus;
    this.context.telemetry?.throw({ err: error instanceof Error ? error : new Error(name), extra }); this.emit('error', event);
  }
  private forwardLog(event: unknown): void {
    const cookies = this.processSignCookie(), { level, extra, content } = (event || {}) as { level?: unknown; extra?: Record<string, unknown>; content?: unknown };
    this.context.telemetry?.log({ content, extra: { ...cookies, ...extra }, level }); this.emit('log', event);
  }
  private forwardKeysActivity(name: 'load' | 'execute' | 'ready', event: Activity): void {
    const { action, op, status, duration, ctx, metrics } = event;
    const metricName = `${name}_${action}_${op.toLocaleLowerCase()}`, cookies = name === 'ready' ? {} : this.processSignCookie();
    const report = () => this.context.telemetry?.dot({ name: metricName, metrics: { count: 1, duration: duration || 0, ...metrics }, categories: { satus: status, login: this.loginStatus, ...ctx, ...cookies } });
    if (this.loginPromise) this.observe(this.loginPromise.then(value => { this.loginStatus = value ? '1' : '0'; report(); })); else report();
    this.emit(name === 'ready' ? 'execute' : name, event);
  }
  private forwardProxyActivity(event: Activity): void {
    const { action, op, status, duration, ctx, metrics } = event;
    const name = `execute_${action}_${op.toLocaleLowerCase()}`, cookies = this.processSignCookie();
    const report = () => { if (op !== 'sign' || action !== 'response') this.context.telemetry?.dot({ name, metrics: { count: 1, duration: duration || 0, ...metrics }, categories: { satus: status, ...ctx, ...cookies } }); };
    // Pipeline deliberately redacts response snapshots instead of exposing raw private keys/tickets.
    const extras = event.extras === '[redacted]' ? { redacted: true } : event.extras as Record<string, unknown> | undefined;
    if (this.loginPromise) void this.loginPromise.then(value => {
      this.loginStatus = value ? '1' : '0'; report(); this.emit('execute', { ...event, extras: { loginStatus: this.loginStatus, ...extras } });
    }).catch(() => {}); // Source swallows delayed proxy listener/telemetry errors, unlike immediate delivery.
    else { report(); this.emit('execute', { ...event, extras: { loginStatus: this.loginStatus, ...extras, ...cookies } }); }
  }
  private observe(task: Promise<unknown>): void { void task.catch(error => { try { this.context.onBackgroundError?.(error); } catch { /* Observation only. */ } }); }
}
