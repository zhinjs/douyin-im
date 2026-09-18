import { installDesktopFetchHook } from './desktop-fetch-hook.js';
import { DesktopBdmsConfiguration } from './desktop-config.js';

function fixture(token = 'cached') {
  const calls: { input: unknown; options: RequestInit; receiver: unknown; count: number }[] = [];
  const trace: unknown[][] = [];
  const response = { marker: 'response' };
  const native = function(this: unknown, input: unknown, options: RequestInit) {
    calls.push({ input, options, receiver: this, count: arguments.length });
    trace.push(['fetch']); return Promise.resolve(response);
  };
  const context = { window: { fetch: native }, Request, URL, location: { href: 'https://fixture.invalid/base/' } };
  const tokens = { token };
  const callbacks = {
    matchesSigning(path: string) { trace.push(['match', path]); return path.startsWith('/hit'); },
    matchesBehavior(path: string) { trace.push(['track', path]); return path.startsWith('/hit'); },
    sign(query: string, body: unknown, type?: string) { trace.push(['sign', query, body, type, arguments.length]); return 'signed'; },
    reportBehavior() { trace.push(['report']); },
  };
  installDesktopFetchHook(context, tokens, callbacks);
  return { calls, trace, context, tokens, callbacks, response };
}

describe('Desktop fetch hook', () => {
  it('passes unmatched input/options by reference, drops extra arguments and calls original with null receiver', async () => {
    const f = fixture(); const options = { body: 'x' };
    const result = await Reflect.apply(f.context.window.fetch, { ignored: true }, ['/miss', options, 'extra']);
    expect(result).toBe(f.response);
    expect(f.calls).toEqual([{ input: '/miss', options, receiver: null, count: 2 }]);
    expect(f.calls[0]!.options).toBe(options);
    expect(f.trace).toEqual([['match', '/miss'], ['fetch']]);
  });
  it('reports first, reads the current token, preserves raw query without token append, and always appends a signature', async () => {
    const f = fixture('');
    await f.context.window.fetch('/hit?x=a%20b&a_bogus=old', { body: 'text' });
    expect(f.trace).toEqual([
      ['match', '/hit'], ['track', '/hit'], ['report'], ['sign', 'x=a%20b&a_bogus=old', 'text', undefined, 2], ['fetch'],
    ]);
    expect(f.calls[0]!.input).toBe('https://fixture.invalid/hit?x=a+b&a_bogus=old&a_bogus=signed');
    f.callbacks.reportBehavior = () => { f.tokens.token = 'rotated'; };
    await f.context.window.fetch('/hit', {});
    expect(f.calls[1]!.input).toBe('https://fixture.invalid/hit?msToken=rotated&a_bogus=signed');
  });
  it('mutates a URL instance in place while keeping an existing empty token', async () => {
    const f = fixture(); const url = new URL('https://fixture.invalid/hit?msToken=');
    await f.context.window.fetch(url, {});
    expect(f.calls[0]!.input).toBe(url);
    expect(url.search).toBe('?msToken=&a_bogus=signed');
  });
  it('turns parsing and synchronous signer failures into rejections, with no native fetch', async () => {
    const f = fixture();
    let pending: unknown;
    expect(() => { pending = f.context.window.fetch('http://[', {}); }).not.toThrow();
    await expect(pending).rejects.toMatchObject({ name: 'TypeError' });
    f.callbacks.sign = () => { throw Error('sign'); };
    const url = new URL('https://fixture.invalid/hit');
    await expect(f.context.window.fetch(url, {})).rejects.toThrow('sign');
    expect(url.search).toBe('?msToken=cached'); expect(f.calls).toHaveLength(0);
  });
  it('clones a real Request body and signs an init override with original content type', async () => {
    const f = fixture(); const original = new Request('https://fixture.invalid/hit', {
      method: 'POST', body: 'source', headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    const options = { body: 'override' };
    await f.context.window.fetch(original, options);
    expect(f.trace).toContainEqual(['sign', 'msToken=cached', 'override', 'multipart/form-data; boundary=x', 3]);
    const sent = f.calls[0]!.input as Request;
    expect(sent).not.toBe(original); expect(original.bodyUsed).toBe(false);
    expect(await sent.text()).toBe('source'); expect(f.calls[0]!.options).toBe(options);
    expect(sent.headers.get('content-type')).toBe('multipart/form-data; boundary=x');
  });
  it('assigns null to init.body for an empty GET, even if init initially supplies a body', async () => {
    const f = fixture(); const options: RequestInit = { body: 'override' };
    await f.context.window.fetch(new Request('https://fixture.invalid/hit'), options);
    expect(f.trace).toContainEqual(['sign', 'msToken=cached', 'override', undefined, 3]);
    expect(options.body).toBeNull();
    expect((f.calls[0]!.input as Request).body).toBeNull();
  });
  it('rejects a frozen init at body assignment without native fetch', async () => {
    const f = fixture(); const options = Object.freeze({});
    await expect(f.context.window.fetch(new Request('https://fixture.invalid/hit'), options)).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
    expect(Object.hasOwn(options, 'body')).toBe(false);
  });
  it('propagates consumed Request cloning failure after reporting without a send', async () => {
    const f = fixture(); const request = new Request('https://fixture.invalid/hit', { method: 'POST', body: 'used' });
    await request.text();
    await expect(f.context.window.fetch(request, {})).rejects.toMatchObject({ name: 'TypeError' });
    expect(f.trace).toEqual([['match', '/hit'], ['track', '/hit'], ['report']]); expect(f.calls).toHaveLength(0);
  });
  it('uses only the source Request field list; original signal is not automatically forwarded', async () => {
    const f = fixture(); const controller = new AbortController();
    const request = new Request('https://fixture.invalid/hit', { signal: controller.signal });
    controller.abort(); await f.context.window.fetch(request, {});
    expect(request.signal.aborted).toBe(true); expect((f.calls[0]!.input as Request).signal.aborted).toBe(false);
  });
  it('does not reinstall on init and shares the live signing/behavior path configuration', async () => {
    const f = fixture(); const manager = new DesktopBdmsConfiguration({
      window: {}, Array, Object, RegExp, Symbol, TypeError,
    }, () => {});
    f.callbacks.matchesSigning = path => manager.matchesSigning(path);
    f.callbacks.matchesBehavior = path => manager.matchesBehavior(path);
    const installed = f.context.window.fetch;
    await f.context.window.fetch('/hit', {}); expect(f.trace).toEqual([['fetch']]);
    manager.init({ paths: ['/hit'], track: { paths: ['/hit'] } });
    await f.context.window.fetch('/hit', {});
    expect(f.trace).toContainEqual(['sign', 'msToken=cached', undefined, undefined, 2]);
    manager.init({}); expect(f.context.window.fetch).toBe(installed);
  });
});
