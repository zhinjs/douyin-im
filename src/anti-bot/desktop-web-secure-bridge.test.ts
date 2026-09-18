import {
  DesktopWebSecureBridgeHost, dispatchDesktopWebSecureSocketMessage,
  type DesktopWebSecureBridgeClient, type DesktopWebSecureBridgeContext,
  type DesktopWebSecureBridgeMessage, type DesktopWebSecureSocketConfig,
} from './desktop-web-secure-bridge.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let id = 0, clock = 10;
  const timers = new Map<number, { callback: () => void; delay: number }>(), listeners: Array<(event: DesktopWebSecureBridgeMessage) => void> = [];
  const globalListeners: Array<(event: { data: unknown }) => void> = [];
  const context: DesktopWebSecureBridgeContext = {
    origin: 'https://synthetic.invalid', performance: { now: () => clock++ }, Date: { now: () => 999 },
    setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: jest.fn(handle => { timers.delete(handle as number); }),
    addMessageListener: listener => { globalListeners.push(listener); },
  };
  const client: DesktopWebSecureBridgeClient = {
    config: {}, window: Promise.resolve(), isConnection: true, preCheck: jest.fn(async () => undefined),
    postIframeMessage: jest.fn(async () => undefined), getIframeState: () => ({ connection: 1 }),
    reStartConection: jest.fn(), emit: jest.fn(), on: (_name, listener) => { listeners.push(listener); },
    off: (_name, listener) => { const i = listeners.indexOf(listener); if (i !== -1) listeners.splice(i, 1); },
  };
  const host = new DesktopWebSecureBridgeHost(context);
  return { host, client, context, timers, listeners, globalListeners,
    receive(data: unknown) { [...listeners].forEach(listener => listener({ data })); },
    fire(timerId: number) { const timer = timers.get(timerId)!; timers.delete(timerId); timer.callback(); },
  };
}

it('waits for preCheck before starting the timer, then waits for the window before posting', async () => {
  const f = fixture(); let checked!: () => void, connected!: () => void;
  f.client.preCheck = () => new Promise(resolve => { checked = () => resolve(undefined); });
  f.client.window = new Promise(resolve => { connected = () => resolve(undefined); });
  const call = f.host.createBridge(f.client)('storage', 'getItem', ['key']); await flush(); expect(f.timers.size).toBe(0);
  checked(); await flush(); expect([...f.timers.values()][0]?.delay).toBe(8000); expect(f.client.postIframeMessage).not.toHaveBeenCalled();
  connected(); await flush(); expect(f.client.postIframeMessage).toHaveBeenCalledWith({ id: '0', message: { callObj: 'storage', callName: 'getItem', callArgs: ['key'] } });
  f.receive({ id: '0', promiseStatus: 'resolve', message: 'synthetic' }); await expect(call).resolves.toBe('synthetic');
  expect(f.listeners).toHaveLength(0); expect(f.timers.size).toBe(0);
});

it('increments IDs across bridge wrappers and allocates an ID even for invalid parameters', async () => {
  const f = fixture(), first = f.host.createBridge(f.client), second = f.host.createBridge(f.client);
  await expect(Reflect.apply(first, undefined, [123, 'get'])).rejects.toMatchObject({ name: 'CallBridgeParameterError', message: 'callObj:123, callName:get' });
  const a = first('a', 'get'), b = second('b', 'get'); await flush();
  f.receive({ id: '1', message: 1 }); f.receive({ id: '2', message: 2 }); await expect(a).resolves.toBe(1); await expect(b).resolves.toBe(2);
});

it('requires an exact string ID and treats statuses other than reject as fulfillment', async () => {
  const f = fixture(); let settled = false;
  const call = f.host.createBridge(f.client)('storage', 'get').then(value => { settled = true; return value; }); await flush();
  f.receive({ id: 0, message: 'wrong' }); f.receive({ id: 'other', message: 'wrong' }); await flush(); expect(settled).toBe(false);
  f.receive({ id: '0', promiseStatus: 'unknown', message: false }); await expect(call).resolves.toBe(false);
});

it('maps a remote rejection into its name and clears its listener and timeout', async () => {
  const f = fixture(), call = f.host.createBridge(f.client)('storage', 'get');
  const failure = expect(call).rejects.toMatchObject({ name: 'UNKNOW_CallBridge_Error', message: '', origin: f.context.origin }); await flush();
  f.receive({ id: '0', promiseStatus: 'reject', message: '' }); await failure;
  expect(f.listeners).toHaveLength(0); expect(f.timers.size).toBe(0);
});

