import { DesktopWebSecureIframeHost, type DesktopStorageIframeContext, type DesktopStorageConnectedFrame } from './desktop-web-secure-iframe.js';
import { DesktopWebSecureSocket, type DesktopWebSecureSocketOptions } from './desktop-web-secure-socket.js';
import { DesktopWebSecureEvents } from './desktop-web-secure-events.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function fixture(config: DesktopWebSecureSocketOptions = { url: 'https://store.example/frame', protocol: 'SERCURE' }, top = false) {
  let time = 1, nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Set<Parameters<DesktopStorageIframeContext['addMessageListener']>[0]>();
  const context: DesktopStorageIframeContext = {
    origin: 'https://app.synthetic.invalid', navigator: { userAgent: 'synthetic' }, window: {}, performance: { now: () => time++ }, Date: { now: () => 100 }, Math: { random: () => 0.5 },
    document: { body: null, readyState: 'complete', visibilityState: 'visible', getElementById: () => null, createElement: () => { throw Error('unexpected DOM operation'); }, addEventListener() {}, removeEventListener() {} },
    readLocalStorage: () => null, setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id as number); }, addMessageListener: jest.fn(listener => { listeners.add(listener); }), removeMessageListener: jest.fn(listener => { listeners.delete(listener); }),
  };
  const host = new DesktopWebSecureIframeHost(context), loader = host.createConnection(), initial = deferred<DesktopStorageConnectedFrame>();
  let next = initial;
  loader.start = jest.fn(() => next.promise); jest.spyOn(loader, 'setConfig'); jest.spyOn(loader, 'reset');
  host.createConnection = jest.fn(() => loader);
  const parent = { postMessage: jest.fn() }, window = { postMessage: jest.fn(), parent };
  if (top) window.parent = window;
  const write = jest.fn(), errors = jest.fn();
  const socket = new DesktopWebSecureSocket(host, { window, writeLocalStorage: write, onBackgroundError: errors }, config);
  const frame = (): DesktopStorageConnectedFrame => ({ startTime: 0, endTime: 0, postMessage: jest.fn(), destory: jest.fn(), isValid: () => true });
  return { socket, host, loader, initial, context, parent, window, timers, listeners, write, errors, frame,
    next() { next = deferred<DesktopStorageConnectedFrame>(); return next; },
    receive(data: unknown, origin = 'https://store.example') { [...listeners].forEach(listener => listener({ data, origin, source: parent })); },
    fire(delay: number) { const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay)!; timers.delete(id); timer.callback(); },
  };
}

it('starts with unresolved connection state and writes fallback version only after connection', async () => {
  const f = fixture({ url: 'https://store.example/frame', enableFallback: true });
  expect(f.socket.isStart).toBe(true); expect(f.socket.getIframeState().isConnection).toBe(-1); expect(f.write).not.toHaveBeenCalled();
  f.initial.resolve(f.frame()); await f.socket.window;
  expect(f.socket.getIframeState().isConnection).toBe(1); expect(f.write).toHaveBeenCalledWith('X_STORAGE_FALLBACK_VERSION', '4.0.3');
  expect(f.listeners.size).toBe(2); expect(f.context.addMessageListener).toHaveBeenCalledTimes(5);
});

it('post captures old protocol and URL while start changes config without rebuilding an existing window', async () => {
  const f = fixture(), frame = f.frame(), pending = f.socket.postIframeMessage({ synthetic: 1 });
  await f.socket.start({ url: 'https://changed.example/frame', protocol: 'Changed' });
  expect(f.loader.start).toHaveBeenCalledTimes(1); f.initial.resolve(frame); await pending;
  expect(frame.postMessage).toHaveBeenCalledWith({ protocol: 'SERCURE', data: { synthetic: 1 } }, 'https://store.example');
});

it('rejects posting without a window instead of pretending it was queued', async () => {
  const f = fixture({}); await expect(f.socket.postIframeMessage('synthetic')).rejects.toMatchObject({ name: 'postMessageError', message: '' });
  expect(f.loader.start).not.toHaveBeenCalled(); expect(f.socket.isStart).toBeUndefined();
});

