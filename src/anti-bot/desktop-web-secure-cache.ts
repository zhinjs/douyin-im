import { desktopWebSecureCookieDomain } from './desktop-web-secure-cookie.js';

export interface DesktopWebSecureCacheContext {
  readonly document: { cookie: string; readonly location: { readonly hostname: string } };
  readonly Math: { random(): number };
  /** Observe detached cache bookkeeping failures without replacing the caller's result. */
  readonly onBackgroundError?: (error: unknown) => void;
}

export interface DesktopWebSecureCacheSummary {
  total: number; hit: number; pending: number; miss: number; missKeys: string[];
}

interface GetterOptions<A extends unknown[], R, P> {
  extractKeysFromArgs?: (args: A) => string | string[];
  extractDataFromResponse?: (response: Awaited<R>, args: A) => Record<string, unknown>;
  packData?: (data: Record<string, unknown>, args: A, summary: DesktopWebSecureCacheSummary, responses?: unknown[]) => P;
}

/** Web storage coherence only. Values may be private keys: do not log or share instances across accounts. */
export class DesktopWebSecureMemoryCache {
  private readonly store = new Map<string, { value: unknown; version: string }>();
  private readonly queue = new Map<string, Promise<Record<string, unknown>>>();
  private disabled = false;

  constructor(private readonly context: DesktopWebSecureCacheContext, private readonly agId: string | number | undefined) {}

  setDisabled = (disabled: boolean): void => { this.disabled = disabled; };
  isEnabled = (): boolean => !this.disabled;
  clear = (): void => { this.store.clear(); this.queue.clear(); };

  wrapGetter = <A extends unknown[], R, P = Record<string, unknown>>(
    read: (...args: A) => R, options: GetterOptions<A, R, P>,
  ): ((...args: A) => R | Promise<P>) => (...args) => {
    if (this.disabled) return Reflect.apply(read, null, args);
    const keys = options.extractKeysFromArgs ? options.extractKeysFromArgs(args) : args[0];
    if (!Array.isArray(keys) && typeof keys !== 'string') return Promise.reject(new Error('keys must be string or string[]'));
    return this.get(Array.isArray(keys) ? keys : [keys],
      missing => Reflect.apply(read, undefined, [missing]) as Promise<Awaited<R>>,
      response => options.extractDataFromResponse ? options.extractDataFromResponse(response as Awaited<R>, args) : response as Record<string, unknown>,
      (data, summary, responses) => options.packData ? options.packData(data, args, summary, responses) : data as P);
  };

  wrapSetter = <A extends unknown[], R>(
    write: (...args: A) => R, options: { extractDataFromArgs: (args: A) => Record<string, unknown> },
  ): ((...args: A) => R) => (...args) => {
    if (this.disabled) return Reflect.apply(write, null, args);
    const data = options.extractDataFromArgs(args) || {};
    const keys = Object.keys(data);
    const result = Reflect.apply(write, null, args) as R;
    this.observe(Promise.resolve(result).then(() => {
      keys.forEach(key => {
        const value = data[key], previous = this.store.get(key);
        if (previous && this.equal(value, previous.value)) return;
        this.store.set(key, { value, version: this.updateVersion(key) });
      });
    }));
    return result;
  };

  wrapUpdater = <A extends unknown[], R>(
    update: (...args: A) => R,
    extractKeys: (args: A) => string | string[] = args => args[0] as string | string[],
    mode = 'update',
  ): ((...args: A) => R) => (...args) => {
    if (this.disabled) return Reflect.apply(update, null, args);
    const keys = extractKeys(args);
    const result = Reflect.apply(update, null, args) as R;
    this.observe(Promise.resolve(result).then(() => {
      (Array.isArray(keys) ? keys : [keys]).forEach(key => {
        if (mode === 'delete') this.clearVersion(key);
        else this.updateVersion(key);
      });
    }));
    return result;
  };

