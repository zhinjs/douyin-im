import { encodeDesktopReportData } from './aBogus.js';
import { DesktopReportSender, type DesktopReportXhr } from './desktop-report.js';
import { DesktopTokenState } from './desktop-token.js';

describe('Desktop report codec', () => {
  it.each([
    ['', 'fRD='], ['a', 'fRDR'], ['ab', 'fRDRcf=='], ['abc', 'fRDRcf8='],
    ['{"text":"你好😀"}', 'fRDdOvw+eHhA4CPKZUBZ4Ay='],
  ])('matches original .7 vector %s', (input, expected) => {
    let draws = 0;
    expect(encodeDesktopReportData(input, { floor: Math.floor, random() { draws++; return .5; } })).toBe(expected);
    expect(draws).toBe(1);
  });
  it('uses UTF-16 low bytes, without UTF-8 or Unicode code-point iteration', () => {
    const math = { floor: Math.floor, random: () => .5 };
    expect(encodeDesktopReportData('Ā😀', math)).toBe(encodeDesktopReportData('\x00\x3d\x00', math));
  });
  it('draws the key before rejecting an undefined JSON result', () => {
    let draws = 0;
    expect(() => encodeDesktopReportData(undefined, { floor: Math.floor, random() { draws++; return .5; } })).toThrow(TypeError);
    expect(draws).toBe(1);
  });
});

function fixture(token = '') {
  const trace: unknown[] = [], requests: FakeXhr[] = [], callbacks: ((time: number) => void)[] = [];
  const failures = { send: false };
  class FakeXhr implements DesktopReportXhr {
    withCredentials = false;
    listener?: () => void;
    constructor() { trace.push('new'); requests.push(this); }
    open(...args: [string, string, boolean]) { trace.push(['open', ...args]); }
    send(body: string) { trace.push(['send', body]); if (failures.send) { failures.send = false; throw Error('send'); } }
    addEventListener(type: string, listener: () => void) { trace.push(['listener', type]); this.listener = listener; }
    getResponseHeader(name: string) { trace.push(['header', name]); return 'issued'; }
  }
  const context = {
    XMLHttpRequest: FakeXhr, URL, JSON, Date: { now: () => 1234 }, Math: { floor: Math.floor, random: () => .5 },
    navigator: { sendBeacon(url: string, body: string) { trace.push(['beacon', url, body]); return false; } },
    localStorage: { getItem: () => token, setItem(...args: [string, string]) { trace.push(['store', ...args]); } },
    requestAnimationFrame(callback: (time: number) => void) { callbacks.push(callback); },
  };
  const config = { aid: 339757, boe: false, rpU: '' };
  const tokens = new DesktopTokenState(context);
  const sender = new DesktopReportSender(context, config, tokens, () => {});
  return { trace, requests, callbacks, context, config, tokens, sender, failures };
}

describe('Desktop report sender', () => {
  it('does not create a request during construction', () => {
    expect(fixture().trace).toEqual([]);
  });
  it('sends the exact envelope and binds report-only token rotation', () => {
    const f = fixture(); f.sender.send({ text: '你好😀' });
    expect(f.trace).toEqual(['new', ['listener', 'load'], ['open', 'POST', 'https://mssdk.bytedance.com/web/common?ms_appid=339757', true],
      ['send', '{"magic":538969122,"version":1,"dataType":8,"strData":"fRDdOvw+eHhA4CPKZUBZ4Ay=","tspFromClient":1234,"ulr":0}']]);
    expect(f.requests[0]!.withCredentials).toBe(true);
    f.requests[0]!.listener!(); expect(f.tokens.token).toBe('issued'); expect(f.callbacks).toHaveLength(1);
  });
  it('reads current config and token for each report, without normalizing rpU slashes', () => {
    const f = fixture('cached'); f.config.boe = true;
    f.sender.send({}); expect(f.trace).toContainEqual(['open', 'POST', 'https://mssdk-boe.bytedance.net/web/common?ms_appid=339757&msToken=cached', true]);
    f.requests[0]!.listener!(); f.config.rpU = 'https://custom.invalid/'; f.sender.send({});
    expect(f.trace).toContainEqual(['open', 'POST', 'https://custom.invalid//web/common?ms_appid=339757&msToken=issued', true]);
  });
  it('uses captured XHR methods after prototype replacement', () => {
    const f = fixture();
    f.context.XMLHttpRequest.prototype.open = () => { throw Error('hook must not run'); };
    expect(() => f.sender.send({})).not.toThrow(); expect(f.trace.some(x => Array.isArray(x) && x[0] === 'open')).toBe(true);
  });
  it('replays the whole current-method sequence after captured send throws', () => {
    const f = fixture(); f.failures.send = true;
    f.context.XMLHttpRequest.prototype.addEventListener = () => { f.trace.push('current:listener'); };
    f.context.XMLHttpRequest.prototype.open = () => { f.trace.push('current:open'); };
    f.context.XMLHttpRequest.prototype.send = () => { f.trace.push('current:send'); };
    f.sender.send({});
    expect(f.trace.slice(-3)).toEqual(['current:listener', 'current:open', 'current:send']);
    expect(f.trace.filter(x => Array.isArray(x) && x[0] === 'send')).toHaveLength(1);
  });
  it('propagates fallback errors without a third attempt', () => {
    const f = fixture(); f.failures.send = true;
    f.context.XMLHttpRequest.prototype.addEventListener = () => { f.trace.push('current:listener'); throw Error('fallback'); };
    expect(() => f.sender.send({})).toThrow('fallback');
    expect(f.trace.filter(x => x === 'current:listener')).toHaveLength(1);
  });
  it('builds an XHR but does not bind/load/open/send when Beacon returns false', () => {
    const f = fixture(); f.sender.send({}, true);
    expect(f.trace).toHaveLength(2); expect(f.trace[0]).toBe('new'); expect(f.trace[1]).toEqual(['beacon', expect.any(String), expect.stringContaining('"ulr":1')]);
    expect(f.requests[0]!.withCredentials).toBe(false); expect(f.requests[0]!.listener).toBeUndefined();
  });
  it('swallows only Beacon errors, not earlier serialization errors', () => {
    const f = fixture(); f.context.navigator.sendBeacon = () => { throw Error('beacon'); };
    expect(() => f.sender.send({}, true)).not.toThrow();
    expect(() => f.sender.send(undefined, true)).toThrow(TypeError);
  });
  it('does not swallow malformed report URL errors', () => {
    const f = fixture(); f.config.rpU = '://invalid';
    expect(() => f.sender.send({})).toThrow(); expect(f.trace).toEqual(['new']);
  });
});
