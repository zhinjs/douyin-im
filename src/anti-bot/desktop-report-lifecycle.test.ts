import { DesktopReportLifecycle, type DesktopBehaviorReportSources } from './desktop-report-lifecycle.js';
import { DesktopReportSender } from './desktop-report.js';
import { DesktopTokenState } from './desktop-token.js';

function fixture(mode = 0, dump = true) {
  const timeouts: { callback: () => void; delay: number }[] = [], intervals: { callback: () => void; delay: number }[] = [];
  const frames: ((time: number) => void)[] = [], listeners: (() => void)[] = [], sent: unknown[][] = [], trace: string[] = [];
  let now = 1000, generation = 0;
  const context = {
    performance: { now: () => now }, Date: { now: () => 10_000 + now },
    document: { addEventListener(type: string, listener: () => void) { trace.push(type); listeners.push(listener); } },
    setTimeout(callback: () => void, delay: number) { timeouts.push({ callback, delay }); },
    setInterval(callback: () => void, delay: number) { intervals.push({ callback, delay }); },
    requestAnimationFrame(callback: (time: number) => void) { frames.push(callback); },
  };
  const queue = (name: string) => ({ data() { trace.push(name); return [{ generation }]; } });
  const sources: DesktopBehaviorReportSources = {
    move: queue('move'), click: queue('click'), clickEnd: queue('clickEnd'), keyboard: queue('keyboard'),
    windowState: queue('windowState'), gyro: queue('gyro'), focus: queue('focus'),
    screen() { trace.push('screen'); return { generation }; },
  };
  const config = { dump, ddrt: 3, track: { mode, delay: 300 } };
  const sender = { send(...args: unknown[]) { sent.push(args); } };
  const lifecycle = new DesktopReportLifecycle(context, config, sources, sender, () => trace.push('device'), () => trace.push('collect'));
  return { context, config, sources, sender, lifecycle, timeouts, intervals, frames, listeners, sent, trace,
    advance(time: number) { now = time; }, mutate() { generation++; }, flush() { frames.splice(0).forEach(fn => fn(999999)); } };
}

