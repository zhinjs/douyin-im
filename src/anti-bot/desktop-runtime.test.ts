import { DesktopBdmsRuntime, installDesktopBdms, type DesktopBdmsRuntimeContext } from './desktop-runtime.js';
import { DesktopEnvironmentState } from './desktop-environment-mask.js';
import { DesktopBehaviorState } from './desktop-behavior.js';
import type { DesktopIdentityImage } from './desktop-device-identity.js';

function fixture(saved = new Map<string, string>()) {
  const trace: string[] = [], images: DesktopIdentityImage[] = [], xhrs: Xhr[] = [];
  const reports: Record<string, unknown>[] = [];
  const frames: (() => unknown)[] = [], timeouts: { callback: () => unknown; delay: number }[] = [];
  const intervals: { callback: () => unknown; delay: number }[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const clock = { now: 1000 };
  class HostDate { static now() { return clock.now; } getTimezoneOffset() { return -480; } }
  class Image implements DesktopIdentityImage {
    onload: (() => void) | null = null; onerror: (() => void) | null = null; src = '';
    constructor() { images.push(this); }
  }
  class Element { nodeName = 'DIV'; innerText = 'fixture'; }
  class Xhr {
    withCredentials = false; url = ''; body: unknown; responseToken = ''; load?: () => void;
    constructor() { xhrs.push(this); }
    open(_method: string, url: string | URL) { this.url = String(url); trace.push('native:open'); }
    setRequestHeader() { trace.push('native:header'); }
    send(body?: unknown) { this.body = body; trace.push('native:send'); }
    addEventListener(_type: string, callback: () => void) { this.load = callback; }
    getResponseHeader() { return this.responseToken; }
  }
  for (const name of ['open', 'send', 'addEventListener', 'setRequestHeader'] as const) {
    let value = Xhr.prototype[name];
    Object.defineProperty(Xhr.prototype, name, {
      get() { trace.push('get:' + name); return value; },
      set(next: typeof value) { trace.push('set:' + name); value = next; }, configurable: true,
    });
  }
  const storage = {
    getItem(key: string) { trace.push('storage:get:' + key); return saved.get(key) ?? null; },
    setItem(key: string, value: string) { saved.set(key, value); },
    removeItem(key: string) { saved.delete(key); },
  };
  const add = (type: string, callback: (event: unknown) => void) => {
    const callbacks = listeners.get(type) ?? []; callbacks.push(callback); listeners.set(type, callbacks);
  };
  const raf = (callback: () => unknown) => { trace.push('raf'); frames.push(callback); };
  const window = {
    screen: { width: 1280, height: 720, orientation: { type: 'landscape-primary', angle: 90 } },
    innerWidth: 1280, innerHeight: 720, outerWidth: 1280, outerHeight: 720, eval,
    chrome: {}, requestAnimationFrame: raf, addEventListener: add,
    fetch: async (input: unknown) => ({ input }),
    EventSource: class { constructor(public url: unknown) {} },
    self: {} as object, top: {} as object,
    localStorage: storage, sessionStorage: { ...storage },
  };
  window.self = window; window.top = window;
  const navigator = Object.assign(Object.create({}), { userAgent: 'fixture UA', platform: 'MacIntel', sendBeacon: () => true });
  const context = {
    window, navigator, document: {
      body: null, referrer: '', cookie: '', images: [], visibilityState: 'visible', addEventListener: add,
      fonts: { check: () => true }, createEvent() {},
      createElement: () => ({ getContext: (kind: string) => kind === 'webgl' ? null : {
        drawImage() {}, getImageData: () => ({ data: [0, 0, 0, 0] }),
      } }),
    },
    Object, Symbol, Array, RegExp, TypeError, Reflect, Proxy, Boolean, Request, URL, Image, HTMLElement: Element, encodeURI,
    Date: HostDate, Math: { ...Math, floor: Math.floor, round: Math.round, random: () => .5 },
    location: { href: 'https://fixture.invalid/login' }, XMLHttpRequest: Xhr,
    localStorage: storage, sessionStorage: { ...storage },
    performance: { now() { trace.push('performance'); return clock.now; } },
    requestAnimationFrame: raf,
    setTimeout(callback: () => unknown, delay: number) { timeouts.push({ callback, delay }); },
    setInterval(callback: () => unknown, delay: number) { intervals.push({ callback, delay }); },
    JSON: { stringify(value: unknown) {
      if (value && typeof value === 'object' && 'wID' in value) reports.push(structuredClone(value) as Record<string, unknown>);
      return JSON.stringify(value);
    } },
  };
  return { context: context as unknown as DesktopBdmsRuntimeContext, trace, images, xhrs, reports, frames,
    timeouts, intervals, listeners, clock, saved, Xhr, window };
}
async function drain() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

describe('Desktop shared runtime', () => {
  it('cleans startup referer once and exposes original getter-only module exports', () => {
    const f = fixture();
    f.saved.set('__ac_referer', 'source'); f.saved.set('xmst', 'kept');
    installDesktopBdms(f.context);
    const module = f.context.window.bdms as Pick<DesktopBdmsRuntime, 'init' | 'getReferer'>;
    expect(Object.keys(module)).toEqual(['getReferer', 'init']);
    expect(Object.prototype.toString.call(module)).toBe('[object Module]');
    expect(Object.getOwnPropertyDescriptor(module, '__esModule')).toMatchObject({ value: true, enumerable: false });
    expect(Object.getOwnPropertyDescriptor(module, 'init')).toMatchObject({ get: expect.any(Function), set: undefined, configurable: false });
    expect(module.getReferer()).toBe('source');
    expect(f.saved.get('__ac_referer')).toBeUndefined(); expect(f.saved.get('xmst')).toBe('kept');
    expect(f.context.window._sdkGlueVersionMap).toEqual({ bdmsVersion: '1.0.1.7' });
    f.context.window.__ac_referer = 'later'; expect(module.getReferer()).toBe('later');
    const trace = [...f.trace]; installDesktopBdms(f.context); expect(f.trace).toEqual(trace);
    expect(f.context.window.bdms).toBe(module);
    f.saved.set('__ac_referer', 'not consumed by init');
    module.init({ track: { mode: 1 }, dump: false });
    expect(f.saved.get('__ac_referer')).toBe('not consumed by init');
  });
  it.each([true, 'other implementation', { other: true }])('does not validate an existing truthy bdms: %p', value => {
    const f = fixture(); f.context.window.bdms = value;
    installDesktopBdms(f.context);
    expect(f.trace).toEqual([]); expect(f.context.window.bdms).toBe(value);
  });
  it('stops at a rejected strict version write after referer cleanup, before token/hooks', () => {
    const f = fixture(); f.saved.set('__ac_referer', 'source');
    f.context.window._sdkGlueVersionMap = Object.freeze({ bdmsVersion: 'old' });
    expect(() => installDesktopBdms(f.context)).toThrow(TypeError);
    expect(f.context.window.__ac_referer).toBe('source'); expect(f.saved.has('__ac_referer')).toBe(false);
    expect(f.trace).not.toContain('storage:get:xmst'); expect(f.trace).not.toContain('get:open');
    expect(f.context.window.bdms).toBeUndefined(); expect(f.frames).toHaveLength(1);
  });
  it('ignores only the outer export refusal after hooks have installed', () => {
    const f = fixture(); Object.defineProperty(f.window, 'bdms', { value: undefined, writable: false });
    expect(() => installDesktopBdms(f.context)).not.toThrow();
    expect(f.trace).toContain('set:send'); expect(f.context.window.bdms).toBeUndefined();
    expect(f.context.window._sdkGlueVersionMap).toEqual({ bdmsVersion: '1.0.1.7' });
  });
  it('propagates an explicit outer export setter error without undoing hooks', () => {
    const f = fixture(); Object.defineProperty(f.window, 'bdms', { set() { throw Error('export setter'); } });
    expect(() => installDesktopBdms(f.context)).toThrow('export setter');
    expect(f.trace).toContain('set:send'); expect(f.frames).toHaveLength(1);
  });
  it('captures report methods before hooks and starts no device report before init', () => {
    const f = fixture(); new DesktopBdmsRuntime(f.context);
    expect(f.trace.filter(value => value.startsWith('get:') || value.startsWith('set:'))).toEqual([
      'get:open', 'get:send', 'get:addEventListener', 'get:open', 'get:send', 'get:setRequestHeader',
      'set:open', 'set:setRequestHeader', 'set:send',
    ]);
    expect(f.frames).toHaveLength(1); expect(f.timeouts).toEqual([]); expect(f.intervals).toEqual([]);
    expect(f.images).toEqual([]); expect(f.xhrs).toEqual([]);
  });
  it('shares input queues with report screen X and keeps hooks/timers stable across repeated init', async () => {
    const f = fixture(); const runtime = new DesktopBdmsRuntime(f.context);
    const open = f.Xhr.prototype.open, fetch = f.window.fetch, eventSource = f.window.EventSource;
    runtime.init({ aid: 339757, pageId: 23420, paths: ['/passport'], track: { paths: ['/passport'] } });
    expect(f.timeouts.map(x => x.delay)).toEqual([3000]); expect(f.intervals.map(x => x.delay)).toEqual([300000]);
    expect(f.listeners.get('visibilitychange')).toHaveLength(2);
    f.listeners.get('mousemove')![0]!({ clientX: 4, clientY: 7 });
    f.clock.now = 1020; f.listeners.get('keydown')![0]!({});
    const xhr = new f.Xhr(); xhr.open('POST', '/passport/login'); xhr.send('body');
    expect(new URL(xhr.url).searchParams.get('a_bogus')).toBeTruthy();
    await f.frames[1]!(); // Serialization occurs in the queued report callback.
    expect(f.reports[0]).toMatchObject({ wID: { msgType: 2 }, behavior: {
      beMove: [{ x: 4, y: 7, ts: 1000 }], beKeyboard: [{ ts: 1020 }],
      screen: { orientaionType: 'landscape-primary', orientaionAngle: 90 },
    } });
    runtime.init({ track: { delay: 1, paths: ['/more'] } });
    expect(f.Xhr.prototype.open).toBe(open); expect(f.window.fetch).toBe(fetch); expect(f.window.EventSource).toBe(eventSource);
    expect(f.intervals.map(x => x.delay)).toEqual([300000]); expect(f.listeners.get('mousemove')).toHaveLength(1);
    expect(f.xhrs.filter(x => x.url.includes('/web/common'))).toHaveLength(1);
  });
  it('uses one real M/q instance for signing and device reporting and shares issued token across hooks', async () => {
    const environments: DesktopEnvironmentState[] = [], behaviors: DesktopBehaviorState[] = [];
    const originalM = DesktopEnvironmentState.prototype.mask, originalQ = DesktopBehaviorState.prototype.mask;
    DesktopEnvironmentState.prototype.mask = function(this: DesktopEnvironmentState) {
      environments.push(this); return originalM.call(this);
    };
    DesktopBehaviorState.prototype.mask = function(this: DesktopBehaviorState, ...args: Parameters<DesktopBehaviorState['mask']>) {
      behaviors.push(this); return originalQ.apply(this, args);
    };
    try {
      const f = fixture(); const runtime = new DesktopBdmsRuntime(f.context);
      runtime.init({ aid: 339757, pageId: 23420, paths: ['.*'], track: { mode: 2 } });
      const first = new f.Xhr(); first.open('POST', '/passport/login'); first.send('body');
      const device = f.timeouts[0]!.callback(); await drain();
      expect(f.images).toHaveLength(1); f.images[0]!.onload!(); await device;
      expect(f.reports[0]).toMatchObject({ envCode: 129, ubCode: 14, wID: { aid: 339757, pageId: 23420 } });
      const report = f.xhrs.at(-1)!; expect(report.url).toContain('/web/common');
      expect(new URL(report.url).searchParams.has('a_bogus')).toBe(false);
      report.responseToken = 'issued'; report.load!();
      expect(f.saved.get('xmst')).toBe('issued');
      const fetchResult = await f.window.fetch('/passport/login') as { input: string };
      expect(new URL(fetchResult.input).searchParams.get('msToken')).toBe('issued');
      const eventSource = new f.window.EventSource('/events');
      expect(new URL(String(eventSource.url)).searchParams.get('msToken')).toBe('issued');
      expect(new Set(environments).size).toBe(1); expect(environments.length).toBeGreaterThanOrEqual(4);
      expect(new Set(behaviors).size).toBe(1); expect(behaviors).toHaveLength(1); // mode2 skips q in signing.
      const nextDevice = f.frames.at(-1)!(); await drain();
      expect(f.images).toHaveLength(2); f.images[1]!.onload!(); await nextDevice;
      expect(new URL(f.xhrs.at(-1)!.url).searchParams.get('msToken')).toBe('issued');
    } finally { DesktopEnvironmentState.prototype.mask = originalM; DesktopBehaviorState.prototype.mask = originalQ; }
  });
  it('keeps tokens and init paths isolated between host contexts', async () => {
    const a = fixture(), b = fixture(); a.saved.set('xmst', 'a'); b.saved.set('xmst', 'b');
    const first = new DesktopBdmsRuntime(a.context), second = new DesktopBdmsRuntime(b.context);
    first.init({ paths: ['/a'], track: { mode: 1 } }); second.init({ paths: ['/b'], track: { mode: 1 } });
    const fa = await a.window.fetch('/a') as { input: string }, fb = await b.window.fetch('/b') as { input: string };
    expect(new URL(fa.input).searchParams.get('msToken')).toBe('a');
    expect(new URL(fb.input).searchParams.get('msToken')).toBe('b');
    expect((await a.window.fetch('/b') as { input: string }).input).toBe('/b');
  });

  it('captures token per loaded context even when storage is shared or later cleared', async () => {
    // Conditional shared-storage scenario, not proof of Electron file-origin policy.
    const saved = new Map([['xmst', 'initial']]);
    const first = fixture(saved), preloaded = fixture(saved);
    const initialize = (f: ReturnType<typeof fixture>) => {
      const runtime = new DesktopBdmsRuntime(f.context);
      runtime.init({ aid: 339757, pageId: 23420, paths: ['/passport'], track: { mode: 1 } });
      return runtime;
    };
    const runtime = initialize(first); initialize(preloaded);
    const token = async (f: ReturnType<typeof fixture>) => {
      const response = await f.window.fetch('/passport/login') as { input: string };
      return new URL(response.input).searchParams.get('msToken');
    };
    saved.set('xmst', 'later');
    first.context.document.cookie = 'msToken=cookie-only';
    runtime.init({ paths: ['/passport'], track: { mode: 1 } });
    expect(await token(first)).toBe('initial');
    expect(await token(preloaded)).toBe('initial');
    const reloaded = fixture(saved); initialize(reloaded);
    expect(await token(reloaded)).toBe('later');
    saved.clear();
    expect(await token(first)).toBe('initial');
    expect(await token(reloaded)).toBe('later');
    const afterClear = fixture(saved); initialize(afterClear);
    expect(await token(afterClear)).toBeNull();
    for (const f of [first, preloaded, reloaded, afterClear]) {
      expect(f.trace.filter(value => value === 'storage:get:xmst')).toHaveLength(1);
    }
  });
});
