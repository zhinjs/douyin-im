/* eslint-disable @typescript-eslint/no-this-alias, prefer-rest-params -- Preserve Desktop's captured native receiver and original IArguments identity. */
import type { DesktopWebSecureManualHeaders, DesktopWebSecureManualSignData, DesktopWebSecureRequest, DesktopWebSecureRequestPipeline } from './desktop-web-secure-request.js';
import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';

export interface DesktopWebSecureXhr {
  secureOpenArgs?: IArguments;
  readyState?: number;
  onloadend?: unknown;
  onreadystatechange?: unknown;
  getAllResponseHeaders?: unknown;
}
export interface DesktopWebSecureXhrPrototype {
  open(this: DesktopWebSecureXhr, ...args: unknown[]): unknown;
  send(this: DesktopWebSecureXhr, ...args: unknown[]): unknown;
  setRequestHeader(this: DesktopWebSecureXhr, ...args: unknown[]): unknown;
}
interface HeaderMethods {
  set?(name: string, value: unknown): unknown;
  get?(name: string): unknown;
  forEach?(callback: (value: unknown, name: string) => void): unknown;
}
export interface DesktopWebSecureTransportWindow {
  readonly XMLHttpRequest: { prototype: DesktopWebSecureXhrPrototype };
  fetch?(...args: unknown[]): unknown;
  Request?: unknown;
  Headers?: unknown;
}
export interface DesktopWebSecureTransportContext {
  readonly window: DesktopWebSecureTransportWindow;
  readonly XMLHttpRequest: { prototype: DesktopWebSecureXhrPrototype };
  readonly URL: typeof URL;
  readonly location: { readonly href: string };
  /** Live realm-global constructor bindings, not snapshots of window.Request/Headers. */
  readonly Request: abstract new (...args: never[]) => { url: string; method: string; headers: { set(name: string, value: unknown): unknown } };
  readonly Headers: abstract new (...args: never[]) => HeaderMethods;
  onBackgroundError?(error: unknown): void;
}
export interface DesktopWebSecureTransportFeatures { readonly fetch: boolean; readonly request: boolean; readonly headers: boolean }
const features = new WeakMap<object, DesktopWebSecureTransportFeatures>();
/** mo/bo/wo: call when binding a browser realm, before later capability changes. No Node-global probing. */
export function captureDesktopWebSecureTransportFeatures(window: object): DesktopWebSecureTransportFeatures {
  let value = features.get(window);
  if (!value) { value = Object.freeze({ fetch: 'fetch' in window, request: 'Request' in window, headers: 'Headers' in window }); features.set(window, value); }
  return value;
}

const singletons = ['age', 'authorization', 'content-length', 'content-type', 'etag', 'expires', 'from', 'host', 'if-modified-since', 'if-unmodified-since', 'last-modified', 'location', 'max-forwards', 'proxy-authorization', 'referer', 'retry-after', 'user-agent'];
/** Gn: XHR only. Duplicate guard headers join with commas; don't silently choose one valid ticket. */
export function parseDesktopWebSecureResponseHeaders(text: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  if (text) text.split('\n').forEach(line => {
    const colon = line.indexOf(':'), name = line.substr(0, colon).trim().toLowerCase(), value = line.substr(colon + 1).trim();
    if (!name) return;
    if (headers[name] && singletons.includes(name)) return;
    headers[name] = name === 'set-cookie' ? (headers[name] ? headers[name] as string[] : []).concat([value]) : headers[name] ? `${headers[name]}, ${value}` : value;
  });
  return headers;
}

/**
 * _o's owned-browser XHR/fetch patch. Construction installs immediately, as in Desktop.
 * Use once in an isolated account realm; no process-global fetch patch or automatic retry.
 * Disposing the browser realm is the lifecycle boundary; this is not a reversible shared-browser patch.
 */
