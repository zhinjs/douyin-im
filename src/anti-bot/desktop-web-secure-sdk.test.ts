import { verify, webcrypto } from 'node:crypto';
import { DesktopWebSecureSdk, type DesktopWebSecureSdkContext } from './desktop-web-secure-sdk.js';
import { DesktopWebSecureSystemCrypto } from './desktop-web-secure-crypto.js';
import type { DesktopWebSecureXhr } from './desktop-web-secure-transport.js';
import { DesktopWebSecureLocalStorage, DesktopWebSecureMemoryArea, createDesktopWebSecureMemoryStorage } from './desktop-web-secure-local-storage.js';
import type { DesktopStorageIframeContext } from './desktop-web-secure-iframe.js';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function fixture(configure: (context: DesktopWebSecureSdkContext) => DesktopWebSecureSdkContext = value => value) {
  class Xhr implements DesktopWebSecureXhr {
    secureOpenArgs?: IArguments;
    open(...args: unknown[]) { void args; }
    send(...args: unknown[]) { void args; }
    setRequestHeader(...args: unknown[]) { void args; }
  }
  const originalOpen = Xhr.prototype.open, nativeFetch = jest.fn(async (...args: unknown[]) => { void args; return { headers: new Headers() }; });
  const window = { XMLHttpRequest: Xhr, Request, Headers, fetch: nativeFetch, Promise, $SECURE_VERSION: '' };
  const document = { cookie: '', location: { hostname: 'synthetic.invalid' } };
  const tcc = { getConfig: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(undefined) };
  const telemetry = { setContext: jest.fn(), dot: jest.fn(), log: jest.fn(), throw: jest.fn(), setEventParams: jest.fn(), initTicketGuard: jest.fn(), setWebId: jest.fn(), setEnv: jest.fn(), initTea: jest.fn(), initDTrait: jest.fn() };
  const background = jest.fn();
  const context: DesktopWebSecureSdkContext = { document, browser: { navigator: { userAgent: 'synthetic' }, window }, tcc, telemetry, onBackgroundError: background,
    keys: { Date, crypto: new DesktopWebSecureSystemCrypto(webcrypto.subtle), certificates: { get: async () => ({ cert: '', sn: '' }) }, performance: { now: () => 10 } },
    transport: { window, XMLHttpRequest: Xhr, Request, Headers, URL, location: { href: 'https://synthetic.invalid/' } },
  };
  const sdk = new DesktopWebSecureSdk(configure(context)), start = jest.spyOn(sdk.cryptoSDK, 'start').mockImplementation(() => {});
  const events: [string, unknown][] = []; for (const name of ['init', 'load', 'execute', 'ready', 'log', 'error']) sdk.on(name, event => { events.push([name, event]); });
  return { sdk, context, document, window, Xhr, originalOpen, nativeFetch, start, tcc, telemetry, events, background };
}
afterEach(() => jest.restoreAllMocks());
it('forwards WebId and environment with Desktop analytics defaults without sending analytics', () => {
  const trait = { start: jest.fn(async () => {}), setWebId: jest.fn() }, f = fixture(context => ({ ...context, dtrait: trait }));
  f.context.browser.navigator.userAgent = 'TTElectron synthetic';
  f.sdk.setWebId('synthetic', 0, { local: true });
  expect(f.telemetry.initTea).toHaveBeenCalledWith({ appId: 1661, config: { user_unique_id: 'synthetic', device_id: 'synthetic', user_id: 'synthetic', evtParams: { sdk_version: '3.3.5', self_platform: 'electron' } } }, { local: true });
  expect(trait.setWebId).toHaveBeenCalledWith('synthetic'); expect(f.sdk.webid).toBe('synthetic');
  expect(f.events.at(-1)).toEqual(['load', { action: 'sdk', op: 'setwebid', status: 'success' }]);
  f.sdk.setWebId(); expect(f.sdk.webid).toBeUndefined(); expect(f.telemetry.initTea).toHaveBeenLastCalledWith(expect.objectContaining({ config: expect.objectContaining({ user_id: '' }) }), undefined);
  f.sdk.setSlardarEnv({ local: true }); expect(f.telemetry.setEnv).toHaveBeenCalledWith({ local: true }); expect(f.nativeFetch).not.toHaveBeenCalled();
});

