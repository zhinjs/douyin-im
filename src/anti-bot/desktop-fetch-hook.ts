import { setDesktopProperty } from './desktop-property-write.js';
import type { DesktopTokenState, DesktopXhrUrlContext } from './desktop-token.js';

// Explicit Desktop copy list; Node's RequestInit declarations omit some browser fields.
type RequestCopy = Pick<Request,
  'cache' | 'credentials' | 'headers' | 'integrity' | 'method' | 'mode' | 'redirect' | 'referrer' | 'referrerPolicy'
> & { body?: string };

export interface DesktopFetchHookContext extends DesktopXhrUrlContext {
  readonly window: { fetch?(...args: unknown[]): unknown };
  readonly Request: typeof Request;
}

export interface DesktopFetchHookCallbacks {
  matchesSigning(pathname: string): boolean;
  matchesBehavior(pathname: string): boolean;
  sign(query: string, body: unknown, contentType?: string): string;
  reportBehavior(): void;
}

/** BDMS .7 PC8491–9434. Owned browser host only; not Node's global fetch. */
export function installDesktopFetchHook(
  context: DesktopFetchHookContext,
  tokens: Pick<DesktopTokenState, 'token'>,
  callbacks: DesktopFetchHookCallbacks,
): void {
  if (typeof context.window.fetch !== 'function') return;
  const fetch = context.window.fetch;
  setDesktopProperty(context.window, 'fetch', async function(input: string | URL | Request, options: RequestInit = {}) {
    const isRequest = typeof context.Request !== 'undefined' && input instanceof context.Request;
    const isUrl = typeof context.URL !== 'undefined' && input instanceof context.URL;
    // The source reads the base even for a URL instance and before Request.url.
    const base = context.location.href;
    const url = isRequest ? new context.URL(input.url, base) : isUrl ? input : new context.URL(input, base);
    if (!Reflect.apply(callbacks.matchesSigning, null, [url.pathname])) {
      return Reflect.apply(fetch, null, [input, options]);
    }
    if (Reflect.apply(callbacks.matchesBehavior, null, [url.pathname])) {
      Reflect.apply(callbacks.reportBehavior, null, []);
    }
    // Unlike XHR, fetch reads the token first and always appends another a_bogus.
    if (tokens.token && !url.searchParams.has('msToken')) url.searchParams.append('msToken', tokens.token);
    if (isRequest) {
      // Keep the original .then call: body reading starts synchronously, continuation is deferred.
      return input.clone().text().then(text => {
        const contentType = input.headers?.get('content-type') || undefined;
        const signature = Reflect.apply(callbacks.sign, null, [url.search.slice(1), options.body ?? text, contentType]);
        url.searchParams.append('a_bogus', signature);
        const init: RequestCopy = {
          cache: input.cache, credentials: input.credentials, headers: input.headers,
          integrity: input.integrity, method: input.method, mode: input.mode,
          redirect: input.redirect, referrer: input.referrer, referrerPolicy: input.referrerPolicy,
        };
        if (input.body) init.body = text;
        else {
          setDesktopProperty(Object(options), 'body', options.body ?? text, options);
          if ((options.method || init.method || 'GET').toUpperCase() === 'GET' && text === '') {
            setDesktopProperty(Object(options), 'body', null, options);
          }
        }
        const request = new context.Request(url.href, init);
        return Reflect.apply(fetch, null, [request, options]);
      });
    }
    const signature = Reflect.apply(callbacks.sign, null, [url.search.slice(1), options.body]);
    url.searchParams.append('a_bogus', signature);
    return Reflect.apply(fetch, null, [isUrl ? url : url.href, options]);
  });
}