export class DesktopWebSecureTransportHooks extends DesktopWebSecureEvents {
  config: Record<string, unknown> = {};
  updateData = false;
  login = false;
  initType = 'pubKey';
  signType = 'pubKey';
  private readonly nativeOpen: DesktopWebSecureXhrPrototype['open'];
  private readonly nativeSend: DesktopWebSecureXhrPrototype['send'];
  private readonly nativeSetHeader: DesktopWebSecureXhrPrototype['setRequestHeader'];
  private readonly nativeFetch: DesktopWebSecureTransportWindow['fetch'];
  private readonly support: DesktopWebSecureTransportFeatures;

  constructor(private readonly context: DesktopWebSecureTransportContext, private readonly pipeline: DesktopWebSecureRequestPipeline) {
    super();
    this.support = captureDesktopWebSecureTransportFeatures(context.window);
    this.nativeOpen = context.window.XMLHttpRequest.prototype.open;
    this.nativeSend = context.window.XMLHttpRequest.prototype.send;
    this.nativeSetHeader = context.window.XMLHttpRequest.prototype.setRequestHeader;
    this.nativeFetch = context.window.fetch;
    this.patchXhr(); this.patchFetch();
    for (const name of ['error', 'execute', 'log']) pipeline.on(name, event => { this.emit(name, event); });
  }

  setType = ({ initType = 'pubKey', signType = 'pubKey' }: { initType?: string | undefined; signType?: string | undefined }): void => { this.initType = initType; this.signType = signType; };
  setConfig = (config: Record<string, unknown>): void => { this.config = config; };
  setUpdateDataWhenVerifySuccess = (value: boolean): void => { this.updateData = value; };
  setLogin = (value: boolean): void => { this.login = value; }; // Stored by Desktop; not an authentication gate for hooks.
  getBdTicketGuardHeader = async (signData?: DesktopWebSecureManualSignData | null): Promise<DesktopWebSecureManualHeaders> => {
    // Desktop deliberately ignores this.signType/initType/config for this manual entry.
    return this.pipeline.createTicketGuardHeaders({ signData, signType: 'pubKey', certType: 'header' });
  };

  private patchXhr(): void {
    const owner = this, prototype = this.context.XMLHttpRequest.prototype;
    prototype.open = function(this: DesktopWebSecureXhr): void {
      this.secureOpenArgs = arguments; Reflect.apply(owner.nativeOpen, this, arguments); // Native return deliberately discarded.
    };
    prototype.send = function(this: DesktopWebSecureXhr): unknown {
      const xhr = this, open = this.secureOpenArgs!, args = arguments, method = open[0] || 'GET';
      const url = new owner.context.URL(open[1], owner.context.location.href).toString();
      const match = owner.pipeline.classify({ method, url, headers: {} }, owner.config, owner.signType || 'pubKey', owner.initType || 'pubKey');
      const needProxy = match?.needProxy;
      if (!needProxy) return Reflect.apply(owner.nativeSend, xhr, args);
      const requestHeaders: Record<string, unknown> = {}; let extras: NonNullable<DesktopWebSecureRequest['extras']> = {};
      const wrap = (callback?: (...args: unknown[]) => unknown) => function(...callbackArgs: unknown[]): Promise<unknown> {
        const task = (async () => {
          if (xhr.readyState === 4 && 'getAllResponseHeaders' in xhr && typeof xhr.getAllResponseHeaders === 'function' && needProxy) {
            const raw = Reflect.apply(xhr.getAllResponseHeaders, xhr, []) as string, headers = parseDesktopWebSecureResponseHeaders(raw);
            await owner.pipeline.complete({ config: { method, url, headers: {}, extras }, headers: headers || {}, reqHeaders: requestHeaders }, match, owner.updateData);
          }
          if (callback) return Reflect.apply(callback, xhr, callbackArgs);
          return undefined;
        })();
        owner.observe(task); return task; // Additive observation doesn't resume failed callbacks.
      };
      if ('onloadend' in xhr && typeof xhr.onloadend === 'function') xhr.onloadend = wrap(xhr.onloadend as (...args: unknown[]) => unknown);
      else {
        const callback = xhr.onreadystatechange, hasCallback = 'onreadystatechange' in xhr && typeof callback === 'function';
        xhr.onreadystatechange = hasCallback ? wrap(callback as (...args: unknown[]) => unknown) : wrap();
      }
      // Sync XHR still has the response callback above, but no asynchronous signing step.
      if (open.length >= 3 && !open[2]) return Reflect.apply(owner.nativeSend, xhr, args);
      const task = owner.pipeline.prepare<DesktopWebSecureRequest>({ method, url, headers: {} }, match).then(result => {
        const { headers = {}, extras: nextExtras = {} } = result || {}; extras = nextExtras;
        Object.keys(headers).forEach(name => {
          const value = (headers as Record<string, unknown>)[name]; requestHeaders[name] = value;
          Reflect.apply(owner.nativeSetHeader, xhr, [name, value]);
        });
        return Reflect.apply(owner.nativeSend, xhr, args);
      });
      owner.observe(task); return undefined;
    };
  }

