import { DesktopDocumentCollector, DesktopPropertyClassifier } from './desktop-device-properties.js';
import { DesktopNavigatorCollector, type DesktopNavigatorContext } from './desktop-navigator.js';

describe('Desktop J navigator collector', () => {
  function collector(context: Partial<DesktopNavigatorContext> = {}) {
    return new DesktopNavigatorCollector({ navigator: {}, document: {}, window: {}, Math, ...context }, new DesktopPropertyClassifier({ Symbol, Object }));
  }
  it('preserves all 30 fields, their order and their original representations', () => {
    const result = collector({ navigator: { deviceMemory: 8, languages: ['zh', 'en'], webdriver: false, cookieEnabled: true } }).collect();
    expect(Object.keys(result as object)).toEqual(['appCodeName', 'appMinorVersion', 'appName', 'appVersion', 'bluetooth', 'buildID', 'cookieEnabled', 'cpuClass', 'credentials', 'deviceMemory', 'doNotTrack', 'hardwareConcurrency', 'language', 'languages', 'maxTouchPoints', 'msDoNotTrack', 'oscpu', 'platform', 'product', 'productSub', 'requestMediaKeySystemAccess', 'storage', 'systemLanguage', 'touchEvent', 'touchstart', 'userLanguage', 'vendor', 'vendorSub', 'vibrate', 'webdriver']);
    expect(result).toMatchObject({ deviceMemory: '8', languages: 'zh,en', webdriver: 'false', cookieEnabled: 1, bluetooth: 4, hardwareConcurrency: -1, touchEvent: 2, touchstart: 2 });
  });
  it('reads the binding on every field, including a second read after obtaining Math.floor', () => {
    const trace: string[] = [];
    let reads = 0;
    const context = { get navigator() { trace.push('navigator'); return { get hardwareConcurrency() { trace.push('hardware'); return ++reads === 1 ? 2 : 0; } }; }, document: {}, window: {}, Math: { get floor() { trace.push('floor'); return Math.floor; } } };
    expect(new DesktopNavigatorCollector(context, new DesktopPropertyClassifier({ Symbol, Object })).collect()).toMatchObject({ hardwareConcurrency: 0 });
    expect(trace.filter(x => x === 'navigator')).toHaveLength(29);
    const index = trace.indexOf('hardware');
    expect(trace.slice(index - 1, index + 4)).toEqual(['navigator', 'hardware', 'floor', 'navigator', 'hardware']);
  });
  it('shares document G without importing the same-VM document alias behavior', () => {
    const document = new DesktopDocumentCollector({ Symbol, Object, document: {} });
    const navigator = { get bluetooth() { throw Error('get'); } };
    const c = new DesktopNavigatorCollector({ navigator, document: {}, window: {}, Math }, document);
    const result = c.collect();
    expect(result).not.toBe(navigator);
    expect(result).toMatchObject({ bluetooth: 404, webdriver: 'undefined' });
  });
  it('keeps default ToPrimitive hints and does not catch text/tag failures', () => {
    const hints: string[] = [];
    expect(collector({ navigator: { platform: { [Symbol.toPrimitive](hint: string) { hints.push(hint); return 'p'; } } } }).collect()).toMatchObject({ platform: 'p' });
    expect(hints).toEqual(['default']);
    expect(() => collector({ navigator: { appName: Symbol('bad') } }).collect()).toThrow(TypeError);
    expect(() => collector({ navigator: { bluetooth: { get [Symbol.toStringTag]() { throw Error('tag'); } } } }).collect()).toThrow('tag');
  });
  it('preserves createEvent receiver and tests touchstart presence without reading it', () => {
    const document = { createEvent(name: string) { expect(this).toBe(document); expect(name).toBe('TouchEvent'); return null; } };
    expect(collector({ document, window: { get ontouchstart() { throw Error('must not read'); } } }).collect()).toMatchObject({ touchEvent: 1, touchstart: 1 });
    expect(collector({ document: { createEvent() { throw Error('unsupported'); } } }).collect()).toMatchObject({ touchEvent: 2 });
  });
  it('returns and updates document only after the createEvent property read fails', () => {
    const document = { get createEvent(): never { throw Error('read'); } };
    const result = collector({ document }).collect();
    expect(result).toBe(document);
    expect(result).toMatchObject({ touchEvent: 2, touchstart: 2, vendor: 'undefined', vibrate: 4 });
    expect(Object.hasOwn(document, 'appCodeName')).toBe(false);
  });
  it('preserves failed touchstart probe aliases and helper identity across calls', () => {
    const context = { navigator: {}, document: {}, get window(): object { throw Error('window'); }, Math };
    const c = new DesktopNavigatorCollector(context, new DesktopPropertyClassifier({ Symbol, Object }));
    const first = c.collect();
    expect(typeof first).toBe('function');
    expect(c.collect()).toBe(first);
    expect((first as () => number)()).toBe(2);
    expect(Object.assign({}, first)).toMatchObject({ touchstart: 2, vendor: 'undefined' });
    expect(() => collector({ window: new Proxy({}, { has() { throw Error('has'); } }) }).collect()).toThrow(TypeError);
  });
  it('does not turn a failed document binding into a successful report', () => {
    const context = { navigator: {}, get document(): object { throw Error('document'); }, window: {}, Math };
    expect(() => new DesktopNavigatorCollector(context, new DesktopPropertyClassifier({ Symbol, Object })).collect()).toThrow(TypeError);
  });
});
