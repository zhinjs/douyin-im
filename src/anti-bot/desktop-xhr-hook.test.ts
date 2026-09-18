import { installDesktopXhrHook, type DesktopHookXhr, type DesktopXhrHookContext } from './desktop-xhr-hook.js';
import { DesktopBdmsConfiguration } from './desktop-config.js';
import { DesktopReportSender } from './desktop-report.js';
import { DesktopTokenState } from './desktop-token.js';

function fixture(options: { fail?: string; duringOpen?: (xhr: DesktopHookXhr) => void } = {}) {
  const trace: unknown[][] = [];
  class Xhr implements DesktopHookXhr {
    declare bdmsInvokeList?: NonNullable<DesktopHookXhr['bdmsInvokeList']>;
    open(...args: unknown[]) { trace.push(['open', ...args]); options.duringOpen?.(this); if (options.fail === 'open') throw Error('open'); return 1; }
    setRequestHeader(...args: unknown[]) { trace.push(['header', ...args]); if (options.fail === 'header') throw Error('header'); return 2; }
    send(...args: unknown[]) { trace.push(['send', ...args]); if (options.fail === 'send') throw Error('send'); return 3; }
    abort() { trace.push(['abort']); return 4; }
  }
  const context = { XMLHttpRequest: Xhr, Array, URL, location: { href: 'https://fixture.invalid/' } };
  const callbacks = {
    matchesSigning(path: string) { trace.push(['match', path]); return path.startsWith('/hit'); },
    matchesBehavior(path: string) { trace.push(['track', path]); return path.startsWith('/hit'); },
    sign(query: string, body: unknown) { trace.push(['sign', query, body]); if (options.fail === 'sign') throw Error('sign'); return 'signed'; },
    reportBehavior() { trace.push(['report']); if (options.fail === 'report') throw Error('report'); },
  };
  const tokens = { token: 'cached' };
  installDesktopXhrHook(context, tokens, callbacks);
  return { Xhr, xhr: new Xhr(), context, callbacks, tokens, trace, options };
}

