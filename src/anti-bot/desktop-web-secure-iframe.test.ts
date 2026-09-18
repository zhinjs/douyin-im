import {
  DesktopWebSecureIframeHost, type DesktopStorageIframeContext, type DesktopStorageFrameElement,
  type DesktopStorageFrameContainer, type DesktopStorageFrameParent, type DesktopStorageFrameEvent,
  type DesktopStorageConnectedFrame,
} from './desktop-web-secure-iframe.js';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function fixture() {
  let clock = 10, timerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>(), listeners: Array<(event: DesktopStorageFrameEvent) => void> = [];
  const documentListeners: Record<string, Array<() => void>> = {}, frames: DesktopStorageFrameElement[] = [], boxes = new Map<string, DesktopStorageFrameContainer>();
  const parent = (): DesktopStorageFrameParent => ({ parentNode: null,
    appendChild(node) { node.parentNode = this; if ('id' in node) boxes.set(node.id as string, node as DesktopStorageFrameContainer); },
    removeChild(node) { node.parentNode = null; },
  });
  const body = parent(), target = { postMessage: jest.fn() };
  const createElement = ((tag: string) => {
    if (tag === 'div') return { ...parent(), style: { display: '' }, id: '' };
    const frame: DesktopStorageFrameElement = { parentNode: null, style: { display: '' }, src: '', contentWindow: target, onload: null }; frames.push(frame); return frame;
  }) as DesktopStorageIframeContext['document']['createElement'];
  const context: DesktopStorageIframeContext = {
    origin: 'https://synthetic.invalid',
    document: { body, readyState: 'complete', visibilityState: 'visible', getElementById: id => boxes.get(id) ?? null, createElement,
      addEventListener(name, listener) { (documentListeners[name] ||= []).push(listener); },
      removeEventListener(name, listener) { const list = documentListeners[name] || [], i = list.indexOf(listener); if (i !== -1) list.splice(i, 1); },
    },
    navigator: { userAgent: 'synthetic' }, window: {}, performance: { now: () => clock++ }, Date: { now: () => 9000 }, Math: { random: () => 0.5 },
    readLocalStorage: jest.fn(() => null), setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id as number); }, addMessageListener(listener) { listeners.push(listener); },
    removeMessageListener(listener) { const i = listeners.indexOf(listener); if (i !== -1) listeners.splice(i, 1); },
  };
  const host = new DesktopWebSecureIframeHost(context);
  return { host, context, body, boxes, frames, target, timers, listeners, documentListeners,
    receive(data: unknown, origin = 'https://store.example', source: DesktopStorageFrameEvent['source'] = target) { [...listeners].forEach(listener => listener({ data, origin, source })); },
    fire(delay: number) { const pair = [...timers].find(([, timer]) => timer.delay === delay)!; timers.delete(pair[0]); pair[1].callback(); },
  };
}
const url = 'https://store.example/frame';

it('waits for DOM before starting timers, then requires initial ACK and a separate flight', async () => {
  const f = fixture(); f.context.document.body = null; f.context.document.readyState = 'loading';
  let done = false; const pending = f.host.createConnection().createIframeElement(url).then(frame => { done = true; return frame; }); await flush();
  expect(f.timers.size).toBe(0); expect(f.frames[0]?.parentNode).toBeNull();
  f.context.document.body = f.body; f.documentListeners['DOMContentLoaded']![0]!(); await flush();
  expect(f.frames[0]?.style.display).toBe('none'); expect([...f.timers.values()].map(timer => timer.delay)).toEqual([120000]);
  f.receive('ACK', 'https://wrong.example'); await flush(); expect(f.target.postMessage).not.toHaveBeenCalled();
  f.receive('ACK'); await flush(); expect(done).toBe(false); expect(f.target.postMessage).toHaveBeenCalledWith('ACK_0_0.5', 'https://store.example');
  f.receive('ACK_1_ACK_0_0.5'); const frame = await pending; expect(frame.isValid()).toBe(true);
  expect(f.timers.size).toBe(0); expect(f.listeners).toHaveLength(0);
});

