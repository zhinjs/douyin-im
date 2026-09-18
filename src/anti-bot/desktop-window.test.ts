import { DesktopPropertyClassifier } from './desktop-device-properties.js';
import { DesktopWindowCollector, type DesktopWindowContext } from './desktop-window.js';

describe('Desktop $ window collector', () => {
  const classifier = () => new DesktopPropertyClassifier({ Symbol, Object });
  it('preserves the 16-field order and indexDB spelling', () => {
    const window = { indexedDB: {}, isSecureContext: true };
    const c = new DesktopWindowCollector({ window, Math }, classifier());
    const result = c.collect();
    expect(Object.keys(result)).toEqual(['ActiveXObject', 'BluetoothUUID', 'devicePixelRatio', 'external', 'Image', 'indexDB', 'isSecureContext', 'localStorage', 'location', 'locationbar', 'mozRTCPeerConnection', 'netscape', 'postMessage', 'sessionStorage', 'toolbar', 'webkitRequestAnimationFrame']);
    expect(result).toMatchObject({ indexDB: 4, isSecureContext: 1, devicePixelRatio: -1, location: '' });
    expect(c.collect()).not.toBe(result);
  });
  it('keeps truthy href values and their identity without converting to text', () => {
    for (const href of [Symbol('url'), { toString() { throw Error('do not coerce'); } }, 27]) {
      const c = new DesktopWindowCollector({ window: { location: { href } }, Math }, classifier());
      expect(c.collect().location).toBe(href);
    }
    for (const href of [null, undefined, '', false, 0, NaN]) {
      expect(new DesktopWindowCollector({ window: { location: { href } }, Math }, classifier()).collect().location).toBe('');
    }
  });
  it('keeps Math captured but reads DPR twice with floor fetched between reads', () => {
    const trace: string[] = [];
    let dpr = 0;
    const math = { get floor() { trace.push('floor'); return function(this: unknown, n: number) { expect(this).toBe(math); return Math.floor(n); }; } };
    const context: DesktopWindowContext = { Math: math, get window() { trace.push('window'); return { get devicePixelRatio() { trace.push('dpr'); return ++dpr === 1 ? 2 : 0; } }; } };
    const c = new DesktopWindowCollector(context, classifier());
    Object.defineProperty(context, 'Math', { get() { throw Error('captured'); } });
    expect(c.collect().devicePixelRatio).toBe(0);
    expect(trace.filter(x => x === 'window')).toHaveLength(17);
    const index = trace.indexOf('dpr');
    expect(trace.slice(index - 1, index + 4)).toEqual(['window', 'dpr', 'floor', 'window', 'dpr']);
  });
  it('returns 404 for classified getters without aliasing or writing to window', () => {
    const window = Object.freeze({ get localStorage() { throw Error('get'); }, set localStorage(_value: never) { throw Error('must not write'); } });
    const result = new DesktopWindowCollector({ window, Math }, classifier()).collect();
    expect(result).not.toBe(window);
    expect(result.localStorage).toBe(404);
    expect(result.webkitRequestAnimationFrame).toBe(4);
  });
  it('propagates binding, non-classified property and tag failures', () => {
    expect(() => new DesktopWindowCollector({ get window(): never { throw Error('binding'); }, Math }, classifier()).collect()).toThrow('binding');
    expect(() => new DesktopWindowCollector({ window: { location: { get href() { throw Error('href'); } } }, Math }, classifier()).collect()).toThrow('href');
    expect(() => new DesktopWindowCollector({ window: { Image: { get [Symbol.toStringTag]() { throw Error('tag'); } } }, Math }, classifier()).collect()).toThrow('tag');
  });
});