  private get<P>(keys: string[], read: (keys: string[]) => Promise<unknown>, extract: (response: unknown) => Record<string, unknown>,
    pack: (data: Record<string, unknown>, summary: DesktopWebSecureCacheSummary, responses?: unknown[]) => P): Promise<P> {
    const missing: string[] = [], pending: string[] = [], hits: Record<string, unknown> = {};
    keys.forEach(key => {
      if (!this.needUpdate(key) && this.store.has(key)) hits[key] = this.store.get(key)?.value;
      else if (this.queue.has(key)) pending.push(key);
      else missing.push(key);
    });
    if (!missing.length && !pending.length) return Promise.resolve(pack(hits, {
      total: keys.length, hit: keys.length, pending: 0, miss: 0, missKeys: [],
    }));
    const waiting = pending.map(key => this.queue.get(key)!);
    const batch = missing.length ? read(missing).then(response => {
      Object.entries(extract(response)).forEach(([key, value]) => {
        if (value === '' || value === undefined) return;
        const cookie = this.readVersion(key);
        const version = cookie && !this.store.has(key) ? cookie : this.updateVersion(key);
        this.store.set(key, { value, version });
      });
      // Source invokes the extractor twice; do not assume it is side-effect free.
      return extract(response);
    }) : Promise.resolve(hits);
    missing.forEach(key => {
      const item = batch.then(data => ({ [key]: data?.[key] }));
      this.queue.set(key, item);
      // Observe, but retain this exact promise (including rejection) in the queue.
      this.observe(item);
    });
    return Promise.all([batch, ...waiting]).then(responses => {
      const combined = responses.reduce((result, value) => Object.assign({}, result, value), {});
      return pack(Object.assign({}, hits, combined), {
        total: keys.length, hit: keys.length - (waiting.length + missing.length),
        pending: waiting.length, miss: missing.length, missKeys: missing,
      }, responses);
    });
  }

  private needUpdate(key: string): boolean {
    if (this.store.has(key) && this.readVersion(key) !== this.store.get(key)?.version) {
      this.store.delete(key); this.queue.delete(key); return true;
    }
    return !this.store.has(key);
  }

  private cookieKey(key: string): string {
    return `__security_mc_${this.agId}_${key.replace(/\//g, '_').replace(/^security-sdk_s_sdk/, 'sk')}`;
  }

  private readVersion(key: string): string | null {
    const cookieKey = this.cookieKey(key), cookies = this.context.document.cookie;
    const escaped = encodeURIComponent(cookieKey).replace(/[-.+*]/g, '\\$&');
    return decodeURIComponent(cookies.replace(
      new RegExp(`(?:(?:^|.*;)\\s*${escaped}\\s*\\=\\s*([^;]*).*$)|^.*$`), '$1')) || null;
  }

  private updateVersion(key: string): string {
    const version = 'xxxxxxxx-4xxx-yxxx'.replace(/[xy]/g, char => {
      const random = 16 * this.context.Math.random() | 0;
      return (char === 'x' ? random : 3 & random | 8).toString(16);
    });
    const cookieKey = this.cookieKey(key), domain = this.domain();
    this.context.document.cookie = `${encodeURIComponent(cookieKey)}=${encodeURIComponent(version)}; max-age=5184000${domain ? `; domain=${domain}` : ''}; path=/`;
    return version;
  }

  private clearVersion(key: string): void {
    const cookieKey = this.cookieKey(key), hostname = this.context.document.location.hostname, domain = this.domain();
    for (const target of [hostname, domain, undefined]) {
      this.context.document.cookie = `${encodeURIComponent(cookieKey)}=; expires=Thu, 01 Jan 1970 00:00:00 UTC${target ? `; domain=${target}` : ''}; path=/`;
    }
  }

  private domain(): string {
    return desktopWebSecureCookieDomain(() => this.context.document.location.hostname);
  }

  private equal(left: unknown, right: unknown): boolean {
    if (typeof left !== typeof right) return false;
    if (typeof left === 'string' && typeof right === 'string') return left === right;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }

  private observe(promise: Promise<unknown>): void {
    void promise.catch(error => { try { this.context.onBackgroundError?.(error); } catch { /* Do not replace the original operation's result. */ } });
  }
}
