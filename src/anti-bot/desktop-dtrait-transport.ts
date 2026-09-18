/* eslint-disable prefer-rest-params, @typescript-eslint/no-this-alias -- Preserve the original arguments object and captured XHR/fetch receivers. */
import type {
  DesktopDTraitRequestConfig,
  DesktopDTraitRequestMeta,
  DesktopDTraitRequestError,
} from './desktop-dtrait-request-core.js';

export interface DesktopDTraitTransportConfig extends DesktopDTraitRequestConfig {
  method?: unknown;
  urlObj?: unknown;
  query?: Record<string, string>;
  fullUrl?: unknown;
  extras?: unknown;
}
export interface DesktopDTraitTransportResponse {
  config: DesktopDTraitTransportConfig;
  headers: Record<string, unknown>;
  reqHeaders: unknown;
  extras: unknown;
  httpCode?: number;
}
export interface DesktopDTraitTransportCallbacks {
  hookConfig(
    config: DesktopDTraitTransportConfig
  ):
    | { needProxy?: unknown; onlyProxyReq?: unknown; onlyProxyResp?: unknown }
    | null
    | undefined;
  processRequestConfig(
    config: DesktopDTraitTransportConfig,
    instance: DesktopDTraitRequestMeta
  ): Promise<DesktopDTraitTransportConfig | null | undefined>;
  processResponseConfig(
    response: DesktopDTraitTransportResponse,
    instance: DesktopDTraitRequestMeta
  ): Promise<unknown>;
  errorRequestConfig?(error: DesktopDTraitRequestError): unknown;
}
export interface DesktopDTraitTransportXhr extends DesktopDTraitRequestMeta {
  secureOpenArgs?: IArguments;
  open(...args: unknown[]): unknown;
  send(...args: unknown[]): unknown;
  setRequestHeader(name: string, value: unknown): unknown;
  addEventListener(type: string, listener: (event: unknown) => void): unknown;
  readonly readyState: number;
  readonly status: number;
  getAllResponseHeaders?(): string;
  onloadend?: unknown;
  onreadystatechange?: unknown;
}
export interface DesktopDTraitFetchResponse {
  readonly headers?:
    | {
        forEach?(callback: (value: string, key: string) => void): unknown;
        get?(name: string): unknown;
      }
    | undefined;
}
export interface DesktopDTraitFetchInit {
  method?: unknown;
  headers?: unknown;
}
interface HeaderSetter {
  set(name: string, value: unknown): unknown;
}
interface RequestInput {
  url: string;
  method: string;
  headers: HeaderSetter;
}
export interface DesktopDTraitTransportRealm {
  readonly window: {
    readonly location: { readonly href: string };
    readonly XMLHttpRequest: { readonly prototype: DesktopDTraitTransportXhr };
    fetch?(
      input: unknown,
      init?: DesktopDTraitFetchInit | undefined
    ): Promise<DesktopDTraitFetchResponse>;
  };
  readonly XMLHttpRequest: { readonly prototype: DesktopDTraitTransportXhr };
  readonly Request?: (new (...args: never[]) => RequestInput) | undefined;
  readonly Headers?: (new (...args: never[]) => HeaderSetter) | undefined;
  readonly URL: new (
    input: string,
    base: string
  ) => {
    host: string;
    pathname: string;
    searchParams: { entries(): Iterable<[string, string]> };
  };
  readonly Date: { now(): number };
}
export interface DesktopDTraitTransportDiagnostics {
  /** Host-only observation, not a source errorRequestConfig event or a fallback send. */
  onBackgroundError?(error: unknown): void;
  onDiagnostic?(code: 'fetch-headers'): void;
}
const singletonHeaders = [
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'user-agent',
];

/** Original u: first-colon split, singleton header rules and ordinary-object semantics. */
export function parseDesktopDTraitResponseHeaders(
  raw: string
): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  if (!raw) return headers;
  raw.split('\n').forEach(line => {
    const colon = line.indexOf(':');
    // substr(0, -1) is empty, unlike slice(0, -1).
    const name = line.substring(0, Math.max(0, colon)).trim().toLowerCase();
    const value = line.substring(colon + 1).trim();
    if (!name) return;
    if (headers[name] && singletonHeaders.indexOf(name) >= 0) return;
    headers[name] =
      name === 'set-cookie'
        ? ((headers[name] || []) as string[]).concat([value])
        : headers[name]
          ? (headers[name] as string) + ', ' + value
          : value;
  });
  return headers;
}

