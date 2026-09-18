export interface DesktopWebSecureBridgeMessage { data: unknown }
export interface DesktopWebSecureBridgeClient {
  window: Promise<unknown> | undefined;
  isConnection?: boolean | undefined;
  config: { debug?: boolean | undefined };
  preCheck(): Promise<unknown>;
  postIframeMessage(message: { id: string; message: { callObj: string; callName: string; callArgs: unknown } }): Promise<unknown>;
  getIframeState(): unknown;
  reStartConection(reason: string): void;
  on(name: 'message', listener: (message: DesktopWebSecureBridgeMessage) => void): unknown;
  off(name: 'message', listener: (message: DesktopWebSecureBridgeMessage) => void): unknown;
  emit(name: 'debug', event: { name: string; content?: string }): unknown;
}
export interface DesktopWebSecureBridgeContext {
  readonly origin: string;
  readonly performance: { now?: () => number };
  readonly Date: { now(): number };
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  addMessageListener(listener: (event: { data: unknown }) => void): void;
}

/** De's shared state belongs to one browser realm, not to a single call or account-global singleton. */
export class DesktopWebSecureBridgeHost {
  private nextId = 0;
  private retryBeforeId = -1;
  private retry: Promise<void> | null = null;
  private messageLogEnabled = false;
  private readonly entries: Record<string, { st?: number; et?: number; timeout?: number }> = {};

  constructor(private readonly context: DesktopWebSecureBridgeContext) {}

  createBridge(client: DesktopWebSecureBridgeClient, retryTimeout = false, timeout = 8000): (callObj: string, callName: string, callArgs?: unknown) => Promise<unknown> {
    const post = client.postIframeMessage;
    return (callObj, callName, callArgs) => {
      let timer: unknown;
      const sequence = this.nextId++, id = `${sequence}`;
      if (typeof callObj !== 'string' || typeof callName !== 'string') return Promise.reject(this.error('CallBridgeParameterError', `callObj:${callObj}, callName:${callName}`));
      const send = () => client.window!.then(() => new Promise((resolve, reject) => {
        const receive = (event: DesktopWebSecureBridgeMessage) => {
          try {
            const data = event.data as { id: string; promiseStatus?: string; message?: unknown };
            const entry = this.entries[id];
            if (data.id === id && entry && !entry.et) {
              entry.et = this.now(); client.emit('debug', { name: `BackPostMessageId=${id}` });
              this.context.clearTimeout(timer); client.off('message', receive);
              if (data.promiseStatus === 'reject') reject(this.error(`${data.message || 'UNKNOW_CallBridge_Error'}`));
              else resolve(data.message);
              delete this.entries[id];
            }
          } catch (error) { reject(error); }
        };
        client.on('message', receive);
        post({ id, message: { callObj, callName, callArgs } }).catch(reject);
      }));
      const invoke = (delay: number) => {
        client.emit('debug', { name: `PostMessageId=${id}`, content: `${callObj}:${callName}` });
        this.entries[id] = {}; this.entries[id]!.st = this.now();
        return Promise.race([send(), new Promise((_resolve, reject) => {
          timer = this.context.setTimeout(() => {
            this.entries[id]!.timeout = this.now();
            reject(this.error(`CallBridgeInvokeTimeout:${callObj}:${callName}`, `${JSON.stringify({ iframe: client.getIframeState(), id })}`));
          }, delay);
        })]);
      };
      return client.preCheck().then(() => invoke(timeout)).catch(error => {
        if (client.isConnection === true && retryTimeout && ((error as { name?: string } | null)?.name || '').indexOf('CallBridgeInvokeTimeout') !== -1) {
          const older = sequence < this.retryBeforeId, boundary = this.nextId;
          client.emit('debug', { name: 'reCallBridgeWhenTimeout', content: JSON.stringify({ isTimeoutId: older, $MessageId: boundary, $id: sequence, callName, reCallBridgeWhenTimeout: Boolean(this.retry) }) });
          this.retry = this.retry && older ? this.retry : new Promise(resolve => {
            this.retryBeforeId = boundary;
            this.enableMessageLog(client);
            client.reStartConection('callBridge'); resolve();
          });
          return this.retry.then(() => invoke(8000));
        }
        throw error;
      });
    };
  }

  private enableMessageLog(client: DesktopWebSecureBridgeClient): void {
    if (!this.messageLogEnabled && client.config.debug) {
      this.messageLogEnabled = true; client.emit('debug', { name: 'OpenMessageLog' });
      this.context.addMessageListener(event => {
        if (this.messageLogEnabled && typeof event.data === 'string' && event.data.indexOf('log:') === 0) client.emit('debug', { name: `Message:Log=${event.data.substring(4)}` });
      });
    }
  }

  private now(): number { return this.context.performance.now && Number(this.context.performance.now().toFixed(0)) || this.context.Date.now(); }
  private error(name: string, message = ''): Error { return Object.assign(new Error(message || ''), { name, origin: this.context.origin }); }
}

export interface DesktopWebSecureSocketEvent {
  origin: string;
  data: unknown;
  source: { postMessage(message: unknown, targetOrigin: string): void } | null;
}
export interface DesktopWebSecureSocketConfig { url?: string | undefined; protocol?: string | undefined; allowOrigin?: string[] | undefined }
export interface DesktopWebSecureSocketDispatcher {
  /** Capture Se's module-level origin suffix in the owner, rather than recalculating per event. */
  originSuffix: string;
  emit(name: 'debug' | 'message', event: unknown): unknown;
}

/** Se.onMessage, before De. Keep this origin/protocol gate when wiring a browser host. */
export function dispatchDesktopWebSecureSocketMessage(config: DesktopWebSecureSocketConfig, event: DesktopWebSecureSocketEvent, dispatcher: DesktopWebSecureSocketDispatcher): void {
  const report = (code: number, detail: string | undefined) => {
    try { event.source?.postMessage(`SOCKET_ERROR_${code}@${detail}`, event.origin); } catch { /* Native best-effort diagnostic. */ }
  };
  try {
    const url = config.url, allow = config.allowOrigin === undefined ? [] : config.allowOrigin;
    const sameOrigin = !!url && storageSocketOrigin(url) === event.origin;
    const accepted = url ? sameOrigin : Boolean([dispatcher.originSuffix, ...allow].filter(origin => event.origin.lastIndexOf(origin) !== -1)[0]);
    try { if (!event.origin) dispatcher.emit('debug', { name: 'eventLostOrigin', content: JSON.stringify(event.data || {}) }); } catch { /* Native diagnostic is isolated. */ }
    if (!accepted) return;
    if (typeof event.data === 'string' && event.data.indexOf('ACK_0_') === 0) {
      try { event.source?.postMessage(`ACK_1_${event.data}`, event.origin); } catch { /* Native ACK is best effort. */ }
    } else if ((event.data as { protocol?: string } | null)?.protocol === config.protocol) {
      try {
        const data = event.data as { type?: unknown; data?: unknown } | null;
        dispatcher.emit('message', { type: data?.type, data: data?.data, origin: event.origin, sourceWindow: event.source });
      } catch (error) {
        report(500, JSON.stringify(event.data)); dispatcher.emit('debug', { name: `postMessage:protocol:error:${(error as Error | null)?.message}` });
      }
    }
  } catch (error) {
    report(501, `${(error as Error).message}`); dispatcher.emit('debug', { name: 'SomePostMessageEventError', content: (error as Error | null)?.message });
  }
}

function storageSocketOrigin(url: string): string {
  const parts = url.split('//'); return `${parts[0]}//${parts[1]!.split('/')[0]}`;
}