it('does not assign WebId or emit success if earlier telemetry throws', () => {
  const f = fixture(); f.telemetry.initTea.mockImplementation(() => { throw Error('tea'); });
  expect(() => f.sdk.setWebId('synthetic')).toThrow('tea'); expect(f.sdk.webid).toBeUndefined(); expect(f.events).toEqual([]);
});

it('requires an actual DTrait binding instead of claiming successful initialization', () => {
  const f = fixture(); expect(() => f.sdk.startDTrait({})).toThrow('runtime is not bound'); expect(f.events).toEqual([]);
});

it('DTrait overrides caller WebId and appends routes without mutating input, returning before settlement', async () => {
  const pending = gate<unknown>(), trait = { start: jest.fn(() => pending.promise) }, f = fixture(context => ({ ...context, dtrait: trait }));
  f.sdk.setWebId('owner'); f.events.length = 0;
  const input = { aid: 1, webId: 'caller', consumerPathList: ['/custom'], urlRewriteRules: [['a', 'b']] };
  expect(f.sdk.startDTrait(input)).toBe(true); expect(f.events).toEqual([]);
  expect(trait.start).toHaveBeenCalledWith({ aid: 1, webId: 'owner', consumerPathList: ['/custom', '/passport', '/quick_login/v2', '/check_qrconnect', '/account_login/v2', '/one_login'], urlRewriteRules: [['a', 'b'], ['/quick_login/v2', '/passport/sso/quick_login/v2/'], ['/check_qrconnect', '/passport/sso/check_qrconnect/'], ['/account_login/v2', '/passport/sso/account_login/v2/'], ['/one_login', '/passport/sso/one_login/']] });
  expect(input.consumerPathList).toEqual(['/custom']); expect(input.urlRewriteRules).toEqual([['a', 'b']]);
  pending.resolve(undefined); await flush(); expect(f.events).toEqual([['init', { type: 'dtrait' }]]);
  expect(f.telemetry.initDTrait).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
});

it.each(['runtime', 'listener'])('DTrait %s rejection reports failure without authenticated readiness', async mode => {
  const trait = { start: jest.fn(async () => { if (mode === 'runtime') throw Error('trait'); }) }, f = fixture(context => ({ ...context, dtrait: trait }));
  if (mode === 'listener') f.sdk.on('init', () => { throw Error('listener'); });
  expect(f.sdk.startDTrait({})).toBe(true); await flush(); expect(f.telemetry.initDTrait).toHaveBeenCalledWith(expect.objectContaining({ status: 'fail' }));
  expect(f.events.some(([name]) => name === 'ready')).toBe(false); expect(f.background).not.toHaveBeenCalled();
});

const activity = { action: 'keys', op: 'INIT', status: 'success', duration: 5, ctx: { marker: 'synthetic' }, metrics: { count: 3 } };

it('constructs and installs hooks before start without network or a process-global fetch patch', () => {
  const globalFetch = globalThis.fetch, f = fixture();
  expect(f.Xhr.prototype.open).not.toBe(f.originalOpen); expect(f.window.fetch).not.toBe(f.nativeFetch);
  expect(globalThis.fetch).toBe(globalFetch); expect(f.window.$SECURE_VERSION).toBe('3.3.5'); expect(f.start).not.toHaveBeenCalled();
  expect(f.tcc.getConfig).not.toHaveBeenCalled(); expect(f.nativeFetch).not.toHaveBeenCalled();
});

it('shares one mutable configuration map and original entries across keys and proxy', () => {
  const f = fixture(), first = { scene: 'web_protect', aid: 1128, consumerPathList: ['/follow'] };
  f.sdk.setConfig(first); f.sdk.setConfig(first);
  expect(f.sdk.cryptoSDK.config).toBe(f.sdk.config); expect(f.sdk.secureProxy.config).toBe(f.sdk.config);
  expect(f.sdk.config['web_protect']).toEqual([first, first]); expect(f.sdk.config['web_protect']![0]).toBe(first);
  expect(f.sdk.cryptoSDK.aid).toBe(1128); expect(f.start).not.toHaveBeenCalled();
  f.sdk.setConfig({}); expect(f.sdk.aid).toBeUndefined(); expect(f.sdk.cryptoSDK.aid).toBeUndefined(); expect(f.sdk.config['undefined']).toEqual([{}]);
});