it('leaves timeout state/listener until a late matching response arrives', async () => {
  const f = fixture(), call = f.host.createBridge(f.client)('storage', 'get');
  const failure = expect(call).rejects.toMatchObject({ name: 'CallBridgeInvokeTimeout:storage:get', message: '{"iframe":{"connection":1},"id":"0"}' });
  await flush(); f.fire(1); await failure; expect(f.listeners).toHaveLength(1);
  f.receive({ id: '0', message: 'late' }); expect(f.listeners).toHaveLength(0);
});

it('keeps the timer and listener on post failure; a late response can clean them', async () => {
  const f = fixture(), failure = new Error('synthetic post failure'); f.client.postIframeMessage = async () => { throw failure; };
  const call = f.host.createBridge(f.client)('storage', 'get'); await expect(call).rejects.toBe(failure);
  expect(f.listeners).toHaveLength(1); expect(f.timers.size).toBe(1); f.receive({ id: '0', message: 'late' }); expect(f.timers.size).toBe(0);
});

it('does not convert malformed event data into a successful empty result', async () => {
  const f = fixture(), call = f.host.createBridge(f.client)('storage', 'get');
  const failure = expect(call).rejects.toThrow(TypeError); await flush(); f.receive(null); await failure;
  expect(f.listeners).toHaveLength(1); expect(f.timers.size).toBe(1); f.receive({ id: '0', message: 'late' });
});

it('retries only once with the same ID and fixed 8s timeout, preserving the stale-listener hang', async () => {
  const f = fixture(); let settled = false;
  const call = f.host.createBridge(f.client, true, 3000)('storage', 'set');
  void call.then(() => { settled = true; }, () => { settled = true; });
  await flush(); expect(f.timers.get(1)?.delay).toBe(3000); f.fire(1); await flush();
  expect(f.client.reStartConection).toHaveBeenCalledWith('callBridge'); expect(f.timers.get(2)?.delay).toBe(8000); expect(f.listeners).toHaveLength(2);
  expect(f.client.postIframeMessage).toHaveBeenNthCalledWith(2, { id: '0', message: { callObj: 'storage', callName: 'set', callArgs: undefined } });
  f.receive({ id: '0', message: 'late' }); await flush(); expect(settled).toBe(false); expect(f.timers.size).toBe(0); expect(f.listeners).toHaveLength(1);
});

it('rejects a second timeout rather than repeatedly reconnecting', async () => {
  const f = fixture(), call = f.host.createBridge(f.client, true, 1)('storage', 'set');
  const failure = expect(call).rejects.toMatchObject({ name: 'CallBridgeInvokeTimeout:storage:set' });
  await flush(); f.fire(1); await flush(); f.fire(2); await failure;
  expect(f.client.reStartConection).toHaveBeenCalledTimes(1);
});

it('coalesces restart for simultaneous calls older than the shared retry boundary', async () => {
  const f = fixture(), bridge = f.host.createBridge(f.client, true, 1);
  const a = bridge('storage', 'set'), b = bridge('storage', 'set');
  const failures = [expect(a).rejects.toHaveProperty('name'), expect(b).rejects.toHaveProperty('name')];
  await flush(); f.fire(1); f.fire(2); await flush(); expect(f.client.reStartConection).toHaveBeenCalledTimes(1);
  f.fire(3); f.fire(4); await Promise.all(failures);
});

it('does not restart when isConnection is false, even if retry is enabled', async () => {
  const f = fixture(); f.client.isConnection = false;
  const call = f.host.createBridge(f.client, true, 1)('storage', 'set'), failure = expect(call).rejects.toHaveProperty('name');
  await flush(); f.fire(1); await failure; expect(f.client.reStartConection).not.toHaveBeenCalled();
});

it('registers the debug log listener only on an enabled retry', async () => {
  const f = fixture(); f.client.config.debug = true;
  const call = f.host.createBridge(f.client, true, 1)('storage', 'set'), failure = expect(call).rejects.toHaveProperty('name');
  await flush(); expect(f.globalListeners).toHaveLength(0); f.fire(1); await flush(); expect(f.globalListeners).toHaveLength(1);
  f.globalListeners[0]!({ data: 'log:synthetic' }); expect(f.client.emit).toHaveBeenCalledWith('debug', { name: 'Message:Log=synthetic' });
  f.fire(2); await failure;
});

it('captures postIframeMessage when creating the bridge, not for each invocation', async () => {
  const f = fixture(), original = f.client.postIframeMessage, bridge = f.host.createBridge(f.client);
  const replacement = jest.fn(async () => undefined); f.client.postIframeMessage = replacement;
  const call = bridge('storage', 'get'); await flush();
  expect(original).toHaveBeenCalledTimes(1); expect(replacement).not.toHaveBeenCalled();
  f.receive({ id: '0', message: 'synthetic' }); await call;
});

