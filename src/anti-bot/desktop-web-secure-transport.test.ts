import { DesktopWebSecureRequestPipeline } from './desktop-web-secure-request.js';
import { DesktopWebSecureTransportHooks, captureDesktopWebSecureTransportFeatures, parseDesktopWebSecureResponseHeaders, type DesktopWebSecureTransportContext, type DesktopWebSecureXhr } from './desktop-web-secure-transport.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const opens = jest.fn(), sends = jest.fn(), headerWrites = jest.fn(), background = jest.fn();
  class Xhr implements DesktopWebSecureXhr {
    secureOpenArgs?: IArguments;
    readyState = 0;
    onloadend: unknown = null;
    onreadystatechange: unknown = null;
    open(...args: unknown[]) { opens(this, ...args); return 'open-return'; }
    send(...args: unknown[]) { sends(this, ...args); return 'send-return'; }
    setRequestHeader(...args: unknown[]) { headerWrites(this, ...args); }
    getAllResponseHeaders() { return 'Bd-Ticket-Guard-Server-Data: encoded\nX-TT-LOGID: log-id'; }
  }
  const response: { headers?: { forEach?: (callback: (value: unknown, key: string) => void) => void; get?: (key: string) => unknown }; body: string } = {
    headers: { forEach(callback) { callback('encoded', 'bd-ticket-guard-server-data'); callback('log-id', 'x-tt-logid'); } }, body: 'unread',
  };
  const nativeFetch = jest.fn(function(this: unknown, ...args: unknown[]) { void args; return Promise.resolve(response); });
  const window = { XMLHttpRequest: Xhr, Request, Headers, fetch: nativeFetch };
  const context: DesktopWebSecureTransportContext = { window, XMLHttpRequest: Xhr, URL, location: { href: 'https://synthetic.invalid/base/' },
    get Request() { return window.Request; }, get Headers() { return window.Headers; }, onBackgroundError: background };
  const pipeline = new DesktopWebSecureRequestPipeline({ Date, pageHref: context.location.href }, undefined);
  const prepared = { 'bd-ticket-guard-version': 2, 'x-signature': 'synthetic-signature' };
  const prepare = jest.spyOn(pipeline, 'prepare').mockImplementation(async request => Object.assign(request, { headers: { ...prepared }, extras: { scene: 'synthetic' } }));
  const complete = jest.spyOn(pipeline, 'complete').mockImplementation(async value => value);
  const hooks = new DesktopWebSecureTransportHooks(context, pipeline);
  hooks.config = { web: [{ scene: 'web_protect', consumerPathList: ['/'] }] };
  return { Xhr, opens, sends, headerWrites, background, response, nativeFetch, window, context, pipeline, prepare, complete, hooks, prepared };
}
afterEach(() => jest.restoreAllMocks());

it('manual hook entry pins pubKey/header irrespective of transport type, login or route configuration', async () => {
  const f = fixture(), signData = { ticket: 'explicit', ts_sign: 'ts.2.synthetic', path: '/follow' };
  const manual = jest.spyOn(f.pipeline, 'createTicketGuardHeaders');
  f.hooks.setType({ initType: 'cert', signType: 'cert' }); f.hooks.setConfig({}); f.hooks.setLogin(false); f.hooks.setUpdateDataWhenVerifySuccess(true);
  const result = await f.hooks.getBdTicketGuardHeader(signData);
  expect(manual).toHaveBeenCalledWith({ signData, signType: 'pubKey', certType: 'header' });
  expect(result.bdTicketGuardHeaders).toHaveProperty('bd-ticket-guard-ree-public-key');
  expect(f.nativeFetch).not.toHaveBeenCalled(); expect(f.sends).not.toHaveBeenCalled();
  expect(f.hooks.updateData).toBe(true); expect(f.hooks.login).toBe(false);
  f.hooks.setType({}); expect(f.hooks.initType).toBe('pubKey'); expect(f.hooks.signType).toBe('pubKey');
});