  private patchFetch(): void {
    if (!this.support.fetch) return;
    const owner = this;
    this.context.window.fetch = function(this: unknown, input: unknown, options: unknown): unknown {
      const receiver = this;
      let url: unknown, method: unknown;
      let init = options as Record<string, unknown> | null | undefined;
      if (owner.support.request && input instanceof owner.context.Request) { url = input.url; method = input.method; }
      else { url = input; method = init && init['method'] ? init['method'] : 'GET'; }
      const match = owner.pipeline.classify({ method, url: url as string, headers: {} }, owner.config, owner.signType || 'pubKey', owner.initType || 'pubKey');
      if (!match?.needProxy) return Reflect.apply(owner.nativeFetch!, receiver, [input, options]);
      return owner.pipeline.prepare<DesktopWebSecureRequest>({ method, url: url as string, headers: {} }, match).then(result => {
        const { headers, extras = {} } = result || {};
        try {
          if (owner.support.request && input instanceof owner.context.Request) {
            Object.keys(headers!).forEach(name => input.headers.set(name, (headers as Record<string, unknown>)[name]));
          } else {
            init = init || {}; init['headers'] = init['headers'] || {};
            if (owner.support.headers && init['headers'] instanceof owner.context.Headers) {
              Object.keys(headers!).forEach(name => (init?.['headers'] as HeaderMethods | undefined)?.set?.(name, (headers as Record<string, unknown>)[name]));
            } else if (init && init['headers'] && Array.isArray(init['headers'])) {
              Object.keys(headers!).forEach(name => { if (init && init['headers'] && Array.isArray(init['headers'])) init['headers']?.push([name, (headers as Record<string, unknown>)[name]]); });
            } else Object.keys(headers!).forEach(name => { (init!['headers'] as Record<string, unknown>)[name] = (headers as Record<string, unknown>)[name]; });
          }
        } catch { /* Source continues native fetch after header injection failure. */ }
        const pending = Reflect.apply(owner.nativeFetch!, receiver, [input, init]) as Promise<{ headers?: HeaderMethods } | null | undefined>;
        return pending.then(response => {
          const responseHeaders: Record<string, unknown> = {};
          if (response?.headers) {
            if (typeof response.headers?.forEach === 'function') response.headers?.forEach?.((value, name) => { responseHeaders[name] = value; });
            else if (typeof response.headers?.get === 'function') {
              responseHeaders['bd-ticket-guard-server-data'] = response.headers?.get('bd-ticket-guard-server-data') || '';
              responseHeaders['bd-ticket-guard-result'] = response.headers?.get('bd-ticket-guard-result') || '';
            }
            // Only a rejected completion Promise is swallowed. A synchronous call throw still rejects fetch.
            return owner.pipeline.complete({ config: { method, url: url as string, headers: {}, extras }, headers: responseHeaders, reqHeaders: headers as Record<string, unknown> }, match, owner.updateData)
              .then(() => response).catch(() => response);
          }
          return response;
        });
      });
    };
  }
  private observe(task: Promise<unknown>): void {
    void task.catch(error => { try { this.context.onBackgroundError?.(error); } catch { /* Observation only. */ } });
  }
}
