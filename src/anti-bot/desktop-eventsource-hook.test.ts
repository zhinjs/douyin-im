import { installDesktopEventSourceHook, type DesktopEventSourceWrapper, type DesktopEventSourceHookContext } from './desktop-eventsource-hook.js';

function fixture(token = 'cached', fail = '') {
  const trace: unknown[][] = [];
  class Native {
    static OPEN = 1;
    args: unknown[];
    constructor(...args: unknown[]) { trace.push(['native', ...args]); if (fail === 'native') throw Error(fail); this.args = args; }
    close() { trace.push(['close']); }
  }
  const context = { window: { EventSource: Native }, URL, location: { href: 'https://fixture.invalid/base/' }, Object, Reflect, Proxy, Boolean, TypeError };
  const tokens = { token };
  const callbacks = {
    matchesSigning(path: string) { trace.push(['match', path]); return path.startsWith('/hit'); },
    matchesBehavior(path: string) { trace.push(['track', path]); return true; },
    sign(query: string, body: unknown) { trace.push(['sign', query, body, arguments.length]); if (fail === 'sign') throw Error(fail); return 'signed'; },
    reportBehavior() { trace.push(['report']); if (fail === 'report') throw Error(fail); },
  };
  installDesktopEventSourceHook(context, tokens, callbacks);
  const wrapper = () => context.window.EventSource as unknown as DesktopEventSourceWrapper<Native> & Pick<typeof Native, 'OPEN'>;
  return { context, trace, tokens, callbacks, Native, wrapper };
}

describe('Desktop EventSource hook', () => {
  it('inherits the native prototype/static fields and forwards two arguments with options identity', () => {
    const f = fixture(); const ES = f.wrapper(); const options = { withCredentials: true };
    const instance = new ES('/hit', options);
    expect(instance).toBeInstanceOf(ES); expect(instance).toBeInstanceOf(f.Native);
    expect(Object.getPrototypeOf(ES)).toBe(f.Native);
    expect(Object.getPrototypeOf(ES.prototype)).toBe(f.Native.prototype);
    expect(ES.OPEN).toBe(1); expect(Object.hasOwn(ES, 'OPEN')).toBe(false);
    expect(instance.args).toHaveLength(2); expect(instance.args[1]).toBe(options);
    expect(instance.args[0]).toBeInstanceOf(URL);
    expect((instance.args[0] as URL).href).toBe('https://fixture.invalid/hit?msToken=cached&a_bogus=signed');
    instance.close(); expect(f.trace.map(x => x[0])).toEqual(['match', 'track', 'report', 'sign', 'native', 'close']);
    expect(f.trace[3]).toEqual(['sign', 'msToken=cached', {}, 2]);
    expect(Object.getOwnPropertyDescriptor(ES, 'prototype')!.writable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(ES, 'handleUrl')).toMatchObject({ writable: true, enumerable: false, configurable: true });
  });
  it('preserves an unmatched relative string and still forwards undefined options', () => {
    const f = fixture(); const instance = new (f.wrapper())('/miss');
    expect(instance.args).toEqual(['/miss', undefined]); expect(f.trace).toEqual([['match', '/miss'], ['native', '/miss', undefined]]);
  });
  it('keeps URL identity, raw percent encoding for signing, and duplicates existing a_bogus', () => {
    const f = fixture(''); const url = new URL('https://fixture.invalid/hit?x=%20&a_bogus=old');
    const output = f.wrapper().handleUrl(url);
    expect(output).toBe(url); expect(f.trace).toContainEqual(['sign', 'x=%20&a_bogus=old', {}, 2]);
    expect(url.searchParams.getAll('a_bogus')).toEqual(['old', 'signed']);
  });
  it('supports source class-check call receiver and lexically scoped handleUrl in subclasses', () => {
    const f = fixture(); const ES = f.wrapper();
    expect(() => ES('/miss')).toThrow('Cannot call a class as a function'); expect(f.trace).toEqual([]);
    const receiver = Object.create(ES.prototype);
    expect(ES.call(receiver, '/miss').args[0]).toBe('/miss');
    class Child extends ES { static override handleUrl() { return '/child'; } }
    const child = new Child('/miss'); expect(child).toBeInstanceOf(Child); expect(child.args[0]).toBe('/miss');
    ES.handleUrl = () => '/override'; expect(new Child('/miss').args[0]).toBe('/override');
  });
  it('allows detached handleUrl and reads location even with a URL object', () => {
    const f = fixture(); const handle = f.wrapper().handleUrl;
    expect(handle('/miss')).toBe('/miss');
    Object.defineProperty(f.context.location, 'href', { get() { throw Error('location'); } });
    expect(() => handle(new URL('https://fixture.invalid/miss'))).toThrow('location');
  });
  it.each(['report', 'sign', 'native'])('preserves partial URL state on %s failure, with no automatic retry', stage => {
    const f = fixture('cached', stage); const url = new URL('https://fixture.invalid/hit');
    expect(() => new (f.wrapper())(url)).toThrow(stage);
    expect(url.searchParams.has('msToken')).toBe(stage !== 'report');
    expect(url.searchParams.has('a_bogus')).toBe(stage === 'native');
    expect(f.trace.filter(x => x[0] === 'native')).toHaveLength(stage === 'native' ? 1 : 0);
  });
  it('skips an absent constructor but rejects a refused window write', () => {
    const f = fixture(); const context: DesktopEventSourceHookContext = { ...f.context, window: {} };
    installDesktopEventSourceHook(context, f.tokens, f.callbacks);
    expect(context.window.EventSource).toBeUndefined();
    context.window.EventSource = f.Native;
    Object.defineProperty(context.window, 'EventSource', { writable: false });
    expect(() => installDesktopEventSourceHook(context, f.tokens, f.callbacks)).toThrow(TypeError);
    expect(context.window.EventSource).toBe(f.Native);
  });
  it('supports the source no-Reflect fallback with a callable parent', () => {
    const f = fixture();
    const parent = function(this: { args?: unknown[] }, ...args: unknown[]) { this.args = args; };
    const context = { ...f.context, window: { EventSource: parent }, Reflect: undefined };
    installDesktopEventSourceHook(context, f.tokens, f.callbacks);
    const ES = context.window.EventSource as unknown as DesktopEventSourceWrapper<{ args: unknown[] }>;
    const instance = new ES('/miss'); expect(instance).toBeInstanceOf(parent); expect(instance.args).toEqual(['/miss', undefined]);
  });
  it('keeps duplicate-install behavior visible so runtime owners cannot treat installation as idempotent', () => {
    const f = fixture(); const inner = f.wrapper();
    installDesktopEventSourceHook(f.context, f.tokens, f.callbacks);
    const instance = new (f.wrapper())('/hit'); expect(instance).toBeInstanceOf(inner);
    expect((instance.args[0] as URL).searchParams.getAll('a_bogus')).toEqual(['signed', 'signed']);
    expect(f.trace.map(x => x[0])).toEqual(['match', 'track', 'report', 'sign', 'match', 'track', 'report', 'sign', 'native']);
  });
});
