import { DesktopWebSecureStore, type DesktopWebSecureStoreConfig } from './desktop-web-secure-store.js';
import { DesktopWebSecureIframeHost, type DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';
import { DesktopWebSecureBridgeHost } from './desktop-web-secure-bridge.js';
import { DesktopWebSecureLocalStorage, DesktopWebSecureMemoryArea, createDesktopWebSecureMemoryStorage } from './desktop-web-secure-local-storage.js';
import { createDesktopWebSecureCookieDigest } from './desktop-web-secure-cookie.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(config: DesktopWebSecureStoreConfig = { disableCrossStorage: true }, hostname = '') {
  let id = 0, clock = 100, cookie = '';
  const timers = new Map<number, () => void>(), area = new DesktopWebSecureMemoryArea(), locals: DesktopWebSecureLocalStorage[] = [];
  const create = jest.fn(() => { const raw = createDesktopWebSecureMemoryStorage(area); const store = new DesktopWebSecureLocalStorage(raw, raw, raw, 'https://synthetic.invalid'); locals.push(store); return store; });
  const context: DesktopStorageIframeContext = {
    origin: 'https://synthetic.invalid', navigator: { userAgent: 'synthetic' }, window: {}, performance: { now: () => clock++ }, Date: { now: () => clock++ }, Math: { random: () => 0.5 },
    document: { body: null, readyState: 'complete', visibilityState: 'visible', getElementById: () => null, createElement: () => { throw Error('unexpected DOM'); }, addEventListener() {}, removeEventListener() {} },
    readLocalStorage: () => null, setTimeout(callback) { timers.set(++id, callback); return id; }, clearTimeout(key) { timers.delete(key as number); }, addMessageListener() {}, removeMessageListener() {},
  };
  const host = new DesktopWebSecureIframeHost(context), bridges = new DesktopWebSecureBridgeHost(context);
  const parent = { postMessage: jest.fn() }, query = jest.fn((): Array<{ src?: string }> => []);
  const store = new DesktopWebSecureStore(host, bridges, { window: { postMessage: jest.fn(), parent }, hostname, createLocalStorage: create,
    writeLocalStorage() {}, readCookie: () => cookie, queryIframes: query }, config);
  const execute = jest.fn(); store.on('execute', execute);
  return { store, locals, area, create, query, execute, context, timers, parent, setCookie(value: string) { cookie = value; } };
}

it('local-only constructs no cross storage or implicit readiness promise', async () => {
  const f = fixture(); expect(f.create).toHaveBeenCalledTimes(1); expect(f.store.storage).toBeUndefined(); expect(f.store.loadIframePromise).toBeUndefined();
  expect(f.store.getStorageStatus()).toBeUndefined(); expect(f.store.getIframeStatus()).toBeUndefined(); await expect(f.store.initLoadIframePromise()).resolves.toBeUndefined();
  expect(f.timers.size).toBe(0);
});

it.each([
  ['', undefined, false, 'lf-ucenter-web.yhgfb-cn-static.com'],
  ['www.douyin.com', undefined, false, 'lf-zt.douyin.com'],
  ['notdouyin.com.invalid', undefined, false, 'lf-zt.douyin.com'],
  ['www.douyin.com', 1, false, 'lf-ucenter-web.yhgfb-cn-static.com'],
  ['', 1, true, 'lf-zt.douyin.com'],
])('selects source URL for hostname=%s agid=%s zt=%s', (hostname, agid, ztIframe, domain) => {
  const f = fixture({ agid, ztIframe }, hostname as string);
  expect(f.store.storage!.client.config.url).toContain(domain); expect(f.store.storage!.client.config.url).toContain('/4.0.3/dist/page/index.html');
  expect(f.store.storage!.client.config.protocol).toBe('SERCURE'); expect(f.locals).toHaveLength(2); expect(f.locals[0]).not.toBe(f.locals[1]);
});

