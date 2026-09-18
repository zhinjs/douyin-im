export interface DesktopWebSecureTccXhr {
  readonly readyState: number;
  readonly status: number;
  readonly response: unknown;
  onreadystatechange: (() => void) | null;
  open(method: string, url: string, asynchronous: boolean): void;
  send(): void;
}

export interface DesktopWebSecureTccContext {
  readonly window: {
    readonly XMLHttpRequest?: unknown;
    readonly localStorage: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
    };
  };
  readonly XMLHttpRequest: new () => DesktopWebSecureTccXhr;
  readonly Date: new () => { getTime(): number };
}

export interface DesktopWebSecureTccQuery {
  tccPsm: string;
  zone?: string;
  key?: string;
}

const CACHE_KEY = 'ztsdk_tcc_config';

/**
 * One Web SecureSDK host's TCC state, not the account's native BDTicket settings.
 * Source uses synchronous XHR and leaves several failure cases pending. Do not
 * use completion as a login readiness barrier or interpret pending as empty config.
 */
export class DesktopWebSecureTcc {
  private initialized = false;
  private readonly configs: Record<string, unknown> = {};

  constructor(private readonly context: DesktopWebSecureTccContext) {}

  async getConfig({ tccPsm, zone = 'default', key }: DesktopWebSecureTccQuery): Promise<unknown> {
    const cacheId = `${tccPsm.split('.').join('-')}-${zone}`;
    const cached = this.readCache();
    let result: unknown;
    if (cached) result = cached;
    else if (this.initialized && this.configs[cacheId]) result = this.configs[cacheId];
    else if (this.initialized && !this.configs[cacheId]) {
      result = await this.fetchConfig(tccPsm, zone);
      this.configs[cacheId] = result;
    } else {
      result = await this.init(tccPsm, zone);
      this.configs[cacheId] = result;
    }
    return key ? (result as Record<string, unknown> | null | undefined)?.[key] || result : result;
  }

  private async init(tccPsm: string, zone: string): Promise<unknown> {
    this.initialized = true;
    return await this.fetchConfig(tccPsm, zone);
  }

  private readCache(): unknown {
    try {
      const raw = this.context.window.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { value, expire } = JSON.parse(raw);
      return new this.context.Date().getTime() > expire ? null : value;
    } catch { return null; }
  }

  private saveCache(value: unknown): void {
    try {
      const cached = { value, expire: new this.context.Date().getTime() + 21_600_000 };
      this.context.window.localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
    } catch { /* Original storage errors do not reject a successfully decoded response. */ }
  }

  private fetchConfig(tccPsm = 'ucenter.fe.ztsdk', zone = 'default'): Promise<unknown> {
    return new Promise(resolve => {
      if (!this.context.window.XMLHttpRequest) return;
      const xhr = new this.context.XMLHttpRequest();
      xhr.open('get', `https://lf3-config.bytetcc.com/obj/tcc-config-web/tcc-v2-data-${tccPsm}-${zone}`, false);
      // Assignment follows open, matching the original readyState event ordering.
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4 || xhr.status !== 200) return;
        try {
          const data = JSON.parse(xhr.response as string).data;
          if (!data || Object.keys(data).length === 0) return;
          Object.keys(data).forEach(key => { data[key] = JSON.parse(data[key]); });
          this.saveCache(data);
          resolve(data);
        } catch { /* No fabricated empty result: the source Promise stays pending. */ }
      };
      xhr.send();
    });
  }
}