it('XHR stores original open arguments, discards open return, and sends only after signing', async () => {
  const f = fixture(), xhr = new f.Xhr(); expect(xhr.open('POST', '../send')).toBeUndefined();
  expect(Array.from(xhr.secureOpenArgs!)).toEqual(['POST', '../send']); expect(xhr.send('body', 'extra')).toBeUndefined(); expect(f.sends).not.toHaveBeenCalled();
  await flush(); expect(f.prepare).toHaveBeenCalledWith({ method: 'POST', url: 'https://synthetic.invalid/send', headers: { ...f.prepared }, extras: { scene: 'synthetic' } }, expect.objectContaining({ needProxy: true }));
  expect(f.headerWrites).toHaveBeenCalledWith(xhr, 'x-signature', 'synthetic-signature'); expect(f.sends).toHaveBeenCalledWith(xhr, 'body', 'extra');
});

it.each([false, undefined, 0, null])('XHR explicit falsy async=%s bypasses signing but keeps response handling', async async => {
  const f = fixture(), xhr = new f.Xhr(), done = jest.fn(); xhr.onloadend = done; xhr.open('GET', '/read', async);
  expect(xhr.send()).toBe('send-return'); expect(f.prepare).not.toHaveBeenCalled(); xhr.readyState = 4;
  await (xhr.onloadend as () => Promise<unknown>)(); expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ reqHeaders: {}, config: expect.objectContaining({ extras: {} }) }), expect.anything(), false);
  expect(done).toHaveBeenCalledTimes(1);
});

it('XHR prefers onloadend, waits for completion, and binds callback to captured XHR', async () => {
  const f = fixture(), xhr = new f.Xhr(), pending = gate<void>(), seen: unknown[] = [];
  f.complete.mockImplementation(async value => { await pending.promise; return value; });
  xhr.onloadend = function(this: unknown, ...args: unknown[]) { seen.push(this, ...args); return 42; }; const state = jest.fn(); xhr.onreadystatechange = state;
  xhr.open('GET', '/read'); xhr.send(); await flush(); xhr.readyState = 4;
  const task = Reflect.apply(xhr.onloadend as (...args: unknown[]) => Promise<unknown>, {}, ['event']); await flush(); expect(seen).toEqual([]);
  pending.resolve(); expect(await task).toBe(42); expect(seen).toEqual([xhr, 'event']); expect(xhr.onreadystatechange).toBe(state);
});

it.each([true, false])('XHR onreadystatechange fallback with existing callback=%s handles state transitions', async existing => {
  const f = fixture(), xhr = new f.Xhr(), callback = jest.fn(); if (existing) xhr.onreadystatechange = callback;
  xhr.open('GET', '/read'); xhr.send(); await flush(); const handler = xhr.onreadystatechange as (...args: unknown[]) => Promise<unknown>;
  xhr.readyState = 3; await handler('loading'); expect(f.complete).not.toHaveBeenCalled();
  xhr.readyState = 4; await handler('done'); await handler('again'); expect(f.complete).toHaveBeenCalledTimes(2);
  expect(callback).toHaveBeenCalledTimes(existing ? 3 : 0);
});

it('XHR keeps request-time route but reads current updateData at completion', async () => {
  const f = fixture(), xhr = new f.Xhr(); xhr.open('GET', '/read'); xhr.send(); await flush();
  const route = f.prepare.mock.calls[0]![1]; f.hooks.config = {}; f.hooks.updateData = true; xhr.readyState = 4;
  await (xhr.onreadystatechange as () => Promise<unknown>)(); expect(f.complete.mock.calls[0]![1]).toBe(route); expect(f.complete.mock.calls[0]![2]).toBe(true);
});

it('XHR observes rejected signing without sending or fabricating a recovery', async () => {
  const f = fixture(), xhr = new f.Xhr(); f.prepare.mockRejectedValue(Error('synthetic signer failed'));
  xhr.open('GET', '/read'); expect(xhr.send()).toBeUndefined(); await flush(); expect(f.sends).not.toHaveBeenCalled(); expect(f.background).toHaveBeenCalledWith(expect.objectContaining({ message: 'synthetic signer failed' }));
});