it('start launches keys and emits init before TCC, then merges the selected remote array without restarting', async () => {
  const f = fixture(), pending = gate<unknown>(); f.tcc.getConfig.mockReturnValue(pending.promise);
  f.sdk.setConfig({ scene: 'initial', aid: 1128 }); const promise = f.sdk.start(); let done = false; void promise.then(() => { done = true; });
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.events.slice(-2)).toEqual([['init', { type: 'bdTicket' }], ['load', { action: 'sdk', op: 'init', status: 'start' }]]);
  await flush(); expect(done).toBe(false);
  pending.resolve({ 1128: [{ aid: 9, scene: 'one' }, { aid: 8, scene: 'two' }], 9: [{ scene: 'wrong' }] }); await promise;
  expect(f.sdk.config['one']).toHaveLength(1); expect(f.sdk.config['two']).toHaveLength(1); expect(f.sdk.config['wrong']).toBeUndefined();
  expect(f.sdk.aid).toBe(8); expect(f.start).toHaveBeenCalledTimes(1);
});

it('start consults aid at response time, and repeat calls are not deduplicated', async () => {
  const f = fixture(), pending = gate<unknown>(); f.tcc.getConfig.mockReturnValue(pending.promise);
  f.sdk.setConfig({ aid: 1 }); const promise = f.sdk.start(); f.sdk.setConfig({ aid: 2 });
  pending.resolve({ 1: [{ scene: 'wrong' }], 2: [{ aid: 2, scene: 'right' }] }); await promise; await f.sdk.start();
  expect(f.sdk.config['wrong']).toBeUndefined(); expect(f.sdk.config['right']).toHaveLength(2); expect(f.start).toHaveBeenCalledTimes(2);
});

it.each(['disabled', 'rejected'])('start handles TCC %s without claiming readiness', async mode => {
  const f = fixture(); if (mode === 'disabled') f.sdk.disableTccConfig(true); else f.tcc.getConfig.mockRejectedValue(Error('synthetic'));
  await expect(f.sdk.start()).resolves.toBeUndefined(); expect(f.events.some(([name]) => name === 'ready')).toBe(false);
  if (mode === 'disabled') expect(f.tcc.getConfig).not.toHaveBeenCalled(); else expect(f.events.at(-1)).toEqual(['log', { level: 'error', content: 'tcc config merge error', extra: { aid: 0 } }]);
});

it.each(['load', 'execute', 'ready'] as const)('keys %s forwards immediately, delaying only its telemetry for login promise', async name => {
  const f = fixture(), pending = gate<unknown>(); f.sdk.setLoginStatus(() => pending.promise); f.sdk.cryptoSDK.emit(name, activity);
  expect(f.events.at(-1)).toEqual([name === 'ready' ? 'execute' : name, activity]); expect(f.telemetry.dot).not.toHaveBeenCalled();
  pending.resolve(true); await flush(); expect(f.telemetry.dot).toHaveBeenCalledWith(expect.objectContaining({ name: `${name}_keys_init`, metrics: { count: 3, duration: 5 }, categories: expect.objectContaining({ satus: 'success', login: '1' }) }));
  expect(f.sdk.secureProxy.login).toBe(false);
});

it('proxy execute waits for login and differs from immediate mode in cookie extras', async () => {
  const f = fixture(), pending = gate<unknown>(); f.sdk.setLoginStatus(() => pending.promise); f.sdk.pipeline.emit('execute', activity);
  expect(f.events).toEqual([]); pending.resolve(false); await flush();
  expect(f.events.at(-1)).toEqual(['execute', { ...activity, extras: { loginStatus: '0' } }]);
  const immediate = fixture(); immediate.sdk.setLoginStatus(true); immediate.sdk.pipeline.emit('execute', activity);
  expect(immediate.events.at(-1)).toEqual(['execute', { ...activity, extras: expect.objectContaining({ loginStatus: '1', cookieStatus: '0' }) }]);
});

it('boolean login update does not clear an earlier login promise', async () => {
  const f = fixture(), pending = gate<unknown>(); f.sdk.setLoginStatus(() => pending.promise); f.sdk.setLoginStatus(true);
  f.sdk.pipeline.emit('execute', activity); expect(f.events).toEqual([]); expect(f.sdk.secureProxy.login).toBe(true);
  pending.resolve(false); await flush(); expect(f.events.at(-1)?.[1]).toEqual(expect.objectContaining({ extras: { loginStatus: '0' } }));
  expect(f.sdk.secureProxy.login).toBe(true);
});

