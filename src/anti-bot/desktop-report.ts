import { setDesktopProperty } from './desktop-property-write.js';
import { type DesktopTokenState } from './desktop-token.js';
import { encodeDesktopReportData } from './aBogus.js';

export interface DesktopReportXhr {
  withCredentials: boolean;
  open(method: string, url: string, async: boolean): void;
  send(body: string): void;
  addEventListener(type: string, listener: () => void): void;
  getResponseHeader(name: string): string | null;
}

export interface DesktopReportContext {
  readonly XMLHttpRequest: { new(): DesktopReportXhr; readonly prototype: DesktopReportXhr };
  readonly URL: typeof URL;
  readonly JSON: Pick<typeof JSON, 'stringify'>;
  readonly Date: { now(): number };
  readonly Math: Pick<Math, 'floor' | 'random'>;
  readonly navigator: { sendBeacon(url: string, body: string): boolean };
}

export interface DesktopReportConfig {
  readonly aid: number;
  readonly boe: boolean;
  readonly rpU: string;
}

/**
 * BDMS .7 report transport (PC6017–6604). Construct before business XHR hooks.
 * Encodes strData using this context's Math; does not collect data or schedule reports.
 * send() has external effects when provided a real host; construction has none.
 */
export class DesktopReportSender {
  private readonly originalOpen: DesktopReportXhr['open'];
  private readonly originalSend: DesktopReportXhr['send'];
  private readonly originalAddListener: DesktopReportXhr['addEventListener'];

  constructor(
    private readonly context: DesktopReportContext,
    private readonly config: DesktopReportConfig,
    private readonly tokens: Pick<DesktopTokenState, 'token' | 'onReportLoad'>,
    private readonly deviceReport: (time: number) => void,
  ) {
    this.originalOpen = context.XMLHttpRequest.prototype.open;
    this.originalSend = context.XMLHttpRequest.prototype.send;
    this.originalAddListener = context.XMLHttpRequest.prototype.addEventListener;
  }

  send(report: unknown, beacon = false): void {
    const xhr = new this.context.XMLHttpRequest();
    let base = this.config.boe ? 'https://mssdk-boe.bytedance.net' : 'https://mssdk.bytedance.com';
    if (this.config.rpU) base = this.config.rpU;
    const url = new this.context.URL(base + '/web/common');
    url.searchParams.append('ms_appid', this.config.aid + '' || '');
    if (this.tokens.token) url.searchParams.append('msToken', this.tokens.token);
    const body = this.context.JSON.stringify({
      magic: 538969122, version: 1, dataType: 8,
      strData: encodeDesktopReportData(this.context.JSON.stringify(report), this.context.Math),
      tspFromClient: this.context.Date.now(), ulr: beacon ? 1 : 0,
    });
    if (beacon) {
      try { this.context.navigator.sendBeacon(url.href, body); } catch { /* Original Beacon has no fallback. */ }
      return;
    }
    // The complete bundle is strict: refused writes throw before transport.
    setDesktopProperty(xhr, 'withCredentials', true);
    const listenerArgs: [string, () => void] = ['load', () => this.tokens.onReportLoad(xhr, this.deviceReport)];
    const openArgs: [string, string, boolean] = ['POST', url.href, true];
    const sendArgs: [string] = [body];
    try {
      this.originalAddListener.apply(xhr, listenerArgs);
      this.originalOpen.apply(xhr, openArgs);
      this.originalSend.apply(xhr, sendArgs);
    } catch {
      // Matches the source's whole-sequence fallback, not an idempotent network retry.
      /* eslint-disable prefer-spread -- Preserve the original method.apply lookup for wrapped XHR methods. */
      xhr.addEventListener.apply(xhr, listenerArgs);
      xhr.open.apply(xhr, openArgs);
      xhr.send.apply(xhr, sendArgs);
      /* eslint-enable prefer-spread */
    }
  }
}
