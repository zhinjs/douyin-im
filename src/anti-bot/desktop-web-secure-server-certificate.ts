export interface DesktopWebSecureCertificateXhr {
  readonly readyState: number;
  readonly status: number;
  readonly response: unknown;
  onreadystatechange: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: string): void;
}

export interface DesktopWebSecureServerCertificateContext {
  readonly window: { readonly XMLHttpRequest?: unknown; readonly FormData?: unknown };
  readonly XMLHttpRequest: new () => DesktopWebSecureCertificateXhr;
  readonly localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  readonly Date: { now(): number };
  setTimeout(callback: () => void, milliseconds: number): unknown;
}

/** Raw _r result: cached entries are not validated by Desktop. Not a trust/PEM guarantee. */
export interface DesktopWebSecureServerCertificate { cert: unknown; sn: unknown }
export const DESKTOP_WEB_SECURE_SERVER_CERTIFICATE_KEY = 'security-sdk/s_sdk_server_cert_key';

/**
 * C860 wr/_r/hr/Je, one instance per isolated browser realm. Retrieves a SERVER
 * certificate, not a client certificate or a Session binding. No native fallback.
 */
export class DesktopWebSecureServerCertificates {
  private pending: Promise<DesktopWebSecureServerCertificate> | undefined;
  constructor(private readonly context: DesktopWebSecureServerCertificateContext) {}

  // Je shares one in-flight request across aid/cache arguments; first caller wins.
  get = (aid: number | string, useCache = true): Promise<DesktopWebSecureServerCertificate> => {
    if (!this.pending) {
      this.pending = new Promise((resolve, reject) => {
        this.readOrFetch(aid, useCache).then(resolve).catch(reject).finally(() => { this.pending = undefined; });
      });
    }
    return this.pending;
  };

  private readOrFetch(aid: number | string, useCache: boolean): Promise<DesktopWebSecureServerCertificate> {
    const now = this.context.Date.now();
    try {
      if (useCache) {
        const text = this.context.localStorage.getItem(DESKTOP_WEB_SECURE_SERVER_CERTIFICATE_KEY);
        if (text && typeof text === 'string') {
          const cached = JSON.parse(text);
          // Keep native JS addition/coercion and strict > boundary, including string timestamps.
          if (cached.createdTime + 86_400_000 > now) return Promise.resolve({ cert: cached.cert, sn: cached.sn });
        }
      }
      return this.requestWithTimeout(aid).then(response => {
        const { data = {} } = (response || {}) as { data?: { server_cert?: unknown; server_sn?: unknown } };
        const { server_cert: cert = '', server_sn: sn = '' } = data;
        if (!cert || !sn) return Promise.reject(new Error('get empty cert'));
        this.context.localStorage.setItem(DESKTOP_WEB_SECURE_SERVER_CERTIFICATE_KEY, JSON.stringify({ cert, sn, createdTime: this.context.Date.now() }));
        return { cert, sn };
      });
    } catch (error) { return Promise.reject(error); }
  }

  private async requestWithTimeout(aid: number | string): Promise<unknown> {
    const timeout = new Promise<never>((_resolve, reject) => {
      this.context.setTimeout(() => reject(new Error('get cert timeout')), 3000);
    });
    // Additive observer: if constructing XHR throws before race(), don't leak the timer rejection.
    // Does not replace the raced promise, cancel XHR, retry, or change the caller's result.
    void timeout.catch(() => undefined);
    return Promise.race([timeout, this.request(aid)]);
  }

  private request(aid: number | string): Promise<unknown> {
    if (!this.context.window.XMLHttpRequest || !this.context.window.FormData) return Promise.reject(new Error('not support XMLHttpRequest'));
    const xhr = new this.context.XMLHttpRequest();
    return new Promise((resolve, reject) => {
      xhr.open('POST', `/passport/ticket_guard/get_client_cert/?aid=${aid}&is_from_ttaccountsdk=1`);
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4 || !(xhr.status >= 200 && xhr.status < 300)) return;
        try {
          const response = JSON.parse(xhr.response as string);
          if (response.message !== 'success') reject(new Error(response?.data?.description || response.message || 'get cert error'));
          resolve(response);
        } catch (error) { reject(error); }
      };
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('Accept', 'application/json');
      // wr really joins form pairs with a comma, not '&'. Do not normalize it to URLSearchParams.
      xhr.send(`server_data=1,aid=${encodeURIComponent(String(aid))}`);
    });
  }
}