it('onload alone fails after the ACK timeout and leaves the native main timer/listener', async () => {
  const f = fixture(), pending = f.host.createConnection().createIframeElement(url);
  const failure = expect(pending).rejects.toMatchObject({ name: 'CreateIframeError', message: '{"startTime":10,"endTime":11,"loadTime":1,"visibility":"visible","current":0,"max":10}' });
  await flush(); f.frames[0]!.onload!(); f.fire(2000); await failure;
  expect(f.frames[0]?.parentNode).toBeNull(); expect(f.listeners).toHaveLength(1); expect([...f.timers.values()].map(timer => timer.delay)).toEqual([120000]);
});

it('rejects the 120s main timeout and ignores a later initial ACK without removing its listener', async () => {
  const f = fixture(), pending = f.host.createConnection().createIframeElement(url), failure = expect(pending).rejects.toHaveProperty('name', 'CreateIframeMainTimeout');
  await flush(); f.fire(120000); await failure; f.receive('ACK'); await flush();
  expect(f.listeners).toHaveLength(1); expect(f.target.postMessage).not.toHaveBeenCalled();
});

it('uses saved ACK source only if iframe.contentWindow is absent', async () => {
  const f = fixture(), pending = f.host.createConnection().createIframeElement(url); await flush();
  f.frames[0]!.contentWindow = null; const source = { postMessage: jest.fn() };
  f.receive('ACK', 'https://store.example', source); await flush(); expect(source.postMessage).toHaveBeenCalledWith('ACK_0_0.5', 'https://store.example');
  f.receive('ACK_1_ACK_0_0.5'); const frame = await pending; frame.postMessage('synthetic'); expect(source.postMessage).toHaveBeenLastCalledWith('synthetic', '*');
});

it('flight accepts only matching data, without adding nonexistent origin/source checks', async () => {
  const f = fixture(), pending = f.host.createConnection().createPostMessageFlight(() => undefined);
  f.receive('ACK_1_wrong', 'https://unrelated.invalid', null); expect(f.listeners).toHaveLength(1);
  f.receive('ACK_1_ACK_0_0.5', 'https://unrelated.invalid', null); await expect(pending).resolves.toBeUndefined();
});

it('synchronous flight ACK is accepted before its subsequently created timer exists', async () => {
  const f = fixture(); await f.host.createConnection().createPostMessageFlight(token => { f.receive(`ACK_1_${token}`); });
  expect(f.listeners).toHaveLength(0); expect([...f.timers.values()].map(timer => timer.delay)).toEqual([3000]);
});

it('flight timeout rejects and retains its listener until a late matching ACK', async () => {
  const f = fixture(), pending = f.host.createConnection().createPostMessageFlight(() => undefined), failure = expect(pending).rejects.toHaveProperty('name', 'PostMessageTimeout');
  f.fire(3000); await failure; expect(f.listeners).toHaveLength(1);
  f.receive('ACK_1_ACK_0_0.5'); expect(f.listeners).toHaveLength(0);
});

it('shares the synchronous post error budget: the third error can still return a frame', async () => {
  const f = fixture(); f.target.postMessage.mockImplementation(() => { throw Error('synthetic closed window'); });
  for (let i = 0; i < 3; i++) {
    const pending = f.host.createConnection().createIframeElement(url);
    const observed = i < 2 ? expect(pending).rejects.toHaveProperty('name', 'PostMessageWindowError') : expect(pending).resolves.toHaveProperty('isValid');
    await flush(); f.receive('ACK'); await observed;
  }
  expect(f.host.flightErrors).toEqual({ current: 2, max: 2 });
});

it('does not swallow flight timeout even after the shared window error budget is exhausted', async () => {
  const f = fixture(); f.host.flightErrors.current = 2;
  const pending = f.host.createConnection().createIframeElement(url), failure = expect(pending).rejects.toHaveProperty('name', 'PostMessageTimeout');
  await flush(); f.receive('ACK'); await flush(); f.fire(3000); await failure;
});