it('explicit URL wins but fallback stays wrapper config, not socket option', () => {
  const f = fixture({ url: 'https://custom.example/frame', fallbackCacheOriginURL: 'https://fallback.example' });
  expect(f.store.storage!.client.config.url).toBe('https://custom.example/frame'); expect(f.store.storage!.config.fallback).toBe('https://fallback.example'); expect(f.store.storage!.client.config.enableFallback).toBeUndefined();
});

it('namespace is not normalized, stays live on the original config object and local calls use Ie.storage', async () => {
  const config = { namespace: 'tenant/' }, f = fixture(config), first = jest.spyOn(f.locals[0]!, 'getItem'), second = jest.spyOn(f.locals[1]!, 'getItem');
  await f.store.setLocalItem('a', 'x'); await expect(f.store.getLocalItem('a')).resolves.toBe('x');
  expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledWith('security-sdk/tenant//a'); config.namespace = 'other'; expect(f.store._createStorageKey('a')).toBe('security-sdk/other/a');
});

it('single reads fold falsy but batch reads preserve all values and duplicate key overwrites', async () => {
  const f = fixture(); await f.store.setLocalItem('a', false); await f.store.setLocalItem('b', 0);
  await expect(f.store.getItem('a')).resolves.toBe(''); await expect(f.store.getLocalItem('b')).resolves.toBe('');
  await expect(f.store.getItemWithKeys(['a', 'b', 'c'])).resolves.toEqual({ a: false, b: 0, c: undefined });
  jest.spyOn(f.locals[0]!, 'getItemByKeys').mockResolvedValue([{ value: 1, from: 0, origin: '' }, { value: 2, from: 0, origin: '' }]);
  await expect(f.store.getItemWithKeys(['a', 'a'])).resolves.toEqual({ a: 2 });
});

it('origin projection distinguishes invalid array sentinels from valid empty metadata', async () => {
  const f = fixture(), get = jest.spyOn(f.locals[0]!, 'getItemByKeys'); get.mockResolvedValueOnce([]);
  await expect(f.store.getItemsWithOrigin(['a'])).resolves.toEqual({ data: { a: { key: 'a', value: '', from: '-98', origin: '-2' } } });
  get.mockResolvedValueOnce([{ value: undefined, from: 0, origin: '' }]);
  await expect(f.store.getItemsWithOrigin(['a'])).resolves.toEqual({ data: { a: { key: 'a', value: undefined, from: '0', origin: '-1' } }, from: '1' });
  await expect(f.store.getItemsWithOrigin([])).resolves.toEqual({ data: {}, from: '1' });
});

it('origin cross statistics are substring based, not a trust check', async () => {
  const f = fixture(); jest.spyOn(f.locals[0]!, 'getItemByKeys').mockResolvedValue([{ value: 1, from: 2, origin: 'https://lf-zt.douyin.com.untrusted.invalid' }]);
  await expect(f.store.getItemsWithOrigin(['a'])).resolves.toMatchObject({ from: '1' });
});

it('bulk write enforces lengths before I/O and ignores third argument in favor of async3000', async () => {
  const f = fixture({}), set = jest.spyOn(f.store.storage!, 'setItemByKeys').mockResolvedValue([]);
  await expect(f.store.setItemWithKeys(['a'], [])).rejects.toThrow('set item with Keys need equal length'); expect(set).not.toHaveBeenCalled();
  await expect(f.store.setItemWithKeys([], [], true)).resolves.toEqual({ cross: '1' }); expect(set).toHaveBeenCalledWith([], { async: 3000 });
});

it('single write switches between default and async policy without conflating return cross', async () => {
  const f = fixture({}), set = jest.spyOn(f.store.storage!, 'setItem').mockResolvedValue({ value: 'x', from: 1, origin: 'https://lf-zt.douyin.com' });
  await expect(f.store.setItem('a', 'x')).resolves.toEqual({ cross: '1' }); expect(set).toHaveBeenLastCalledWith('security-sdk/a', 'x', { async: true });
  await f.store.setItem('a', 'x', true); expect(set).toHaveBeenLastCalledWith('security-sdk/a', 'x');
});

