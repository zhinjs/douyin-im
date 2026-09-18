import { DesktopWebSecureIframeHost, type DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';
import { DesktopWebSecureBridgeHost } from './desktop-web-secure-bridge.js';
import { DesktopWebSecureCrossStorage, type DesktopCrossStorageConfig } from './desktop-web-secure-cross-storage.js';
import { DesktopWebSecureLocalStorage, DesktopWebSecureMemoryArea, createDesktopWebSecureMemoryStorage } from './desktop-web-secure-local-storage.js';

const keys = ['security-sdk/s_sdk_crypt_sdk', 'security-sdk/s_sdk_cert_key', 'security-sdk/s_sdk_sign_data_key/web_protect'];
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(config: DesktopCrossStorageConfig = {}, url = true) {
  let time = 1, id = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const context: DesktopStorageIframeContext = {
    origin: 'https://synthetic.invalid', navigator: { userAgent: 'synthetic' }, window: {}, performance: { now: () => time++ }, Date: { now: () => 100 }, Math: { random: () => 0.5 },
    document: { body: null, readyState: 'complete', visibilityState: 'visible', getElementById: () => null, createElement: () => { throw Error('unexpected DOM'); }, addEventListener() {}, removeEventListener() {} },
    readLocalStorage: () => null, setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; }, clearTimeout(key) { timers.delete(key as number); }, addMessageListener() {}, removeMessageListener() {},
  };
  const host = new DesktopWebSecureIframeHost(context), bridges = new DesktopWebSecureBridgeHost(context);
  const area = new DesktopWebSecureMemoryArea(), raw = createDesktopWebSecureMemoryStorage(area);
  const local = new DesktopWebSecureLocalStorage(raw, createDesktopWebSecureMemoryStorage(new DesktopWebSecureMemoryArea()), createDesktopWebSecureMemoryStorage(new DesktopWebSecureMemoryArea()), context.origin);
  const parent = { postMessage: jest.fn() }, window = { postMessage: jest.fn(), parent }, errors = jest.fn();
  const create = jest.fn(() => local);
  const cross = new DesktopWebSecureCrossStorage(host, bridges, { window, hostname: 'synthetic.invalid', createLocalStorage: create, writeLocalStorage() {}, onBackgroundError: errors }, { protocol: 'SERCURE', disableReportLogger: true, ...config });
  const post = jest.fn(), metrics = jest.fn(), logs = jest.fn(); cross.on('metrics', metrics); cross.on('log', logs);
  if (url) { cross.client.config.url = 'https://store.example/frame'; cross.client.isConnection = true; cross.client.window = Promise.resolve({ target: { postMessage: post, isValid: () => true, destory() {}, startTime: 0, endTime: 0 }, startTime: 0, endTime: 0 }); }
  const respond = (value: unknown, reject = false, index = post.mock.calls.length - 1) => {
    const packet = post.mock.calls[index]![0] as { data: { id: string } };
    cross.client.emit('message', { data: { id: packet.data.id, promiseStatus: reject ? 'reject' : 'resolve', message: value } });
  };
  const value = (data: unknown) => ({ value: data, from: 1, origin: 'https://store.example' });
  return { cross, local, raw, area, create, post, parent, errors, metrics, logs, timers, respond, value,
    fire(delay: number) { const entry = [...timers].find(([, timer]) => timer.delay === delay); expect(entry).toBeDefined(); timers.delete(entry![0]); entry![1].callback(); },
  };
}

it('signed fast read uses all three raw local slots, preserves order and skips remote', async () => {
  const verify = jest.fn(() => true), f = fixture({ verifySignMethod: verify });
  await f.raw.setItemByKeys(keys.map((key, i) => [key, `raw${i}`])); const rawGet = jest.spyOn(f.raw, 'getItemByKeys'), composite = jest.spyOn(f.local, 'getItemByKeys');
  const values = await f.cross.getItemByKeys([keys[2]!, keys[0]!, keys[2]!]);
  expect(rawGet).toHaveBeenCalledWith(keys); expect(verify).toHaveBeenCalledWith(['raw0', 'raw1', 'raw2']);
  expect(values.map(value => [value.value, value.code])).toEqual([['raw2', 304], ['raw0', 304], ['raw2', 304]]);
  expect(composite).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(f.metrics.mock.calls[0]![0].categories.status).toBe('12');
});