describe('Desktop full XHR hook', () => {
  it('accepts narrower browser-style method signatures without a cast', () => {
    // Node-only project: check structural variance without introducing global DOM types.
    const accepts = (prototype: {
      open(method: string, url: string | URL, async?: boolean, user?: string | null, password?: string | null): void;
      setRequestHeader(name: string, value: string): void;
      send(body?: string | null): void;
    }): DesktopXhrHookContext => ({ XMLHttpRequest: { prototype }, Array, URL, location: { href: '' } });
    expect(typeof accepts).toBe('function');
  });
  it('defers the complete open/header arguments, then signs, replays, reports and sends once', () => {
    const f = fixture();
    expect(f.xhr.open('POST', '/hit', false, 'user', 'pass', 'extra')).toBeUndefined();
    expect(f.xhr.setRequestHeader('Content-Type', 'multipart/form-data', 'extra')).toBeUndefined();
    expect(f.trace).toEqual([['match', '/hit']]);
    expect(f.xhr.send('body', 'ignored')).toBeUndefined();
    expect(f.trace).toEqual([
      ['match', '/hit'], ['sign', 'msToken=cached', 'body'],
      ['open', 'POST', 'https://fixture.invalid/hit?msToken=cached&a_bogus=signed', false, 'user', 'pass', 'extra'],
      ['header', 'Content-Type', 'multipart/form-data', 'extra'], ['track', '/hit'], ['report'], ['send', 'body'],
    ]);
    expect(Object.hasOwn(f.xhr, 'bdmsInvokeList')).toBe(false);
    f.xhr.send(); expect(f.trace.at(-1)).toEqual(['send', undefined]);
  });
  it('passes unmatched requests through and clears an old queue before parsing a new URL', () => {
    const f = fixture(); f.xhr.open('GET', '/hit'); f.xhr.setRequestHeader('old', 'value');
    // Node URL errors originate outside Jest's VM realm; compare their contract, not instanceof.
    expect(() => f.xhr.open('GET', 'http://[')).toThrow(expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_URL' }));
    expect(Object.hasOwn(f.xhr, 'bdmsInvokeList')).toBe(false);
    f.trace.length = 0;
    expect(f.xhr.open('GET', '/miss')).toBeUndefined(); f.xhr.setRequestHeader('x', 'y'); f.xhr.send();
    expect(f.trace).toEqual([['match', '/miss'], ['open', 'GET', '/miss'], ['header', 'x', 'y'], ['send', undefined]]);
  });
  it('keeps URL object identity and existing empty token/signature keys', () => {
    const f = fixture(); const url = new URL('https://fixture.invalid/hit?msToken=&a_bogus=');
    f.xhr.open('POST', url); url.pathname = '/changed'; f.xhr.send('x');
    expect(f.trace).toEqual([['match', '/hit'], ['open', 'POST', url], ['track', '/changed'], ['send', 'x']]);
    expect(f.trace[1]![2]).toBe(url);
  });
  it('does not treat abort as clearing the deferred queue', () => {
    const f = fixture(); f.xhr.open('GET', '/hit'); expect(f.xhr.abort()).toBe(4);
    expect(f.xhr.bdmsInvokeList).toHaveLength(1); f.xhr.send();
    expect(f.trace.map(x => x[0])).toEqual(['match', 'abort', 'sign', 'open', 'track', 'report', 'send']);
  });
  it.each(['sign', 'open', 'header', 'report', 'send'])('retains source partial state when %s throws, without retry', stage => {
    const f = fixture({ fail: stage }); const url = new URL('https://fixture.invalid/hit');
    f.xhr.open('POST', url); f.xhr.setRequestHeader('x', 'y');
    expect(() => f.xhr.send('body')).toThrow(stage);
    expect(Object.hasOwn(f.xhr, 'bdmsInvokeList')).toBe(stage !== 'send');
    expect(url.searchParams.has('msToken')).toBe(true);
    expect(url.searchParams.has('a_bogus')).toBe(stage !== 'sign');
    expect(f.trace.filter(x => x[0] === 'send')).toHaveLength(stage === 'send' ? 1 : 0);
  });
  it('uses live queued entries but ignores entries appended during replay', () => {
    const f = fixture({ duringOpen(xhr) {
      xhr.bdmsInvokeList![1]!.args[1] = 'changed';
      xhr.setRequestHeader('late', 'lost');
    } });
    f.xhr.open('POST', '/hit'); f.xhr.setRequestHeader('x', 'initial'); f.xhr.send();
    expect(f.trace.filter(x => x[0] === 'header')).toEqual([['header', 'x', 'changed']]);
  });
  it('throws for refused URL writes and nonconfigurable queue deletion', () => {
    const f = fixture(); f.xhr.open('GET', '/hit');
    Object.defineProperty(f.xhr, 'bdmsInvokeList', { configurable: false });
    Object.freeze(f.xhr.bdmsInvokeList![0]!.args);
    expect(() => f.xhr.send()).toThrow(TypeError);
    expect(f.xhr.bdmsInvokeList![0]!.args[1]).toBe('/hit');
    expect(f.trace.some(x => x[0] === 'open')).toBe(false);
    expect(() => f.xhr.open('GET', '/miss')).toThrow(TypeError);
  });
  it('shares config/token with a report sender captured before hook installation', () => {
    const calls: unknown[][] = [], frames: ((time: number) => void)[] = [], instances: Xhr[] = [];
    class Xhr {
      withCredentials = false;
      load?: () => void;
      constructor() { instances.push(this); }
      open(...args: unknown[]) { calls.push(['open', ...args]); }
      setRequestHeader(...args: unknown[]) { calls.push(['header', ...args]); }
      send(...args: unknown[]) { calls.push(['send', ...args]); }
      addEventListener(_type: string, callback: () => void) { this.load = callback; }
      getResponseHeader() { return 'fresh'; }
    }
    const context = {
      XMLHttpRequest: Xhr, URL, Array, Object, RegExp, Symbol, TypeError, window: {},
      location: { href: 'https://fixture.invalid/' }, JSON, Date: { now: () => 123 },
      Math: { floor: Math.floor, random: () => .5 }, navigator: { sendBeacon: () => true },
      localStorage: { getItem: () => '', setItem: () => {} },
      requestAnimationFrame(callback: (time: number) => void) { frames.push(callback); },
    };
    const manager = new DesktopBdmsConfiguration(context, () => {});
    const tokens = new DesktopTokenState(context);
    let devices = 0, behaviors = 0;
    const sender = new DesktopReportSender(context, manager.config, tokens, () => { devices++; });
    installDesktopXhrHook(context, tokens, {
      matchesSigning: path => manager.matchesSigning(path), matchesBehavior: path => manager.matchesBehavior(path),
      sign(query, body) { calls.push(['sign', query, body]); return 'signed'; }, reportBehavior() { behaviors++; },
    });
    const beforeInit = new Xhr(); beforeInit.open('GET', '/passport'); beforeInit.send();
    expect(calls.some(x => x[0] === 'sign')).toBe(false);
    manager.init({ aid: 339757, paths: ['/passport'], track: { paths: ['/passport'] } });
    sender.send({}); instances.at(-1)!.load!();
    expect(tokens.token).toBe('fresh'); expect(frames).toHaveLength(1); frames[0]!(0); expect(devices).toBe(1);
    const business = new Xhr(); business.open('POST', '/passport/login'); business.send('form');
    expect(calls).toContainEqual(['sign', 'msToken=fresh', 'form']); expect(behaviors).toBe(1);
    expect(calls.filter(x => x[0] === 'sign')).toHaveLength(1);
    // Report methods bypass business hooks, including when config later matches every URL.
    manager.init({ paths: ['.*'] }); sender.send({});
    expect(calls.filter(x => x[0] === 'sign')).toHaveLength(1);
  });
});