it('does not create a timer for a rejected preCheck or missing window', async () => {
  const f = fixture(), failure = new Error('synthetic precheck failure');
  f.client.preCheck = async () => { throw failure; };
  await expect(f.host.createBridge(f.client)('storage', 'get')).rejects.toBe(failure); expect(f.timers.size).toBe(0);
  f.client.preCheck = async () => undefined; f.client.window = undefined;
  await expect(f.host.createBridge(f.client)('storage', 'get')).rejects.toThrow(TypeError); expect(f.timers.size).toBe(0);
});

it('still posts after a timed-out window wait eventually connects', async () => {
  const f = fixture(); let connect!: () => void;
  f.client.window = new Promise(resolve => { connect = () => resolve(undefined); });
  const call = f.host.createBridge(f.client)('storage', 'get'), failure = expect(call).rejects.toHaveProperty('name');
  await flush(); f.fire(1); await failure; expect(f.listeners).toHaveLength(0);
  connect(); await flush(); expect(f.client.postIframeMessage).toHaveBeenCalledTimes(1); expect(f.listeners).toHaveLength(1);
  f.receive({ id: '0', message: 'late' }); expect(f.listeners).toHaveLength(0);
});

it('shares reconnect coordination across clients within one host but isolates different hosts', async () => {
  const a = fixture(), b = fixture();
  const first = a.host.createBridge(a.client, true, 1)('storage', 'set');
  const second = a.host.createBridge(b.client, true, 1)('storage', 'set');
  const failures = [expect(first).rejects.toHaveProperty('name'), expect(second).rejects.toHaveProperty('name')];
  await flush(); a.fire(1); a.fire(2); await flush();
  expect(a.client.reStartConection).toHaveBeenCalledTimes(1); expect(b.client.reStartConection).not.toHaveBeenCalled();
  a.fire(3); a.fire(4); await Promise.all(failures);
  const isolated = b.host.createBridge(b.client)('storage', 'get'); await flush();
  expect(b.client.postIframeMessage).toHaveBeenLastCalledWith({ id: '0', message: { callObj: 'storage', callName: 'get', callArgs: undefined } });
  b.receive({ id: '0', message: 'independent' }); await expect(isolated).resolves.toBe('independent');
});

function dispatch(config: DesktopWebSecureSocketConfig, origin: string, data: unknown) {
  const source = { postMessage: jest.fn() }, emit = jest.fn();
  dispatchDesktopWebSecureSocketMessage(config, { origin, data, source }, { originSuffix: '.douyin.com', emit });
  return { source, emit };
}

it('filters the exact configured iframe origin and protocol before exposing bridge events', () => {
  const config = { url: 'https://store.example/path', protocol: 'SERCURE', allowOrigin: ['evil.example'] };
  expect(dispatch(config, 'https://evil.example', { protocol: 'SERCURE', data: { id: '0' } }).emit).not.toHaveBeenCalled();
  expect(dispatch(config, 'https://store.example', { protocol: 'other' }).emit).not.toHaveBeenCalled();
  const result = dispatch(config, 'https://store.example', { protocol: 'SERCURE', type: 'function', data: { id: '0' } });
  expect(result.emit).toHaveBeenCalledWith('message', { type: 'function', data: { id: '0' }, origin: 'https://store.example', sourceWindow: result.source });
});

it('replies to accepted ACK_0 without treating it as a bridge result', () => {
  const result = dispatch({ url: 'https://store.example/frame' }, 'https://store.example', 'ACK_0_synthetic');
  expect(result.source.postMessage).toHaveBeenCalledWith('ACK_1_ACK_0_synthetic', 'https://store.example'); expect(result.emit).not.toHaveBeenCalled();
});

it('preserves the source substring fallback only when no iframe URL is configured', () => {
  const result = dispatch({ protocol: 'SERCURE' }, 'https://a.douyin.com.untrusted.example', { protocol: 'SERCURE', data: 'synthetic' });
  expect(result.emit).toHaveBeenCalledWith('message', expect.any(Object));
  // This is source behavior, not an acceptable replacement for the configured-URL gate.
  expect(dispatch({ url: 'https://a.douyin.com/frame', protocol: 'SERCURE' }, 'https://a.douyin.com.untrusted.example', { protocol: 'SERCURE' }).emit).not.toHaveBeenCalled();
});

it('uses source string origin extraction, reporting malformed relative URLs instead of inventing a base', () => {
  const result = dispatch({ url: '/frame' }, 'https://store.example', {});
  expect(result.source.postMessage).toHaveBeenCalledWith(expect.stringMatching(/^SOCKET_ERROR_501@/), 'https://store.example');
  expect(result.emit).toHaveBeenCalledWith('debug', expect.objectContaining({ name: 'SomePostMessageEventError' }));
});