it('direct reConnection reuses loader start without reset or destroy', async () => {
  const f = fixture(), frame = f.frame(); f.initial.resolve(frame); await f.socket.window;
  await expect(f.socket.reConnection()).resolves.toHaveProperty('target', frame);
  expect(f.loader.reset).not.toHaveBeenCalled(); expect(frame.destory).not.toHaveBeenCalled();
});

it('explicit restart begins the new attempt before asynchronously destroying the old target', async () => {
  const f = fixture(), frame = f.frame(), order: string[] = []; frame.destory = () => { order.push('destroy'); };
  f.initial.resolve(frame); await f.socket.window; const next = f.next();
  f.loader.start = jest.fn(() => { order.push('start'); return next.promise; });
  f.socket.reStartConection('manual'); expect(order).toEqual(['start']); await flush(); expect(order).toEqual(['start', 'destroy']);
  expect(f.loader.reset).toHaveBeenCalledTimes(1); expect(f.socket.isConnection).toBeUndefined();
  next.resolve(f.frame()); await f.socket.window;
});

it('preCheck resolves after restarting invalid target without waiting for its new ACK', async () => {
  const f = fixture(), frame = f.frame(); frame.isValid = () => false; f.initial.resolve(frame); await f.socket.window;
  const next = f.next(); await f.socket.preCheck(); expect(f.socket.isConnection).toBeUndefined(); expect(f.loader.reset).toHaveBeenCalledTimes(1);
  next.resolve(f.frame()); await f.socket.window;
});

it('retries failed preCheck only at the loader limit and when not disabled', async () => {
  const f = fixture({}); f.socket.isConnection = false;
  await f.socket.preCheck(); expect(f.loader.reset).not.toHaveBeenCalled();
  f.loader.autoLoadIframeConfig.current = 10; f.socket.config.disablePreCheckConnection = true;
  await f.socket.preCheck(); expect(f.loader.reset).not.toHaveBeenCalled();
  f.socket.config.disablePreCheckConnection = false; await f.socket.preCheck(); expect(f.loader.reset).toHaveBeenCalledTimes(1);
});

it('uses max rather than current or wall clock in the socket-level cache-busting query', async () => {
  const f = fixture({ url: 'https://store.example/index.html?x=1' }); f.initial.resolve(f.frame()); await f.socket.window;
  f.loader.autoLoadIframeConfig.max = 20; await f.socket.reConnection();
  expect(f.loader.setConfig).toHaveBeenLastCalledWith({ url: 'https://store.example/index.html?x=1&t=20', ackTimeout: undefined });
});

it('keeps config mutations if a start listener throws', async () => {
  const f = fixture({}), failure = new Error('synthetic config observer'); f.socket.on('config', () => { throw failure; });
  await expect(f.socket.start({ protocol: 'Changed' })).rejects.toBe(failure);
  expect(f.socket.config.protocol).toBe('Changed'); expect(f.socket.isStart).toBe(true);
});

it('maps connection failure and observes detached rejection without replacing the returned Promise', async () => {
  const f = fixture(), error = new Error('synthetic connection failure'), failure = jest.fn(); f.socket.on('error', failure);
  const original = f.socket.window!; f.initial.reject(error); await expect(original).rejects.toBe(error); await flush();
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'Connection:Error', message: error.message }));
  expect(f.socket.window).toBe(original); expect(f.socket.isConnection).toBe(false); expect(f.errors).toHaveBeenCalledWith(error);
});

it('a connection listener exception becomes connectionFail, including an error listener replacement', async () => {
  const f = fixture(), consumer = new Error('consumer'), replacement = new Error('replacement');
  f.socket.on('connection', () => { throw consumer; }); f.socket.on('error', () => { throw replacement; });
  f.initial.resolve(f.frame()); await expect(f.socket.window).rejects.toBe(replacement); expect(f.socket.isConnection).toBe(false);
});

