import type { DesktopWebSecureCertificateXhr } from './desktop-web-secure-server-certificate.js';

export const DESKTOP_DTRAIT_PARAMETERS_KEY = 'dtrait-sdk/s_sdk_server_cert_key';
export interface DesktopDTraitParametersContext {
  readonly window: {
    readonly XMLHttpRequest?: unknown;
    readonly FormData?: unknown;
  };
  readonly XMLHttpRequest: new () => DesktopWebSecureCertificateXhr;
  readonly document: { readonly cookie: string };
  readonly localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  readonly Date: { now(): number };
  atob(value: string): string;
  btoa(value: string): string;
  setTimeout(callback: () => void, milliseconds: number): unknown;
}
/** Raw container parameters, not validated certificates. Source accepts missing fields. */
export interface DesktopDTraitParameterResult extends Record<string, unknown> {
  centralRsaPub?: unknown;
  centralVersion?: unknown;
  edgeRsaPub?: unknown;
  edgeVersion?: unknown;
  urlVersion?: unknown;
  dTraitVersion?: unknown;
  dataFrom: 'local' | 'remote';
}

/** C860 ln/fn: one instance per isolated account browser realm, no native/server-cert fallback. */
export class DesktopDTraitParameters {
  private pending: Promise<DesktopDTraitParameterResult> | undefined;
  constructor(private readonly context: DesktopDTraitParametersContext) {}

  get = (
    aid: number | string | undefined,
    useCache = true
  ): Promise<DesktopDTraitParameterResult> => {
    if (!this.pending)
      this.pending = new Promise((resolve, reject) => {
        this.readOrFetch(aid, useCache)
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.pending = undefined;
          });
      });
    return this.pending; // Source coalesces across aid and useCache; first caller wins.
  };

  private readOrFetch(
    aid: number | string | undefined,
    useCache: boolean
  ): Promise<DesktopDTraitParameterResult> {
    try {
      if (useCache) {
        const cached = this.readCache();
        if (cached && !hasEmptyOwnField(cached))
          return Promise.resolve({ ...cached, dataFrom: 'local' });
        try {
          this.context.localStorage.removeItem(DESKTOP_DTRAIT_PARAMETERS_KEY);
        } catch {
          /* Source ignores remove failure. */
        }
      }
      return this.requestWithTimeout(aid)
        .then(async response => {
          const data = (response || {})['data'];
          if (hasEmptyOwnField(data)) throw new Error('get empty cert');
          const mapped = {
            centralRsaPub: data?.['x-tt-session-dtrait-pk1'],
            centralVersion: data?.['x-tt-session-dtrait-pk1-version'],
            edgeRsaPub: data?.['x-tt-session-dtrait-pk2'],
            edgeVersion: data?.['x-tt-session-dtrait-pk2-version'],
            urlVersion: data?.['x-tt-session-dtrait-fe-url-version'],
            dTraitVersion: data?.['x-tt-session-dtrait-version'],
          };
          try {
            this.context.localStorage.setItem(
              DESKTOP_DTRAIT_PARAMETERS_KEY,
              this.context.btoa(
                JSON.stringify({
                  ...mapped,
                  createdTime: this.context.Date.now(),
                })
              )
            );
          } catch {
            /* Source ignores encoding/quota failure and returns the remote result. */
          }
          // Original {...nn, ...mapped}: mapped always owns all six nn keys, even when undefined.
          return { ...mapped, dataFrom: 'remote' as const };
        })
        .catch(error => Promise.reject(error));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private readCache(): Record<string, unknown> | undefined | null {
    try {
      const text = this.context.localStorage.getItem(
          DESKTOP_DTRAIT_PARAMETERS_KEY
        ),
        now = this.context.Date.now();
      if (text && typeof text === 'string') {
        const { createdTime, ...cached } = JSON.parse(this.context.atob(text));
        // Keep raw JS concatenation/coercion and the strict expiry boundary.
        if (createdTime + 86_400_000 > now) return cached;
      }
    } catch {
      return null;
    }
    return undefined;
  }

  private async requestWithTimeout(
    aid: number | string | undefined
  ): Promise<Record<string, Record<string, unknown> | undefined>> {
    const timeout = new Promise<never>((_resolve, reject) => {
      this.context.setTimeout(
        () => reject(new Error('get cert timeout')),
        3000
      );
    });
    void timeout.catch(() => undefined); // Observe a timer left behind if constructing XHR throws before race.
    return Promise.race([timeout, this.request(aid)]);
  }

  private request(
    aid: number | string | undefined
  ): Promise<Record<string, Record<string, unknown> | undefined>> {
    if (!this.context.window.XMLHttpRequest || !this.context.window.FormData)
      return Promise.reject(new Error('not support XMLHttpRequest'));
    const xhr = new this.context.XMLHttpRequest();
    return new Promise((resolve, reject) => {
      xhr.open(
        'POST',
        `/passport/ticket_guard/get_client_cert/?aid=${aid}&type=trait&sdk_version=1.0.23&is_from_ttaccountsdk=1`
      );
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4 || !(xhr.status >= 200 && xhr.status < 300))
          return;
        try {
          const response = JSON.parse(xhr.response as string);
          if (response.message !== 'success')
            reject(
              new Error(
                response?.data?.description ||
                  response.message ||
                  'get cert error'
              )
            );
          resolve(response);
        } catch (error) {
          reject(error);
        }
      };
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('Accept', 'application/json');
      const read = (name: string) =>
        decodeURIComponent(
          this.context.document.cookie.replace(
            new RegExp(
              '(?:(?:^|.*;)\\s*' +
                encodeURIComponent(name).replace(/[-.+*]/g, '\\$&') +
                '\\s*\\=\\s*([^;]*).*$)|^.*$'
            ),
            '$1'
          )
        ) || null;
      xhr.setRequestHeader(
        'x-tt-passport-csrf-token',
        read('passport_csrf_token') || read('passport_csrf_token_default') || ''
      );
      xhr.send('server_data=1&need_session_dtrait=1');
    });
  }
}

/** yr deliberately tests existing fields only, using the object's own hasOwnProperty method. */
function hasEmptyOwnField(value: Record<string, unknown> | undefined): boolean {
  for (const key in value)
    if (
      // eslint-disable-next-line no-prototype-builtins -- yr intentionally throws for a shadowed hasOwnProperty; do not silently strengthen it.
      value.hasOwnProperty(key) &&
      (value[key] === null || value[key] === undefined || value[key] === '')
    )
      return true;
  return false;
}