it('XHR rejected response handling skips user callback and preserves a rejected callback Promise', async () => {
  const f = fixture(), xhr = new f.Xhr(), callback = jest.fn(); f.complete.mockRejectedValue(Error('synthetic response failure'));
  xhr.onloadend = callback; xhr.open('GET', '/read'); xhr.send(); await flush(); xhr.readyState = 4;
  await expect((xhr.onloadend as () => Promise<unknown>)()).rejects.toThrow('synthetic response failure'); expect(callback).not.toHaveBeenCalled();
  expect(f.background).toHaveBeenCalledWith(expect.objectContaining({ message: 'synthetic response failure' }));
});

it('unmatched XHR keeps original callback and synchronous native send result', () => {
  const f = fixture(), xhr = new f.Xhr(), callback = jest.fn(); f.hooks.config = {}; xhr.onloadend = callback;
  xhr.open('GET', '/read'); expect(xhr.send()).toBe('send-return'); expect(xhr.onloadend).toBe(callback); expect(f.prepare).not.toHaveBeenCalled();
});

it('fetch mutates plain init headers, retains native receiver and only passes two arguments', async () => {
  const f = fixture(), receiver = {}, init = { method: 'POST', headers: { keep: 'value' } };
  const result = await Reflect.apply(f.window.fetch, receiver, ['/send', init, 'ignored']);
  expect(result).toBe(f.response); expect(f.nativeFetch.mock.contexts[0]).toBe(receiver); expect(f.nativeFetch.mock.calls[0]).toEqual(['/send', init]);
  expect(init.headers).toEqual({ keep: 'value', ...f.prepared });
});

it('Request input uses original method and mutates original headers without merging init overrides', async () => {
  const f = fixture(), request = new Request('https://synthetic.invalid/send', { method: 'POST', headers: { keep: 'request' } });
  const init = { method: 'DELETE', headers: { override: 'init' } }; await f.window.fetch(request, init);
  expect(f.prepare.mock.calls[0]![0]['method']).toBe('POST'); expect(request.headers.get('x-signature')).toBe('synthetic-signature');
  expect(init.headers).toEqual({ override: 'init' }); expect(f.nativeFetch.mock.calls[0]![0]).toBe(request); expect(f.nativeFetch.mock.calls[0]![1]).toBe(init);
});

it.each(['array', 'Headers'])('fetch preserves %s headers semantics', async kind => {
  const f = fixture(), headers = kind === 'array' ? [['x-signature', 'old']] : new Headers({ 'x-signature': 'old' });
  await f.window.fetch('/send', { headers });
  if (headers instanceof Headers) expect(headers.get('x-signature')).toBe('synthetic-signature');
  else expect(headers).toEqual([['x-signature', 'old'], ['bd-ticket-guard-version', 2], ['x-signature', 'synthetic-signature']]);
});

it.each(['init', 'headers'])('frozen %s blocks injection but does not stop fetch or clear produced reqHeaders', async target => {
  const f = fixture(), headers = { keep: 'value' }, init = { headers }; Object.freeze(target === 'init' ? init : headers);
  expect(await f.window.fetch('/send', init)).toBe(f.response); expect(headers).toEqual({ keep: 'value' });
  expect(f.complete.mock.calls[0]![0].reqHeaders).toEqual(f.prepared);
});

it('partly successful fetch header injection is not rolled back', async () => {
  const f = fixture(), headers = { keep: 'value' }; Object.defineProperty(headers, 'x-signature', { set() { throw Error('blocked'); } });
  await f.window.fetch('/send', { headers }); expect(headers).toEqual({ keep: 'value', 'bd-ticket-guard-version': 2 }); expect(f.nativeFetch).toHaveBeenCalledTimes(1);
});

it('fetch forEach preserves supplied casing; get-only fallback reads only two headers', async () => {
  const f = fixture(); f.response.headers = { forEach(callback) { callback('value', 'Mixed-Case'); } }; await f.window.fetch('/send');
  expect(f.complete.mock.calls[0]![0].headers).toEqual({ 'Mixed-Case': 'value' });
  const get = jest.fn(() => 'value'); f.response.headers = { get }; await f.window.fetch('/send');
  expect(get.mock.calls).toEqual([['bd-ticket-guard-server-data'], ['bd-ticket-guard-result']]); expect(f.complete.mock.calls[1]![0].headers).not.toHaveProperty('x-tt-logid');
});

