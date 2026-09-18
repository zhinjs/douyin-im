import { DesktopBehaviorCollector, type DesktopBehaviorInputContext } from './desktop-behavior-collector.js';
import { DesktopReportLifecycle } from './desktop-report-lifecycle.js';
import { collectDesktopReportScreen } from './desktop-fingerprint.js';

function fixture(iframe = false) {
  const callbacks = new Map<string, ((event: unknown) => void)[]>(), frames: ((time: number) => void)[] = [], registrations: string[] = [];
  let performanceReads = 0, dateReads = 0, randomReads = 0, time = 1000, performanceTime = 20;
  class Element { constructor(readonly innerText: string, readonly nodeName = 'SPAN') {} }
  const register = (type: string, callback: (event: unknown) => void) => {
    registrations.push(type); callbacks.set(type, [...(callbacks.get(type) || []), callback]);
  };
  const top = {};
  const context: DesktopBehaviorInputContext = {
    performance: { now() { performanceReads++; return performanceTime; } },
    Date: { now() { dateReads++; return time; } }, Math: { random() { randomReads++; return .5; } },
    HTMLElement: Element, encodeURI,
    document: { visibilityState: 'visible', addEventListener: register },
    window: { self: top, top: iframe ? {} : top, addEventListener: register, requestAnimationFrame(callback) { frames.push(callback); } },
  };
  return { context, Element, frames, registrations,
    emit(type: string, event: unknown = {}) { callbacks.get(type)?.forEach(fn => fn(event)); },
    setTime(value: number) { time = value; }, setPerformance(value: number) { performanceTime = value; },
    stats: () => ({ performanceReads, dateReads, randomReads }) };
}

describe('Desktop behavior DOM input collector', () => {
  it('starts measurement before listeners and samples performance only at frame 60', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context);
    expect(f.registrations).toEqual([]); expect(f.frames).toHaveLength(1); expect(f.stats().performanceReads).toBe(1);
    for (let i = 0; i < 59; i++) f.frames.shift()!(999999);
    expect(f.stats().performanceReads).toBe(1); expect(state.sampleIntervalMs).toBe(16);
    f.setPerformance(1220); f.frames.shift()!(999999);
    expect(f.stats().performanceReads).toBe(2); expect(state.sampleIntervalMs).toBe(20); expect(f.frames).toEqual([]);
  });
  it('registers exact D order and leaves once control to the report lifecycle', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection();
    const order = ['mousemove', 'touchmove', 'mousedown', 'touchstart', 'mouseup', 'touchend', 'keydown', 'mouseover', 'mouseout', 'deviceorientation', 'visibilitychange'];
    expect(f.registrations).toEqual(order); state.startCollection(); expect(f.registrations).toEqual([...order, ...order]);
  });
  it('skips orientation only when self differs from top', () => {
    const f = fixture(true); new DesktopBehaviorCollector(f.context).startCollection();
    expect(f.registrations).not.toContain('deviceorientation'); expect(f.registrations.at(-1)).toBe('visibilitychange');
  });
  it('does not read time for empty touches and never reads changedTouches', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection();
    f.emit('touchend', { touches: { item: () => null }, get changedTouches() { throw Error('wrong source'); } });
    expect(f.stats().dateReads).toBe(0); expect(state.getSnapshot().clickEnds).toEqual([]);
    f.emit('touchend', { touches: { item: () => ({ clientX: 1, clientY: 2 }) } });
    expect(state.getSnapshot().clickEnds).toEqual([{ x: 1, y: 2, ts: 1000 }]);
  });
  it('shares filtering state between mouse and touch events', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection();
    f.emit('mousemove', { clientX: 1, clientY: 2 }); f.setTime(1010);
    f.emit('touchmove', { touches: { item: () => ({ clientX: 9, clientY: 9 }) } });
    expect(state.getSnapshot().moves).toHaveLength(1); expect(f.stats().dateReads).toBe(2);
  });
  it('filters non-elements and BODY/HTML before reading time', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection();
    for (const target of [{}, new f.Element('text', 'BODY'), new f.Element('text', 'HTML')]) f.emit('mouseover', { target });
    expect(f.stats().dateReads).toBe(0); expect(state.getSnapshot().focus).toEqual([]);
  });
  it('swallows text/URI errors but propagates target errors', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection();
    f.emit('mouseover', { target: new f.Element('12345678901234😀') });
    expect(f.stats().dateReads).toBe(0);
    expect(() => f.emit('mouseover', { get target() { throw Error('target'); } })).toThrow('target');
  });
  it('encodes only the first 15 code units with encodeURI', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection();
    f.emit('mouseover', { target: new f.Element('中文 abc?def#ghijklm') });
    expect(state.getSnapshot().focus).toEqual([{ target: encodeURI('中文 abc?def#ghijklm'.slice(0, 15)), mode: 1, ts: 1000 }]);
  });
  it('reads all axes before rejecting zero and consumes random after Date on valid input', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection(); const order: string[] = [];
    f.emit('deviceorientation', { get beta() { order.push('beta'); return 0; }, get gamma() { order.push('gamma'); return 1; }, get alpha() { order.push('alpha'); return 1; } });
    expect(order).toEqual(['beta', 'gamma', 'alpha']); expect(f.stats()).toEqual({ performanceReads: 1, dateReads: 0, randomReads: 0 });
    f.emit('deviceorientation', { beta: 1, gamma: 2, alpha: 3 }); f.emit('deviceorientation', { beta: 1, gamma: 2, alpha: 3 });
    expect(f.stats().randomReads).toBe(2); expect(state.getSnapshot().orientations).toHaveLength(1);
  });
  it('captures previous key state before a reentrant Date getter', () => {
    const f = fixture(), state = new DesktopBehaviorCollector(f.context); state.startCollection(); let nested = false;
    f.context.Date.now = () => { if (!nested) { nested = true; f.emit('keydown'); } return 10; };
    f.emit('keydown'); expect(state.getSnapshot().keydowns).toEqual([{ ts: 10 }, { ts: 10 }]);
  });
  it('propagates frame registration errors without installing input', () => {
    const f = fixture(); f.context.window.requestAnimationFrame = () => { throw Error('raf'); };
    expect(() => new DesktopBehaviorCollector(f.context)).toThrow('raf'); expect(f.registrations).toEqual([]);
  });
  it('registers visibility reporting before visibility collection when started through lifecycle', () => {
    const f = fixture(), collector = new DesktopBehaviorCollector(f.context), reports: unknown[][] = [];
    const sources = collector.createReportSources(() => collectDesktopReportScreen({ window: { screen: {} }, document: {} }));
    const lifecycle = new DesktopReportLifecycle({ ...f.context, setTimeout() {}, setInterval() {},
      requestAnimationFrame: f.context.window.requestAnimationFrame },
    { dump: true, ddrt: 3, track: { mode: 0, delay: 300 } }, sources,
    { send(...args) { reports.push(args); } }, () => {}, collector.startCollection);
    lifecycle.start(); f.emit('visibilitychange');
    expect(reports[0]).toEqual([expect.objectContaining({ behavior: expect.objectContaining({ windowState: [] }) }), true]);
    expect(collector.getSnapshot().windowStates).toEqual([{ v: 1, ts: 1000 }]);
    expect(sources.windowState.data()).toEqual([{ v: 1, ts: 1000 }]);
  });
});