it('signed empty request still verifies all slots and can accept missing data', async () => {
  const verify = jest.fn(() => true), f = fixture({ verifySignMethod: verify });
  await expect(f.cross.getItemByKeys([])).resolves.toEqual([]); expect(verify).toHaveBeenCalledWith([undefined, undefined, undefined]);
  await expect(f.cross.getItem(keys[0]!)).resolves.toMatchObject({ value: undefined, code: 304 });
});

it('false verification falls through to remote and ordinary reads launch background local read', async () => {
  const f = fixture({ verifySignMethod: () => false }), get = jest.spyOn(f.local, 'getItemByKeys');
  const pending = f.cross.getItem(keys[0]!); await flush(); f.respond([f.value('remote')]);
  await expect(pending).resolves.toEqual(f.value('remote')); expect(get).toHaveBeenCalledWith([keys[0]]);
});

it('remote missing values get per-slot fallback, but empty/null/false values do not', async () => {
  const f = fixture(), get = jest.spyOn(f.local, 'getItem'); await f.raw.setItem('a', 'local');
  const pending = f.cross.getItemByKeys(['a', 'b', 'c', 'd']); await flush(); f.respond([f.value(undefined), f.value(''), f.value(null), f.value(false)]);
  expect((await pending).map(value => value.value)).toEqual(['local', '', null, false]); expect(get).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledWith('a');
  expect(f.metrics.mock.calls[0]![0].categories.status).toBe('3');
});

it('short remote arrays stay short and local fallback metadata gets code1001 on rejection', async () => {
  const f = fixture(); let pending = f.cross.getItemByKeys(['a', 'b']); await flush(); f.respond([f.value('one')]); expect(await pending).toHaveLength(1);
  pending = f.cross.getItemByKeys(['a']); await flush(); f.respond('Rejected', true); await expect(pending).resolves.toEqual([expect.objectContaining({ code: 1001 })]);
});

it('failed ordinary fallback tries local again', async () => {
  const f = fixture(), get = jest.spyOn(f.local, 'getItemByKeys').mockRejectedValueOnce(Error('first')).mockResolvedValueOnce([{ value: 'second', from: 0, origin: 'local' }]);
  const pending = f.cross.getItem('a'); await flush(); f.respond('Rejected', true);
  await expect(pending).resolves.toMatchObject({ value: 'second' }); expect(get).toHaveBeenCalledTimes(2);
});

it('async false activates delayed local race, and remote work continues after local wins', async () => {
  const f = fixture(); await f.raw.setItem('a', 'local'); const pending = f.cross.getItem('a', { async: false }); await flush();
  expect(f.post).toHaveBeenCalledTimes(1); f.fire(1000); await expect(pending).resolves.toMatchObject({ value: 'local' });
  f.respond([f.value('late')]); await flush(); await expect(pending).resolves.toMatchObject({ value: 'local' });
});

it('remote read win does not cancel scheduled local read', async () => {
  const f = fixture(), get = jest.spyOn(f.local, 'getItemByKeys'); const pending = f.cross.getItem('a', { async: 25 }); await flush(); f.respond([f.value('remote')]);
  await pending; expect(get).not.toHaveBeenCalled(); f.fire(25); await flush(); expect(get).toHaveBeenCalledTimes(1);
});

it('default set waits for local even after successful remote write', async () => {
  const f = fixture(), local = deferred<Array<{ value: unknown; from: number; origin: string }>>(); jest.spyOn(f.local, 'setItemByKeys').mockReturnValue(local.promise);
  const pending = f.cross.setItem('a', 'x'), done = jest.fn(); void pending.then(done); await flush(); f.respond([f.value('remote')]); await flush(); expect(done).not.toHaveBeenCalled();
  local.resolve([{ value: 'local', from: 0, origin: 'local' }]); await expect(pending).resolves.toMatchObject({ value: 'local' }); expect([...f.timers.values()].some(timer => timer.delay === 2500)).toBe(true);
});