describe('Desktop report lifecycle', () => {
  it('does not register resources before start', () => {
    const f = fixture(); expect(f.trace).toEqual([]); expect(f.timeouts).toEqual([]);
  });
  it.each([[0, 1, 1], [1, 0, 0], [2, 1, 0], [3, 0, 0]])('installs mode %i with device=%i behavior=%i', (mode, device, behavior) => {
    const f = fixture(mode); f.lifecycle.start(); f.lifecycle.start();
    expect(f.listeners).toHaveLength(1); expect(f.timeouts).toHaveLength(device); expect(f.intervals).toHaveLength(behavior);
  });
  it('supports a later mode change without rescheduling already registered delays', () => {
    const f = fixture(2, false); f.lifecycle.start();
    f.config.ddrt = 9; f.config.track.mode = 0; f.config.track.delay = 7; f.config.dump = true;
    f.lifecycle.start(); f.config.track.delay = 1; f.lifecycle.start();
    expect(f.timeouts.map(x => x.delay)).toEqual([3000]); expect(f.intervals.map(x => x.delay)).toEqual([7000]);
    expect(f.listeners).toHaveLength(1); expect(f.trace.filter(x => x === 'collect')).toHaveLength(1);
  });
  it('reports the first behavior immediately, snapshots before RAF, and throttles subsequent reports', () => {
    const f = fixture(); f.lifecycle.reportBehavior(); expect(f.sent).toEqual([]);
    expect(f.trace).toEqual(['move', 'click', 'clickEnd', 'keyboard', 'windowState', 'gyro', 'focus', 'screen']);
    f.mutate(); f.advance(3999); f.lifecycle.reportBehavior(); expect(f.frames).toHaveLength(1);
    f.flush(); expect(f.sent[0]).toEqual([{
      wID: { msgType: 2, privacyMode: 0, timestamp: '11000' },
      behavior: { beMove: [{ generation: 0 }], beClick: [{ generation: 0 }], beClickEnd: [{ generation: 0 }],
        beKeyboard: [{ generation: 0 }], windowState: [{ generation: 0 }], gyro: [{ generation: 0 }], focus: [{ generation: 0 }], screen: { generation: 0 } },
    }]);
    f.advance(4000); f.lifecycle.reportBehavior(); expect(f.frames).toHaveLength(1);
  });
  it('sends visibility only once even when the document is not hidden', () => {
    const f = fixture(1); f.lifecycle.start(); f.listeners[0]!(); f.listeners[0]!();
    expect(f.sent).toHaveLength(1); expect(f.sent[0]![1]).toBe(true); expect(f.frames).toHaveLength(0);
  });
  it('suppresses visibility once behavior has been scheduled, before actual sending', () => {
    const f = fixture(); f.lifecycle.start(); f.lifecycle.reportBehavior(); f.listeners[0]!();
    expect(f.sent).toHaveLength(0); f.flush(); expect(f.sent).toHaveLength(1);
  });
  it('visibility does not advance the last behavior timestamp', () => {
    const f = fixture(); f.lifecycle.start(); f.advance(4000); f.listeners[0]!(); f.lifecycle.reportBehavior();
    expect(f.sent).toHaveLength(1); expect(f.frames).toHaveLength(1);
  });
  it('keeps the once flag when timeout registration fails', () => {
    const f = fixture(); f.context.setTimeout = () => { throw Error('timeout'); };
    expect(() => f.lifecycle.start()).toThrow('timeout');
    expect(() => f.lifecycle.start()).not.toThrow(); expect(f.intervals).toHaveLength(1);
  });
  it('keeps the behavior timestamp and reported flag after collection fails', () => {
    const f = fixture(); f.lifecycle.start(); f.sources.move.data = () => { throw Error('collect'); };
    expect(() => f.lifecycle.reportBehavior()).toThrow('collect');
    expect(() => f.listeners[0]!()).not.toThrow(); expect(() => f.lifecycle.reportBehavior()).not.toThrow();
    f.advance(4000); expect(() => f.lifecycle.reportBehavior()).toThrow('collect');
  });
  it('does not retry a failed RAF registration inside the throttle window', () => {
    const f = fixture(); f.context.requestAnimationFrame = () => { throw Error('raf'); };
    expect(() => f.lifecycle.reportBehavior()).toThrow('raf');
    expect(() => f.lifecycle.reportBehavior()).not.toThrow();
    f.advance(4000); expect(() => f.lifecycle.reportBehavior()).toThrow('raf');
  });
  it('allows direct behavior triggers regardless of initialization mode', () => {
    const f = fixture(1, false); f.lifecycle.start(); f.lifecycle.reportBehavior(); f.flush();
    expect(f.sent).toHaveLength(1); expect(f.intervals).toHaveLength(0);
  });
  it('connects lifecycle, encoded report transport and first-token device scheduling in one host', () => {
    const f = fixture(), requests: Xhr[] = [];
    class Xhr {
      withCredentials = false;
      url = ''; body = ''; listener?: () => void;
      constructor() { requests.push(this); }
      open(_method: string, url: string) { this.url = url; }
      send(body: string) { this.body = body; }
      addEventListener(_name: string, listener: () => void) { this.listener = listener; }
      getResponseHeader() { return 'first-token'; }
    }
    const context = {
      ...f.context, XMLHttpRequest: Xhr, URL, JSON, Math: { floor: Math.floor, random: () => .5 },
      localStorage: { getItem: () => null, setItem() {} }, navigator: { sendBeacon: () => false },
    };
    const device = () => { f.trace.push('device'); };
    const tokens = new DesktopTokenState(context);
    const sender = new DesktopReportSender(context, { aid: 339757, boe: false, rpU: '' }, tokens, device);
    const lifecycle = new DesktopReportLifecycle(context, f.config, f.sources, sender, device, () => {});
    lifecycle.start(); lifecycle.reportBehavior(); expect(requests).toHaveLength(0);
    f.flush(); expect(requests).toHaveLength(1); expect(requests[0]!.url).not.toContain('msToken');
    expect(JSON.parse(requests[0]!.body)).toEqual({ magic: 538969122, version: 1, dataType: 8,
      strData: expect.any(String), tspFromClient: 11000, ulr: 0 });
    requests[0]!.listener!(); expect(tokens.token).toBe('first-token'); expect(f.frames).toHaveLength(1);
    f.flush(); expect(f.trace.at(-1)).toBe('device');
    f.advance(4000); lifecycle.reportBehavior(); f.flush();
    expect(requests[1]!.url).toContain('msToken=first-token');
    requests[1]!.listener!(); expect(f.frames).toHaveLength(0);
  });
});
