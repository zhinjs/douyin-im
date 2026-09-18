import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';
import {
  dispatchDesktopWebSecureSocketMessage, type DesktopWebSecureBridgeClient,
  type DesktopWebSecureBridgeMessage, type DesktopWebSecureSocketConfig, type DesktopWebSecureSocketEvent,
} from './desktop-web-secure-bridge.js';
import {
  DesktopWebSecureIframeHost, type DesktopWebSecureIframeConnection,
  type DesktopStorageConnectedFrame, type DesktopStorageFrameTarget,
} from './desktop-web-secure-iframe.js';

export interface DesktopWebSecureSocketOptions extends DesktopWebSecureSocketConfig {
  ackTimeout?: number;
  debug?: boolean | undefined;
  enableFallback?: boolean;
  downgradeCSPURL?: string | boolean;
  disablePreCheckConnection?: boolean;
}
export interface DesktopWebSecureSocketContext {
  window: DesktopStorageFrameTarget & { parent: DesktopStorageFrameTarget };
  writeLocalStorage(key: string, value: string): void;
  /** Native fire-and-forget connection failures are observed, without changing the stored Promise. */
  onBackgroundError?: (error: unknown) => void;
}
export interface DesktopWebSecureSocketConnection { target: DesktopStorageConnectedFrame; startTime: number; endTime: number }
interface SocketEvents extends Record<string, unknown> {
  message: DesktopWebSecureBridgeMessage;
  connection: DesktopWebSecureSocketConnection;
  connectionFail: Error;
  error: Error;
  config: undefined;
}

/** Se client, wired to ye and the origin/protocol dispatcher. Not a login-readiness barrier. */
export class DesktopWebSecureSocket extends DesktopWebSecureEvents<SocketEvents> implements DesktopWebSecureBridgeClient {
  config: DesktopWebSecureSocketOptions;
  readonly iframeConnection: DesktopWebSecureIframeConnection;
  window: Promise<DesktopWebSecureSocketConnection> | undefined;
  isStart: boolean | undefined;
  isConnection: boolean | undefined;
  loadTime = 0;
  startTime = 0;
  endTime = 0;
  private parentCallIndex = 0;
  private readonly originSuffix: string;

  constructor(private readonly host: DesktopWebSecureIframeHost, private readonly context: DesktopWebSecureSocketContext, config: DesktopWebSecureSocketOptions = {}) {
    super(); this.originSuffix = host.originSuffix;
    this.config = { protocol: 'Common', ...config };
    this.iframeConnection = host.createConnection();
    this.startConnection('init');
    this.on('config', () => { this.startConnection('config'); });
    this.initMessageEvent();
    this.on('connection', connection => {
      this.loadTime = connection.endTime - connection.startTime; this.startTime = connection.startTime; this.endTime = connection.endTime; this.isConnection = true;
      if (this.config.enableFallback && !connection.target.fallback) try { context.writeLocalStorage('X_STORAGE_FALLBACK_VERSION', '4.0.3'); } catch { /* Native fallback hint is best effort. */ }
      this.emit('debug', { name: 'ConnectionSuccess' }); this.initMessageEvent();
    });
    for (const name of ['debug', 'log', 'metrics']) this.iframeConnection.on(name, event => { this.emit(name, event); });
    this.on('connectionFail', error => {
      const downgrade = this.config.downgradeCSPURL;
      this.isConnection = false; this.emit('error', this.host.error(`Connection:${error.name}`, error.message)); this.emit('debug', { name: 'connectionFail' });
      if (downgrade && error?.message.indexOf('Content Security Policy') !== -1) {
        const url = typeof downgrade === 'string' ? downgrade : host.resourceURL('https://lf-zt.douyin.com/obj/uc-assets/zt/', undefined, 'page');
        if (url && this.config.url !== url) { this.emit('debug', { name: 'fireDefaultPageURL', content: url }); this.config.url = url; this.reStartConection('csp'); }
      }
    });
    host.context.addMessageListener(event => {
      if (typeof event.data === 'string') {
        if (event.data.indexOf('SOCKET_ERROR_') !== -1) this.emit('error', host.error('SCOKET_ERROR', event.data));
        else if (event.data.indexOf('Version:') !== -1) this.emit('debug', { name: 'SocketVersion', content: event.data.split(':')[1] });
      }
    });
  }