it('starts fixed page-mode CSP downgrade without turning the original failure into success', async () => {
  const f = fixture({ url: 'https://store.example/frame', downgradeCSPURL: true }), next = f.next(), original = f.socket.window!;
  const failure = new Error('synthetic Content Security Policy'); f.initial.reject(failure); await expect(original).rejects.toBe(failure);
  expect(f.socket.config.url).toBe('https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.3/dist/page/index.html');
  expect(f.loader.reset).toHaveBeenCalledTimes(1); expect(f.socket.window).not.toBe(original);
  next.resolve(f.frame()); await f.socket.window;
});

it('preserves the native late-old-connection state update, without claiming generation fencing', async () => {
  const f = fixture(), old = f.socket.window!, next = f.next(); f.socket.reStartConection('replace');
  const current = f.socket.window!, newFrame = f.frame(); next.resolve(newFrame); const newer = await current;
  const oldFrame = f.frame(); f.initial.resolve(oldFrame); const older = await old; await flush();
  expect(f.socket.window).toBe(current); expect(newer.target).toBe(newFrame); expect(oldFrame.destory).toHaveBeenCalledTimes(1);
  expect(f.socket.getIframeState().startTime).toBe(older.startTime); expect(older.startTime).not.toBe(newer.startTime);
});

it('uses one per-socket p- counter for parent events and calls, and retains the success timer', async () => {
  const f = fixture({ protocol: 'SERCURE' }); f.socket.listen(); expect(f.parent.postMessage).toHaveBeenCalledWith('ACK', '*');
  await f.socket.dispatchParentEvent('synthetic', 1); const call = f.socket.callParentBridge('storage', 'get');
  expect(f.parent.postMessage).toHaveBeenLastCalledWith({ type: 'function', protocol: 'SERCURE', data: { id: 'p-1', message: { callObj: 'storage', callName: 'get', callArgs: undefined } } }, '*');
  f.receive({ protocol: 'SERCURE', data: { id: 'p-1', message: 7 } }, 'https://parent.synthetic.invalid'); await expect(call).resolves.toBe(7);
  expect(f.timers.size).toBe(1); f.fire(5000); await flush();
});

it('top-level parent calls still time out and preserve their listener until a late response', async () => {
  const f = fixture({}, true), call = f.socket.callParentBridge('a', 'b'), failure = expect(call).rejects.toHaveProperty('name', 'CallParentBridgeInvokeTimeout');
  expect(f.parent.postMessage).not.toHaveBeenCalled(); f.fire(5000); await failure;
  f.socket.emit('message', { data: { id: 'p-0', message: 'late' } });
  expect(f.socket.has('message')).toBe(true); // dt keeps an empty listener array, so has(name) remains true.
});

it('does not bypass the socket origin gate for bridge messages, while native diagnostic strings remain unfiltered', () => {
  const f = fixture(), messages = jest.fn(), errors = jest.fn(); f.socket.on('message', messages); f.socket.on('error', errors);
  f.receive({ protocol: 'SERCURE', data: { id: '0' } }, 'https://evil.invalid'); expect(messages).not.toHaveBeenCalled();
  f.receive('prefix SOCKET_ERROR_synthetic', 'https://evil.invalid'); expect(errors).toHaveBeenCalledWith(expect.objectContaining({ name: 'SCOKET_ERROR' }));
  f.socket.removeMessageEvent(); expect(f.context.removeMessageListener).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(2);
});

it('browser-safe dt emits snapshots, removes all duplicate listeners and treats error as an ordinary event', () => {
  const events = new DesktopWebSecureEvents(), calls: string[] = [];
  const second = () => { calls.push('second'); };
  events.on('event', () => { calls.push('first'); events.off('event', second); }); events.on('event', second); events.on('event', second);
  events.emit('event', undefined); expect(calls).toEqual(['first', 'second', 'second']); expect(events.has('event', second)).toBe(false);
  expect(() => events.emit('error', new Error('synthetic'))).not.toThrow();
});