it('default set can fulfill with timeout sentinel when local rejects, without remote cancellation', async () => {
  const f = fixture(); jest.spyOn(f.local, 'setItemByKeys').mockRejectedValue(Error('local'));
  const pending = f.cross.setItem('a', 'x'); await flush(); f.fire(2500);
  await expect(pending).resolves.toEqual({ value: 'timeout', from: 'timeout', origin: 'timeout' }); expect(f.metrics).not.toHaveBeenCalled();
  f.respond([f.value('late')]); await flush(); expect(f.metrics).toHaveBeenCalledTimes(1);
});

it('async writes have new-ID outer retry and report metrics only after remote completion', async () => {
  const f = fixture(), pending = f.cross.setItem('a', 'x', { async: null }); await flush();
  expect([...f.timers.values()].map(timer => timer.delay)).toContain(30000); f.fire(1000); await pending; expect(f.metrics).not.toHaveBeenCalled();
  f.respond('FirstError', true); await flush(); expect(f.post).toHaveBeenCalledTimes(2);
  expect(f.post.mock.calls.map(call => call[0].data.id)).toEqual(['0', '1']); f.respond([f.value('retry')]); await flush();
  expect(f.metrics.mock.calls[0]![0].metrics.retryCount).toBe(1);
});

it('two async remote rejections log first error while preserving local race result', async () => {
  const f = fixture(), pending = f.cross.setItem('a', 'x', { async: false }); await flush(); f.fire(1000); await pending;
  f.respond('FirstError', true); await flush(); f.respond('SecondError', true); await flush();
  expect(f.logs).toHaveBeenCalledWith(expect.objectContaining({ name: 'callBridgeSetItemByKeysRetryError', content: expect.stringContaining('FirstError@') }));
  await expect(pending).resolves.toMatchObject({ value: 'x' });
});

it('no URL set retries local failure, and emits no remote metrics', async () => {
  const f = fixture({}, false), set = jest.spyOn(f.local, 'setItemByKeys').mockRejectedValueOnce(Error('first')).mockResolvedValueOnce([{ value: 'second', from: 0, origin: 'local' }]);
  await expect(f.cross.setItem('a', 'x')).resolves.toMatchObject({ value: 'second' }); await flush(); expect(set).toHaveBeenCalledTimes(2); expect(f.metrics).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
});

it('remove waits for remote and has no local fallback retry after failure', async () => {
  const f = fixture(), remove = jest.spyOn(f.local, 'removeItem'), pending = f.cross.removeItem('a'); await flush(); expect(remove).toHaveBeenCalledTimes(1);
  f.respond('Rejected', true); await expect(pending).rejects.toMatchObject({ name: 'Rejected' }); expect(remove).toHaveBeenCalledTimes(1);
});

it('checker waits indefinitely before connection, then uses 3000ms bridge', async () => {
  const f = fixture({}, false), pending = f.cross.startStorageChecker(), done = jest.fn(); void pending.then(done); await flush();
  f.cross.client.emit('connectionFail', Error('failed')); await flush(); expect(done).not.toHaveBeenCalled(); expect(f.timers.size).toBe(0);
  const frame = { postMessage: f.post, isValid: () => true, destory() {}, startTime: 0, endTime: 0 };
  f.cross.client.config.url = 'https://store.example/frame'; f.cross.client.window = Promise.resolve({ target: frame, startTime: 0, endTime: 0 });
  f.cross.client.emit('connection', { target: frame, startTime: 0, endTime: 0 }); await flush(); expect([...f.timers.values()].map(timer => timer.delay)).toContain(3000);
  f.respond('checked'); await expect(pending).resolves.toBe('checked'); expect(f.cross.client.has('connection')).toBe(true);
});