/** Original module captures capability presence now; each install captures the then-current native methods. */
export function createDesktopDTraitTransportInstaller(
  realm: DesktopDTraitTransportRealm,
  diagnostics: DesktopDTraitTransportDiagnostics = {}
) {
  const fetchPresent = 'fetch' in realm.window,
    requestPresent = 'Request' in realm.window,
    headersPresent = 'Headers' in realm.window;
  const parseUrl = (input: unknown): DesktopDTraitRequestConfig => {
    try {
      const url = new realm.URL(input as string, realm.window.location.href);
      const { host, pathname, searchParams } = url;
      const query: Record<string, string> = {};
      for (const [key, value] of searchParams.entries()) query[key] = value;
      return {
        host,
        pathname,
        urlObj: url,
        query,
        fullUrl: input,
      } as DesktopDTraitTransportConfig;
    } catch {
      return { pathname: input as string };
    }
  };
  const observe = (task: Promise<unknown>) => {
    void task.catch(error => {
      try {
        diagnostics.onBackgroundError?.(error);
      } catch {
        /* Detached host observer only. */
      }
    });
  };
  return (callbacks: DesktopDTraitTransportCallbacks): void => {
    // Captures and assignments intentionally have no rollback or idempotence; the owner must dispose its isolated realm.
    const nativeOpen = realm.window.XMLHttpRequest.prototype.open;
    const nativeSend = realm.window.XMLHttpRequest.prototype.send;
    const nativeSetHeader =
      realm.window.XMLHttpRequest.prototype.setRequestHeader;
    const nativeFetch = realm.window.fetch;
    const owner = {
      processResponseConfig: callbacks.processResponseConfig,
      processRequestConfig: callbacks.processRequestConfig,
      hookConfig: callbacks.hookConfig,
      errorRequestConfig: callbacks?.errorRequestConfig || (() => null),
    };
    realm.XMLHttpRequest.prototype.open = function (
      this: DesktopDTraitTransportXhr
    ): void {
      this.secureOpenArgs = arguments;
      this.ucProxyParam = { startTime: realm.Date.now() };
      // eslint-disable-next-line prefer-spread -- Preserve the original arguments object and native receiver.
      nativeOpen.apply(this, arguments as unknown as unknown[]);
    };
    realm.XMLHttpRequest.prototype.send = function (
      this: DesktopDTraitTransportXhr
    ): unknown {
      const xhr = this,
        openArgs = this.secureOpenArgs!,
        args = arguments;
      const method = openArgs[0] || 'GET';
      const config = Object.assign({}, parseUrl(openArgs[1]) || {}, { method });
      const {
        needProxy = false,
        onlyProxyReq = false,
        onlyProxyResp = false,
      } = owner.hookConfig(config) || {};
      // eslint-disable-next-line prefer-spread -- Source forwards the unchanged send arguments object.
      if (!needProxy && !onlyProxyReq && !onlyProxyResp)
        return nativeSend.apply(xhr, args as unknown as unknown[]);
      const error = (errType: string, err: unknown) =>
        owner.errorRequestConfig?.({ config, errType, err, instance: xhr });
      xhr.addEventListener('error', event => {
        error('error', event);
      });
      xhr.addEventListener('abort', event => {
        error('abort', event);
      });
      xhr.addEventListener('timeout', event => {
        error('timeout', event);
      });
      const reqHeaders: Record<string, unknown> = {};
      let extras: unknown = {};
      const wrap = (previous?: (...args: unknown[]) => unknown) =>
        async function (...values: unknown[]) {
          if (
            xhr.readyState === 4 &&
            'getAllResponseHeaders' in xhr &&
            typeof xhr.getAllResponseHeaders === 'function' &&
            (needProxy || onlyProxyResp)
          ) {
            const headers = parseDesktopDTraitResponseHeaders(
              xhr.getAllResponseHeaders()
            );
            await owner.processResponseConfig(
              {
                config,
                headers: headers || {},
                reqHeaders,
                extras,
                httpCode: xhr.status,
              },
              xhr
            );
          }
          // No extra await when response processing is skipped: source calls the user handler synchronously then.
          if (previous) return previous.apply(xhr, values);
          return undefined;
        };
      // Original async callbacks use the captured XHR, not a caller-supplied .call receiver.
      if ('onloadend' in xhr && typeof xhr.onloadend === 'function') {
        const previous = xhr.onloadend as (...args: unknown[]) => unknown;
        xhr.onloadend = wrap(previous);
      } else {
        const previous = xhr.onreadystatechange;
        const hasPrevious =
          'onreadystatechange' in xhr && typeof previous === 'function';
        xhr.onreadystatechange = wrap(
          hasPrevious
            ? (previous as (...args: unknown[]) => unknown)
            : undefined
        );
      }
      // onlyProxyResp takes priority in XHR even when needProxy is also set.
      // eslint-disable-next-line prefer-spread -- Source native return value is preserved on the direct path.
      if ((openArgs.length >= 3 && !openArgs[2]) || onlyProxyResp)
        return nativeSend.apply(xhr, args as unknown as unknown[]);
      const pending = owner.processRequestConfig?.(config, xhr).then(value => {
        const { headers = {}, extras: nextExtras = {} } = value || {};
        extras = nextExtras;
        Object.keys(headers!).forEach(key => {
          reqHeaders[key] = (headers as Record<string, unknown>)[key];
          nativeSetHeader.call(
            xhr,
            key,
            (headers as Record<string, unknown>)[key]
          );
        });
        // eslint-disable-next-line prefer-spread -- Detached request preparation still sends the original arguments.
        return nativeSend.apply(xhr, args as unknown as unknown[]);
      });
      if (pending) observe(pending);
      return undefined;
    };
    if (fetchPresent)
      realm.window.fetch = function (
        this: unknown,
        input: unknown,
        init?: DesktopDTraitFetchInit
      ): Promise<DesktopDTraitFetchResponse> {
        const receiver = this;
        const isRequest = () =>
          requestPresent && input instanceof realm.Request!;
        let url: unknown, method: unknown;
        if (isRequest()) {
          url = (input as RequestInput).url;
          method = (input as RequestInput).method;
        } else {
          url = input;
          method = init && init.method ? init.method : 'GET';
        }
        const meta: DesktopDTraitRequestMeta = {
          ucProxyParam: { startTime: realm.Date.now() },
        };
        const config = Object.assign({}, parseUrl(url) || {}, { method });
        const {
          needProxy = false,
          onlyProxyReq = false,
          onlyProxyResp = false,
        } = owner.hookConfig(config) || {};
        const response = (
          value: DesktopDTraitFetchResponse,
          reqHeaders?: unknown,
          extras?: unknown
        ): DesktopDTraitFetchResponse | Promise<DesktopDTraitFetchResponse> => {
          if (needProxy || onlyProxyResp) {
            const headers: Record<string, unknown> = {};
            if (value?.headers) {
              if (typeof value?.headers?.forEach === 'function')
                value?.headers?.forEach?.((item, key) => {
                  headers[key] = item;
                });
              else if (typeof value?.headers?.get === 'function') {
                for (const key of [
                  'x-tt-session-dtrait-token',
                  'bd-ticket-guard-server-data',
                  'bd-ticket-guard-result',
                  'x-tt-logid',
                ])
                  headers[key] = value?.headers?.get!(key) || '';
              }
              return owner
                .processResponseConfig(
                  { config, headers, reqHeaders, extras },
                  meta
                )
                .then(() => value);
            }
          }
          return value;
        };
        if (needProxy || onlyProxyReq)
          return owner.processRequestConfig(config, meta).then(value => {
            const { headers = {}, extras = {} } = value || {};
            try {
              if (isRequest())
                Object.keys(headers!).forEach(key => {
                  (input as RequestInput).headers.set(
                    key,
                    (headers as Record<string, unknown>)[key]
                  );
                });
              else {
                init = init || {};
                init.headers = init.headers || {};
                if (headersPresent && init?.headers instanceof realm.Headers!)
                  Object.keys(headers!).forEach(key => {
                    (init?.headers as HeaderSetter | undefined)?.set?.(
                      key,
                      (headers as Record<string, unknown>)[key]
                    );
                  });
                else if (init && init.headers && Array.isArray(init.headers))
                  Object.keys(headers!).forEach(key => {
                    if (init && init.headers && Array.isArray(init.headers))
                      init?.headers?.push([
                        key,
                        (headers as Record<string, unknown>)[key],
                      ]);
                  });
                else
                  Object.keys(headers!).forEach(key => {
                    (init!.headers as Record<string, unknown>)[key] = (
                      headers as Record<string, unknown>
                    )[key];
                  });
              }
            } catch {
              diagnostics.onDiagnostic?.('fetch-headers');
            }
            // This inner catch exists only after request preparation, and only after nativeFetch returns its Promise.
            return nativeFetch!
              .call(receiver, input, init)
              .then(value => response(value, headers, extras))
              .catch(error => {
                owner.errorRequestConfig?.({
                  config,
                  err: error,
                  instance: meta,
                  errType: 'error',
                });
                return Promise.reject(error);
              });
          });
        return nativeFetch!
          .call(this, input, init)
          .then(value => response(value));
      };
  };
}
