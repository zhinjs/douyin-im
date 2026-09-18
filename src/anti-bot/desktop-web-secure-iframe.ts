import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';

export interface DesktopStorageFrameTarget { postMessage(data: unknown, targetOrigin: string): void }
export interface DesktopStorageFrameNode { parentNode: DesktopStorageFrameParent | null }
export interface DesktopStorageFrameParent extends DesktopStorageFrameNode {
  appendChild(node: DesktopStorageFrameNode): unknown;
  removeChild(node: DesktopStorageFrameNode): unknown;
}
export interface DesktopStorageFrameContainer extends DesktopStorageFrameParent { style: { display: string }; id: string }
export interface DesktopStorageFrameElement extends DesktopStorageFrameNode {
  style: { display: string }; src: string;
  contentWindow: DesktopStorageFrameTarget | null;
  onload: (() => void) | null;
}
export interface DesktopStorageFrameEvent { data: unknown; origin: string; source: DesktopStorageFrameTarget | null }
export interface DesktopStorageIframeContext {
  origin: string;
  document: {
    body: DesktopStorageFrameParent | null; readyState: string; visibilityState: string;
    getElementById(id: string): DesktopStorageFrameParent | null;
    createElement(tag: 'iframe'): DesktopStorageFrameElement;
    createElement(tag: 'div'): DesktopStorageFrameContainer;
    addEventListener(name: 'DOMContentLoaded' | 'visibilitychange', listener: () => void): void;
    removeEventListener(name: 'DOMContentLoaded' | 'visibilitychange', listener: () => void): void;
  };
  navigator: { userAgent: string; userAgentData?: unknown; storage?: { getDirectory?: unknown }; canShare?: unknown };
  window: { Promise?: { allSettled?: unknown }; visualViewport?: unknown };
  performance: { now?: () => number };
  Date: { now(): number }; Math: { random(): number };
  readLocalStorage(key: string): string | null;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  addMessageListener(listener: (event: DesktopStorageFrameEvent) => void): void;
  removeMessageListener(listener: (event: DesktopStorageFrameEvent) => void): void;
}
export interface DesktopStorageIframeConfig { ackTimeout?: number | undefined; url?: string | undefined; debug?: boolean }
export interface DesktopStorageConnectedFrame {
  startTime: number; endTime: number; fallback?: boolean;
  postMessage(data: unknown, targetOrigin?: string): void;
  /** Native spelling, consumed by Se.reStartConection. */
  destory(): void;
  isValid(): boolean;
}

/** One realm owns URL capability selection, container identity and flight retry counters. */
export class DesktopWebSecureIframeHost {
  readonly flightErrors = { current: 0, max: 2 };
  readonly boxId: string;
  readonly originSuffix: string;
  private readonly latest: boolean;

  constructor(readonly context: DesktopStorageIframeContext) {
    this.latest = this.supportsLatest(); this.boxId = `J_uc_iframe_box-${context.Date.now()}`;
    this.originSuffix = `.${context.origin.split('.').slice(-2).join('.')}`;
  }
  createConnection(config: DesktopStorageIframeConfig = {}): DesktopWebSecureIframeConnection { return new DesktopWebSecureIframeConnection(this, config); }
  resourceURL(base: string, version?: string, flavor?: string): string { return `${base}@byted/x-storage-web/${version || '4.0.3'}/dist/${flavor || (this.latest ? 'latest' : 'page')}/index.html`; }
  fallbackURL(): string | undefined {
    let version: string | null | undefined;
    try { version = this.context.readLocalStorage('X_STORAGE_FALLBACK_VERSION'); } catch { /* Native missing fallback. */ }
    return version ? this.resourceURL('https://lf-zt.douyin.com/obj/uc-assets/zt/', version) : undefined;
  }
  now(): number { return this.context.performance.now && Number(this.context.performance.now().toFixed(0)) || this.context.Date.now(); }
  error(name: string, message = ''): Error { return Object.assign(new Error(message || ''), { name, origin: this.context.origin }); }
  container(): Promise<{ appendChild(frame: DesktopStorageFrameNode): unknown }> {
    return new Promise(resolve => {
      const document = this.context.document;
      const wrapper = { appendChild: (frame: DesktopStorageFrameNode) => {
        let box = document.getElementById(this.boxId);
        if (!box) { const div = document.createElement('div'); div.style.display = 'none'; div.id = this.boxId; document.body!.appendChild(div); box = div; }
        return box.appendChild(frame);
      } };
      if (document.body) resolve(wrapper);
      else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { resolve(wrapper); });
      else resolve(wrapper);
    });
  }
  private supportsLatest(): boolean {
    return isDesktopWebSecureModernBrowser(this.context);
  }
}