it('local execution observers can reject operations, ordinary reads do not emit execute', async () => {
  const f = fixture(); await f.store.getItem('a'); expect(f.execute).not.toHaveBeenCalled();
  f.store.on('execute', () => { throw Error('observer'); }); await expect(f.store.setLocalItem('a', 'x')).rejects.toThrow('observer');
  await expect(f.store.getItem('a')).resolves.toBe('x');
});

it('readiness waits for future connection only and historical status survives failure', async () => {
  const f = fixture({}), done = jest.fn(); void f.store.loadIframePromise!.then(done); f.store.storage!.client.emit('connectionFail', Error('fail')); await flush(); expect(done).not.toHaveBeenCalled();
  const connection = { target: { startTime: 0, endTime: 0, isValid: () => true, destory() {}, postMessage() {} }, startTime: 0, endTime: 1 };
  f.store.storage!.client.emit('connection', connection); await f.store.loadIframePromise; expect(f.store.getIframeStatus()).toBe(true);
  f.store.storage!.client.emit('connectionFail', Error('later')); expect(f.store.getIframeStatus()).toBe(true); expect(f.store.getStorageStatus()!.isConnection).toBe(0);
  const late = jest.fn(); void f.store.initLoadIframePromise().then(late); await flush(); expect(late).not.toHaveBeenCalled();
});

it('iframe scans emit per match once unless forced, without setting readiness', () => {
  const f = fixture({}); f.query.mockReturnValue([{ src: 'https://lf-zt.douyin.com/a' }, { src: 'https://lf-zt.douyin.com/b' }]);
  f.store.checkIframeStatus(); f.store.checkIframeStatus(); expect(f.execute).toHaveBeenCalledTimes(2); expect(f.query).toHaveBeenCalledTimes(1);
  f.store.checkIframeStatus(true); expect(f.execute).toHaveBeenCalledTimes(4); expect(f.store.getIframeStatus()).toBe(false);
});

it('Cookie digest connects the real Ie raw-local fast path without accepting altered data', async () => {
  const f = fixture({}), key = '{"ec_publicKey":"synthetic"}', cert = 'cert', server = 'server';
  await f.locals[1]!.localDB.setItemByKeys([['security-sdk/s_sdk_crypt_sdk', key], ['security-sdk/s_sdk_cert_key', cert], ['security-sdk/s_sdk_sign_data_key/web_protect', server]]);
  f.setCookie(`_bd_ticket_crypt_cookie=${createDesktopWebSecureCookieDigest(key, cert, server)}`);
  await expect(f.store.getItem('s_sdk_cert_key')).resolves.toBe(cert); expect(f.store.verifySignMethod([key, cert, server])).toBe(true);
  expect(f.store.verifySignMethod([key, 'changed', server])).toBe(false);
});

it('local-only log/error adaptation and cross metrics preserve source envelopes', () => {
  const local = fixture(), log = jest.fn(), error = jest.fn(); local.store.on('log', log); local.store.on('error', error);
  local.locals[0]!.emit('log', { name: 'QuotaError' }); expect(log).toHaveBeenCalledWith({ content: 'QuotaError', extra: { content: '' }, level: 'info' });
  const failure = Error('bad'); local.locals[0]!.emit('error', failure); expect(error).toHaveBeenCalledWith({ error: failure, name: 'storage error' });
  const sendEvent = jest.fn(), config = { sendEvent }, cross = fixture(config); config.sendEvent = jest.fn(); cross.store.storage!.emit('metrics', { name: 'write', metrics: {}, categories: {} });
  cross.store.storage!.emit('metrics', { name: 7, metrics: 1, categories: 2 }); expect(sendEvent.mock.calls).toEqual([[{ name: 'storage_write', metrics: {}, categories: {} }], [{ name: 'storage_event_without_name', metrics: 1, categories: 2 }]]);
  expect(config.sendEvent).not.toHaveBeenCalled();
});