it('login supplier synchronous throw escapes, but rejection becomes false', async () => {
  const f = fixture(); expect(() => f.sdk.setLoginStatus(() => { throw Error('synthetic'); })).toThrow('synthetic');
  f.sdk.setLoginStatus(() => Promise.reject(Error('synthetic'))); f.sdk.pipeline.emit('execute', activity); await flush();
  expect(f.events.at(-1)?.[1]).toEqual(expect.objectContaining({ extras: { loginStatus: '0' } }));
});

it('response/sign skips telemetry but still forwards, retaining the redaction boundary', () => {
  const f = fixture(); f.sdk.pipeline.emit('execute', { ...activity, action: 'response', op: 'sign', extras: '[redacted]' });
  expect(f.telemetry.dot).not.toHaveBeenCalled(); expect(f.events.at(-1)?.[1]).toEqual(expect.objectContaining({ extras: expect.objectContaining({ redacted: true, loginStatus: '-1' }) }));
});

it('delayed proxy listener errors are swallowed while immediate listener errors escape', async () => {
  const f = fixture(); f.sdk.on('execute', () => { throw Error('observer'); });
  expect(() => f.sdk.pipeline.emit('execute', activity)).toThrow('observer');
  f.sdk.setLoginStatus(async () => true); f.sdk.pipeline.emit('execute', activity); await flush(); expect(f.background).not.toHaveBeenCalled();
});

it('delayed keys telemetry errors are observed without suppressing immediate user events', async () => {
  const f = fixture(); f.sdk.setLoginStatus(async () => true); f.telemetry.dot.mockImplementation(() => { throw Error('telemetry'); });
  f.sdk.cryptoSDK.emit('ready', activity); await flush(); expect(f.events.at(-1)).toEqual(['execute', activity]); expect(f.background).toHaveBeenCalledWith(expect.objectContaining({ message: 'telemetry' }));
});

it('Cookie metadata preserves regex duplicate priority, malformed URI fallback, and modern capabilities', () => {
  const f = fixture(); f.document.cookie = 'bd_sign_version=1; bd_sign_version=2; _bd_ticket_crypt_cookie=synthetic-secret';
  f.context.browser.navigator.canShare = true;
  expect(f.sdk.processSignCookie()).toEqual(expect.objectContaining({ signVersion: '1', cookieCrypt: '1', isTopBrowser: '1' }));
  f.document.cookie = `other=0; ${f.document.cookie}`;
  expect(f.sdk.processSignCookie()['signVersion']).toBe('2');
  expect(JSON.stringify(f.sdk.processSignCookie())).not.toContain('synthetic-secret');
  f.document.cookie = 'bd_sign_version=%ZZ'; expect(f.sdk.processSignCookie()['signVersion']).toBe('0'); expect(f.telemetry.throw).toHaveBeenCalledTimes(1);
});

it('setContext affects keys only while setType updates both; manual entry stays pubKey/header', async () => {
  const f = fixture(); f.sdk.setContext({ initType: 'cert', signType: 'cert' }); expect(f.sdk.secureProxy.signType).toBe('pubKey');
  f.sdk.setType({ signType: 'cert' }); expect(f.sdk.secureProxy.signType).toBe('cert'); expect(f.sdk.cryptoSDK.initType).toBe('pubKey');
  const manual = jest.spyOn(f.sdk.pipeline, 'createTicketGuardHeaders').mockResolvedValue({ bdTicketGuardHeaders: {}, timeCollect: {}, extras: { cache: '0', server_data: '0', algoType: '', path: undefined, isPubKeySign: '' } });
  const input = { ticket: 'explicit', path: '/follow' }; await f.sdk.getBdTicketGuardHeader(input); expect(manual).toHaveBeenCalledWith({ signData: input, signType: 'pubKey', certType: 'header' });
});

it('forwards refresh rejection and does not turn it into login success', async () => {
  const f = fixture(); jest.spyOn(f.sdk.cryptoSDK, 'refresh').mockRejectedValue(Error('delete')); await expect(f.sdk.refresh()).rejects.toThrow('delete'); expect(f.events).toEqual([]);
});