/** vt: capability heuristic, despite Keys calling it isTopBrowser. Does not test window.top. */
export function isDesktopWebSecureModernBrowser(context: Pick<DesktopStorageIframeContext, 'navigator' | 'window'>): boolean {
    try {
      const { navigator, window } = context;
      return Boolean(navigator.userAgent.match(/chrome\/[\d.]+/gi)) && Boolean(navigator?.userAgentData)
        || Boolean(navigator.storage?.getDirectory) || Boolean(navigator.canShare)
        || ((window.Promise?.allSettled || '') as { toString(): string }).toString().indexOf('[native code]') !== -1
          && Boolean(Number((navigator.userAgent.match(/Chrome\/(\d+\.+\d+)/) || [])[1]) >= 76 && window.visualViewport);
    } catch { return false; }
}

/** Source ye. Connection fulfillment alone is not proof of durable storage or usable keys. */
export class DesktopWebSecureIframeConnection extends DesktopWebSecureEvents {
  readonly autoLoadIframeConfig: { max: number; current: number; iframeLoadPromise: Promise<DesktopStorageConnectedFrame> | null } = { max: 10, current: 0, iframeLoadPromise: null };
  config: DesktopStorageIframeConfig;
  constructor(private readonly host: DesktopWebSecureIframeHost, config: DesktopStorageIframeConfig) { super(); this.config = { ackTimeout: 2000, ...config }; }
  reset = (): void => {
    const state = this.autoLoadIframeConfig; if (state.current >= state.max) state.max += 10;
    state.iframeLoadPromise = null; if (this.host.flightErrors.current >= this.host.flightErrors.max) this.host.flightErrors.max += 3;
  };
  setConfig(config: DesktopStorageIframeConfig): void { this.config = { ackTimeout: config.ackTimeout || this.config.ackTimeout, url: config.url || this.config.url }; }
  start(): Promise<DesktopStorageConnectedFrame> { const state = this.autoLoadIframeConfig; return state.iframeLoadPromise = state.iframeLoadPromise || this.loadWindow(); }
  loadWindow = (): Promise<DesktopStorageConnectedFrame> => {
    const { url, ackTimeout } = this.config, state = this.autoLoadIframeConfig, context = this.host.context;
    return new Promise<void>(resolve => { context.setTimeout(resolve, state.current === 0 ? 0 : 100); }).then(() => {
      if (!url) throw new Error('URL Error');
      return this.createIframeElement(state.current === state.max ? query(url, `t=${context.Date.now()}`) : url, ackTimeout);
    }).catch(error => {
      if (state.current >= state.max) {
        if (context.document.visibilityState === 'hidden') return new Promise(resolve => {
          const visible = () => { if (context.document.visibilityState !== 'hidden') { context.document.removeEventListener('visibilitychange', visible); resolve(1); } };
          context.document.addEventListener('visibilitychange', visible);
        }).then(() => this.loadWindow().then(frame => { this.emit('log', { name: 'visibilityChangeLoadWindowSuccuess' }); return frame; }));
        const fallback = this.host.fallbackURL();
        if (fallback) {
          this.emit('debug', { name: 'StartFireFallbackURL', content: fallback });
          return this.createIframeElement(fallback, ackTimeout).then(frame => { this.emit('debug', { name: 'EndFireFallbackURL', content: fallback }); frame.fallback = true; return frame; })
            .catch(failure => { this.emit('debug', { name: 'fireFallbackURLError', content: `${failure?.name}:${failure?.message}` }); throw error; });
        }
        throw error;
      }
      state.current++; return this.loadWindow();
    });
  };