it('reuses one hidden container and destroys only the selected frame', async () => {
  const f = fixture(), a = f.host.createConnection().createIframeElement(url), b = f.host.createConnection().createIframeElement(url);
  await flush(); expect(f.boxes.size).toBe(1); f.receive('ACK'); await flush(); f.receive('ACK_1_ACK_0_0.5');
  const [first, second] = await Promise.all([a, b]); first.destory(); expect(first.isValid()).toBe(false); expect(second.isValid()).toBe(true); expect(f.boxes.size).toBe(1);
});

it('keeps settled start promises, and reset raises limits without clearing current or destroying a frame', async () => {
  const f = fixture(), connection = f.host.createConnection({ url });
  const frame: DesktopStorageConnectedFrame = { startTime: 1, endTime: 2, postMessage() {}, destory: jest.fn(), isValid: () => true };
  connection.loadWindow = jest.fn(async () => frame);
  const pending = connection.start(); expect(connection.start()).toBe(pending); await pending; expect(connection.start()).toBe(pending);
  connection.autoLoadIframeConfig.current = 10; f.host.flightErrors.current = 2; connection.reset();
  expect(connection.autoLoadIframeConfig).toEqual({ current: 10, max: 20, iframeLoadPromise: null }); expect(f.host.flightErrors).toEqual({ current: 2, max: 5 });
  expect(frame.destory).not.toHaveBeenCalled();
});

it('setConfig preserves truthy old values but drops debug rather than merging all properties', () => {
  const connection = fixture().host.createConnection({ url, debug: true, ackTimeout: 50 });
  connection.setConfig({ ackTimeout: 0, url: '' }); expect(connection.config).toEqual({ url, ackTimeout: 50 });
});

it('waits indefinitely while hidden at retry limit, then resumes without resetting current', async () => {
  const f = fixture(), connection = f.host.createConnection({ url }); connection.autoLoadIframeConfig.max = 0; f.context.document.visibilityState = 'hidden';
  const frame = { startTime: 1, endTime: 2, postMessage() {}, destory() {}, isValid: () => true };
  connection.createIframeElement = jest.fn().mockRejectedValueOnce(Error('synthetic')).mockResolvedValueOnce(frame);
  const pending = connection.start(); f.fire(0); await flush(); expect(f.timers.size).toBe(0); expect(f.documentListeners['visibilitychange']).toHaveLength(1);
  f.context.document.visibilityState = 'visible'; f.documentListeners['visibilitychange']![0]!(); await flush(); f.fire(0);
  await expect(pending).resolves.toBe(frame); expect(connection.autoLoadIframeConfig.current).toBe(0); expect(f.documentListeners['visibilitychange']).toHaveLength(0);
});

it('rethrows the main error if fallback also fails', async () => {
  const f = fixture(), connection = f.host.createConnection({ url }); connection.autoLoadIframeConfig.max = 0;
  f.context.readLocalStorage = () => '4.0.2'; const first = new Error('main'), second = new Error('fallback');
  connection.createIframeElement = jest.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second);
  const pending = connection.start(), failure = expect(pending).rejects.toBe(first); f.fire(0); await failure;
  expect(connection.createIframeElement).toHaveBeenNthCalledWith(2, 'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.2/dist/page/index.html', 2000);
});

it('captures capability selection once but rereads the fallback version each time', () => {
  const f = fixture(); f.context.navigator.canShare = true;
  expect(f.host.resourceURL('https://synthetic/')).toContain('/page/');
  const updated = new DesktopWebSecureIframeHost(f.context); expect(updated.resourceURL('https://synthetic/')).toContain('/latest/');
  f.context.readLocalStorage = () => '4.0.1'; expect(updated.fallbackURL()).toContain('/4.0.1/');
  f.context.readLocalStorage = () => '4.0.2'; expect(updated.fallbackURL()).toContain('/4.0.2/');
  f.context.readLocalStorage = () => { throw Error('blocked'); }; expect(updated.fallbackURL()).toBeUndefined();
});