it('setConfig only changes wrapper config and never creates a previously missing sign object', async () => {
  const f = fixture({}, false); await f.cross.setConfig({ url: 'https://new.example', verifySignMethod: () => true });
  expect(f.cross.client.config.url).toBeUndefined(); expect(f.cross.sign).toBeUndefined(); expect(f.create).toHaveBeenCalledTimes(1);
  f.cross.client.isConnection = true; await expect(f.cross.setOriginStorageConfig({})).rejects.toThrow('NoOriginStorageURL');
});

it('existing sign verifier reads current config and config observer failure preserves mutation', async () => {
  const f = fixture({ verifySignMethod: () => true }, false); await f.cross.setConfig({ verifySignMethod: () => false });
  await expect(f.cross.getLocalItemWithSignByKeys(keys)).rejects.toThrow('VerifySignFail');
  f.cross.on('config', () => { throw Error('observer'); }); await expect(f.cross.setConfig({ debug: true })).rejects.toThrow('observer'); expect(f.cross.config.debug).toBe(true);
});

it('checker ignores returned pending callback promise but rejects synchronous throw', async () => {
  const pending = deferred<void>(), f = fixture({ startStorageCheckerCallBack: () => pending.promise }, false);
  await expect(f.cross.startChecker()).resolves.toBeUndefined(); await f.cross.setConfig({ startStorageCheckerCallBack: () => { throw Error('sync'); } }); await expect(f.cross.startChecker()).rejects.toThrow('sync');
});

it('incoming RPC preserves Ie receiver, rejects nonpromise results and silently ignores unknown namespaces', async () => {
  const f = fixture(), source = { postMessage: jest.fn() }, receiver = jest.fn(function(this: unknown) { return Promise.resolve(this === f.cross); });
  Object.assign(f.cross.logger, { receiver, nonpromise: () => 1 });
  const receive = (callObj: string, callName: string) => f.cross.client.emit('message', { data: { id: 'p', message: { callObj, callName, callArgs: [] } }, type: 'function', origin: 'https://store.example', sourceWindow: source } as never);
  receive('logger', 'receiver'); await flush(); expect(source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ data: { id: 'p', promiseStatus: 'resolve', message: true } }), 'https://store.example');
  receive('logger', 'nonpromise'); await flush(); expect(source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ data: { id: 'p', promiseStatus: 'reject', message: 'UnknowMessageError' } }), 'https://store.example');
  receive('unknown', 'receiver'); await flush(); expect(source.postMessage).toHaveBeenCalledTimes(2);
});

it('remote event errors default origin and forwarded local/socket errors mutate source names', () => {
  const f = fixture(), errors = jest.fn(); f.cross.on('error', errors);
  f.cross.client.emit('message', { type: 'event', data: { message: { eventName: 'error', eventData: { name: 'Remote', message: 'bad' } } } } as never);
  expect(errors).toHaveBeenLastCalledWith(expect.objectContaining({ origin: 'https://synthetic.invalid', name: 'Remote' }));
  const error = Error('bad'); f.local.emit('error', error); expect(error.name).toBe('WebStorage:Error'); f.cross.client.emit('error', error); expect(error.name).toBe('Socket:WebStorage:Error');
});

it('metrics observer cannot reject an otherwise successful read and logger false suppresses it', async () => {
  const f = fixture({}, false); f.cross.on('metrics', () => { throw Error('observer'); }); await expect(f.cross.getItem('a')).resolves.toMatchObject({ value: undefined });
  f.metrics.mockClear(); await f.cross.getItem('a', { logger: false }); expect(f.metrics).not.toHaveBeenCalled();
});

it('null options use the ordinary policy, not async null mode', async () => {
  const f = fixture(), pending = f.cross.setItem('a', 'x', null); await flush();
  expect([...f.timers.values()].map(timer => timer.delay)).toEqual(expect.arrayContaining([2500, 8000]));
  expect([...f.timers.values()].map(timer => timer.delay)).not.toContain(1000); f.respond([f.value('remote')]); await pending;
  const read = f.cross.getItem('a', null); await flush(); f.respond([f.value('remote')]); await expect(read).resolves.toMatchObject({ value: 'remote' });
});