it('fetch awaits completion settlement, swallowing rejection but not invoking a retry', async () => {
  const f = fixture(), pending = gate<void>(); f.complete.mockImplementation(async value => { await pending.promise; return value; });
  let done = false; const task = f.window.fetch('/send').then(value => { done = true; return value; }); await flush(); expect(done).toBe(false);
  pending.resolve(); expect(await task).toBe(f.response); f.complete.mockRejectedValue(Error('response failed')); expect(await f.window.fetch('/send')).toBe(f.response);
  expect(f.nativeFetch).toHaveBeenCalledTimes(2);
});

it('fetch distinguishes synchronous classifier failure and synchronous completion failure', async () => {
  const f = fixture(), classify = jest.spyOn(f.pipeline, 'classify').mockImplementation(() => { throw Error('classify'); });
  expect(() => f.window.fetch('/send')).toThrow('classify'); classify.mockRestore();
  f.complete.mockImplementation(() => { throw Error('complete sync'); }); await expect(f.window.fetch('/send')).rejects.toThrow('complete sync');
});

it('fetch response-header failure rejects and is outside the completion catch', async () => {
  const f = fixture(); f.response.headers = { forEach() { throw Error('reader'); } };
  await expect(f.window.fetch('/send')).rejects.toThrow('reader'); expect(f.complete).not.toHaveBeenCalled();
});

it('native fetch rejection does not invoke completion', async () => {
  const f = fixture(); f.nativeFetch.mockRejectedValue(Error('network-like synthetic failure'));
  await expect(f.window.fetch('/send')).rejects.toThrow('synthetic failure'); expect(f.complete).not.toHaveBeenCalled();
});

it('unmatched fetch does not mutate init and response without headers skips completion', async () => {
  const f = fixture(), init = { headers: { keep: 'value' } }; f.hooks.config = {}; await f.window.fetch('/send', init);
  expect(f.prepare).not.toHaveBeenCalled(); expect(init.headers).toEqual({ keep: 'value' });
  f.hooks.config = { web: [{ consumerPathList: ['/'] }] }; delete f.response.headers; expect(await f.window.fetch('/send')).toBe(f.response); expect(f.complete).not.toHaveBeenCalled();
});

it('feature capture is once per realm and based on property presence, not function type', () => {
  const first = { XMLHttpRequest: { prototype: { open() {}, send() {}, setRequestHeader() {} } } }, second = { ...first, fetch: undefined };
  const initial = captureDesktopWebSecureTransportFeatures(first); Object.assign(first, { fetch: () => {} });
  expect(captureDesktopWebSecureTransportFeatures(first)).toBe(initial); expect(initial.fetch).toBe(false); expect(Object.isFrozen(initial)).toBe(true);
  expect(captureDesktopWebSecureTransportFeatures(second).fetch).toBe(true);
});

it('Gn lowercases, preserves set-cookie arrays, combines guard duplicates and honors singleton first truthy value', () => {
  expect(parseDesktopWebSecureResponseHeaders('Bd-Ticket-Guard-Server-Data: a\nBD-TICKET-GUARD-SERVER-DATA: b\nContent-Type: \ncontent-type: x\ncontent-type: y\nset-cookie: a=b\nSet-Cookie: c=d\nBadLine\n:empty\nValue: a:b'))
    .toEqual({ 'bd-ticket-guard-server-data': 'a, b', 'content-type': 'x', 'set-cookie': ['a=b', 'c=d'], value: 'a:b' });
});

it('async XHR header injection failure prevents send and is observed, unlike fetch injection failure', async () => {
  const f = fixture(), xhr = new f.Xhr(); f.headerWrites.mockImplementation(() => { throw Error('header failed'); });
  xhr.open('GET', '/send'); xhr.send(); await flush(); expect(f.sends).not.toHaveBeenCalled(); expect(f.background).toHaveBeenCalledWith(expect.objectContaining({ message: 'header failed' }));
});