  listen = (): void => { const window = this.context.window; if (window.parent !== window) window.parent.postMessage('ACK', '*'); };
  getIframeState = (): { isConnection: number; retryCount: number; startTime: number; endTime: number; loadTime: number; origin: string } => ({
    isConnection: typeof this.isConnection === 'boolean' ? Number(Boolean(this.isConnection)) : -1,
    retryCount: this.iframeConnection.autoLoadIframeConfig.current, startTime: this.startTime, endTime: this.endTime, loadTime: this.loadTime, origin: this.host.context.origin,
  });
  postIframeMessage = (message: unknown): Promise<void> => {
    const protocol = this.config.protocol;
    if (this.window) {
      const url = this.config.url;
      return this.window.catch(() => this.reConnection()).then(connection => { connection.target.postMessage({ protocol, data: message }, origin(url!)); });
    }
    return Promise.reject(this.host.error('postMessageError'));
  };
  postWindowMessage = (target: DesktopStorageFrameTarget, type: unknown, data: unknown, targetOrigin = '*'): Promise<void> => {
    const protocol = this.config.protocol;
    return new Promise(resolve => { target.postMessage({ type, protocol, data }, targetOrigin); resolve(); });
  };
  postParentMessage = (type: unknown, data: unknown, targetOrigin = '*'): Promise<void> => {
    const window = this.context.window; return window.parent !== window ? this.postWindowMessage(window.parent, type, data, targetOrigin) : Promise.resolve();
  };
  dispatchParentEvent = (eventName: unknown, eventData: unknown): Promise<void> => this.postParentMessage('event', { id: `p-${this.parentCallIndex++}`, message: { eventName, eventData } });
  callParentBridge = (callObj: unknown, callName: unknown, callArgs?: unknown): Promise<unknown> => {
    const id = `p-${this.parentCallIndex++}`;
    return Promise.race([new Promise((resolve, reject) => {
      const receive = (event: DesktopWebSecureBridgeMessage) => {
        const data = event.data as { id: string; promiseStatus?: string; message?: unknown };
        if (data.id === id) {
          this.off('message', receive);
          if (data.promiseStatus === 'reject') reject(this.host.error(`${data.message || 'UNKNOW_CallParentBridge_Error'}`)); else resolve(data.message);
        }
      };
      this.on('message', receive);
      this.postParentMessage('function', { id, message: { callObj, callName, callArgs } }).catch(reject);
    }), new Promise((_resolve, reject) => {
      this.host.context.setTimeout(() => { reject(this.host.error('CallParentBridgeInvokeTimeout', `CallBridge invoke timeout: callObj=${callObj};callName=${callName};`)); }, 5000);
    })]);
  };
  startConnection = (reason: string): void => {
    const url = this.config.url;
    if (!this.window && url) { this.isStart = true; this.isConnection = undefined; this.emit('log', { name: `startConnection:${reason}` }); this.createConnection(url); }
  };
  reStartConection = (reason: string): void => {
    this.isStart = false;
    if (this.window) void this.window.then(connection => { connection.target.destory(); }).catch(() => undefined);
    this.window = undefined; this.iframeConnection.reset(); this.startConnection(reason);
  };
  start = (config?: DesktopWebSecureSocketOptions): Promise<void> => new Promise(resolve => {
    this.config = { ...this.config, ...config }; this.isStart = true; this.emit('config', undefined); resolve();
  });
  reConnection = (): Promise<DesktopWebSecureSocketConnection> => this.createConnection(this.config.url);
  preCheck = (): Promise<void> => {
    if (this.isConnection && this.isStart && this.window) return this.window.then(connection => { if (!connection.target.isValid()) this.reStartConection('valid'); });
    if (!this.config.disablePreCheckConnection && this.isConnection === false && this.iframeConnection.autoLoadIframeConfig.current >= this.iframeConnection.autoLoadIframeConfig.max) this.reStartConection('reConnection');
    return Promise.resolve();
  };
  onMessage = (event: DesktopWebSecureSocketEvent): void => {
    dispatchDesktopWebSecureSocketMessage(this.config, event, { originSuffix: this.originSuffix,
      emit: (name, data) => { if (name === 'message') this.emit('message', data as DesktopWebSecureBridgeMessage); else this.emit(name, data); },
    });
  };
  initMessageEvent = (): void => { this.removeMessageEvent(); this.host.context.addMessageListener(this.onMessage); this.emit('debug', { name: 'initMessageEvent' }); };
  /** Native misnomer: adds the same listener again, NOT teardown. Browser deduplication still applies. */
  removeMessageEvent = (): void => { this.host.context.addMessageListener(this.onMessage); };
  createConnection(url?: string): Promise<DesktopWebSecureSocketConnection> {
    const ackTimeout = this.config.ackTimeout, startTime = this.host.now(), max = this.iframeConnection.autoLoadIframeConfig.max;
    this.iframeConnection.setConfig({ url: max > 10 ? query(url!, `t=${max}`) : url, ackTimeout });
    const pending = this.iframeConnection.start().then(target => {
      const result = { target, startTime, endTime: this.host.now() }; this.emit('connection', { ...result }); return result;
    }).catch((error: Error) => { this.emit('connectionFail', this.host.error(`${error.name || 'ConnectionError'}`, error.message)); throw error; });
    this.window = pending;
    void pending.catch(error => { try { this.context.onBackgroundError?.(error); } catch { /* Preserve the original connection result. */ } });
    return pending;
  }
}
function origin(url: string): string { const parts = url.split('//'); return `${parts[0]}//${parts[1]!.split('/')[0]}`; }
function query(url: string, value: string): string { return `${url}${url.indexOf('html?') !== -1 ? '&' : '?'}${value}`; }