  createPostMessageFlight = (post: (data: string) => void, timeout = 3000): Promise<void> => {
    const context = this.host.context, start = this.host.now(); let end = start, timer: unknown;
    const metrics = (status: string) => { if (this.config.debug) this.emit('metrics', { name: 'PostMessageFlight', metrics: { startTime: start, endTime: end, loadTime: end - start }, categories: { status, retryCount: String(this.host.flightErrors.current), version: '4.0.3' } }); };
    return Promise.race([new Promise<void>((resolve, reject) => {
      const token = `ACK_0_${context.Math.random()}`;
      const receive = (event: DesktopStorageFrameEvent) => { if (event.data === `ACK_1_${token}`) { context.clearTimeout(timer); end = this.host.now(); resolve(); context.removeMessageListener(receive); } };
      context.addMessageListener(receive);
      try { post(token); } catch (error) { reject(this.host.error('PostMessageWindowError', (error as Error | null)?.message)); }
    }), new Promise<void>((_resolve, reject) => { timer = context.setTimeout(() => { end = this.host.now(); reject(this.host.error('PostMessageTimeout')); }, timeout); })])
      .then(() => { metrics('1'); }).catch(error => { metrics('0'); throw error; });
  };

  createIframeElement(url: string, ackTimeout?: number): Promise<DesktopStorageConnectedFrame> {
    const context = this.host.context, timeout = ackTimeout || this.config.ackTimeout, state = this.autoLoadIframeConfig;
    let source: DesktopStorageFrameTarget | null = null, ackTimer: unknown, mainTimer: unknown;
    const start = this.host.now(), frame = context.document.createElement('iframe');
    let loaded = start, ack = false, status = -1;
    frame.style.display = 'none'; frame.src = url;
    return this.host.container().then(container => {
      const pending = Promise.race([new Promise<void>((_resolve, reject) => {
        frame.onload = () => { loaded = this.host.now(); if (!ack) ackTimer = context.setTimeout(() => {
          if (!ack) reject(this.host.error('CreateIframeError', JSON.stringify({ startTime: start, endTime: loaded, loadTime: loaded - start, visibility: context.document.visibilityState, current: state.current, max: state.max })));
        }, timeout || 2000); };
      }), new Promise<void>((resolve, reject) => {
        const receive = (event: DesktopStorageFrameEvent) => { try {
          if (status === -1 && event.data === 'ACK' && frameOrigin(url) === event.origin) {
            ack = true; source = event.source; context.clearTimeout(ackTimer); context.clearTimeout(mainTimer); resolve(); context.removeMessageListener(receive);
          }
        } catch (error) { reject(error); } };
        context.addMessageListener(receive);
      }), new Promise<void>((_resolve, reject) => { mainTimer = context.setTimeout(() => { reject(this.host.error('CreateIframeMainTimeout')); }, 120000); })]);
      container.appendChild(frame); return pending;
    }).then(() => this.createPostMessageFlight(data => { (frame.contentWindow || source)!.postMessage(data, frameOrigin(url)); }).catch(error => {
      if (error.name !== 'PostMessageWindowError') throw error;
      if (this.host.flightErrors.current < this.host.flightErrors.max) { this.host.flightErrors.current++; throw error; }
      // Native falls through after its global error budget; not proof of a successful flight.
    })).then(() => {
      if (!frame.parentNode) throw new Error('CreateIframeElementError');
      status = 1;
      return { startTime: start, endTime: this.host.now(),
        postMessage: (data: unknown, targetOrigin?: string) => { (frame.contentWindow || source)!.postMessage(data, targetOrigin || '*'); },
        destory: () => { try { frame.parentNode?.removeChild(frame); } catch { /* Native best effort. */ } },
        isValid: () => Boolean(frame.parentNode && frame.parentNode?.parentNode),
      };
    }).catch(error => {
      status = 0; try { frame.parentNode?.removeChild(frame); } catch { /* Native best effort. */ }
      try { if (error.name === 'CreateIframeMainTimeout') this.emit('debug', { name: 'CreateIframeMainTimeout' }); } catch { /* Native diagnostic isolation. */ }
      throw error;
    });
  }
}
function frameOrigin(url: string): string { const parts = url.split('//'); return `${parts[0]}//${parts[1]!.split('/')[0]}`; }
function query(url: string, value: string): string { return `${url}${url.indexOf('html?') !== -1 ? '&' : '?'}${value}`; }