function storedFixture(namespace: string) {
  const area = new DesktopWebSecureMemoryArea(), memory = createDesktopWebSecureMemoryStorage(area);
  const db = new DesktopWebSecureLocalStorage(memory, memory, memory, 'https://synthetic.invalid');
  const f = fixture(context => {
    const io: DesktopStorageIframeContext = { origin: 'https://synthetic.invalid', navigator: context.browser.navigator, window: context.browser.window,
      Date, performance: { now: () => 1 }, Math: { random: () => 0.1 },
      document: { body: null, readyState: 'complete', visibilityState: 'visible', getElementById: () => null,
        createElement: () => { throw Error('unexpected iframe in local-only fixture'); }, addEventListener() {}, removeEventListener() {} },
      readLocalStorage: () => null, setTimeout: () => 0, clearTimeout() {}, addMessageListener() {}, removeMessageListener() {},
    };
    return { ...context, storage: { iframe: io, cache: { Math: io.Math }, store: { hostname: context.document.location.hostname,
      window: { postMessage() {}, parent: { postMessage() {} } }, writeLocalStorage() {}, createLocalStorage: () => db, readCookie: () => context.document.cookie, queryIframes: () => [] } } };
  });
  f.start.mockRestore(); f.sdk.setDisableCrossStorage(true); f.sdk.setEnableCache(false); f.sdk.setEnableEcdh(false); f.sdk.disableTccConfig(true); f.sdk.setNamespace(namespace);
  return { ...f, area, db };
}

it('composes real namespaced Store -> Keys -> provider response -> consumer P256 signature through owned fetch', async () => {
  const f = storedFixture('account-synthetic');
  f.sdk.setConfig({ aid: 1128, scene: 'web_protect', namespace: 'header-scope', providerPathList: ['/login'], consumerPathList: ['/follow'] });
  await f.sdk.start(); expect(await f.sdk.cryptoSDK.checkCryptKeys()).toBe(true); expect(await f.sdk.cryptoSDK.checkSigningKeys()).toBe(true);
  const initial = await f.sdk.cryptoSDK.getKeysInfoWithOrigin({ certType: 'header', scene: 'web_protect' });
  const ticket = { ticket: 'synthetic-ticket', ts_sign: 'ts.2.synthetic', client_cert: `pub.${initial.b64PubKey}` }, sent: Record<string, unknown>[] = [];
  f.nativeFetch.mockImplementation(async (...args) => {
    sent.push({ ...((args[1] as { headers: Record<string, unknown> }).headers) });
    return { headers: new Headers(args[0] === '/login' ? { 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify(ticket)).toString('base64') } : {}) };
  });
  await f.window.fetch('/login', { method: 'POST' }); await f.window.fetch('/follow', { method: 'POST' });
  expect(sent[0]).toHaveProperty('bd-ticket-guard-ree-public-key', initial.b64PubKey); expect(sent[0]).not.toHaveProperty('bd-ticket-guard-client-data');
  const data = JSON.parse(Buffer.from(sent[1]!['bd-ticket-guard-client-data'] as string, 'base64').toString());
  const pair = await f.sdk.cryptoSDK.cryptoSDK!.getKeys();
  expect(verify('sha256', Buffer.from(`ticket=${ticket.ticket}&path=/follow&timestamp=${data.timestamp}`), pair.publicKey as string, Buffer.from(data.req_sign, 'base64'))).toBe(true);
  expect(f.area.keys()).toContain('security-sdk/account-synthetic/s_sdk_sign_data_key/web_protect');
  expect(f.area.keys()).not.toContain('security-sdk/s_sdk_sign_data_key/web_protect');
  f.sdk.setNamespace('later-change'); await f.window.fetch('/follow');
  expect(f.area.keys().some(key => key.includes('later-change'))).toBe(false); expect(f.background).not.toHaveBeenCalled();
});

it('separate owner realms do not share local key pairs or namespaced data', async () => {
  const a = storedFixture('a'), b = storedFixture('b'); await Promise.all([a.sdk.start(), b.sdk.start()]);
  await Promise.all([a.sdk.cryptoSDK.checkCryptKeys(), b.sdk.cryptoSDK.checkCryptKeys()]);
  const [pa, pb] = await Promise.all([a.sdk.cryptoSDK.initPubKey(), b.sdk.cryptoSDK.initPubKey()]); expect(pa).not.toBe(pb);
  expect(a.area.keys().some(key => key.startsWith('security-sdk/b/'))).toBe(false);
  expect(b.area.keys().some(key => key.startsWith('security-sdk/a/'))).toBe(false);
});
