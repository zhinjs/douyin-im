// Full original Uo constructor and core lifecycle/event methods vs built SDK. No network/account IO.
const assert = require('node:assert/strict'), vm = require('node:vm');
const { resolve } = require('node:path'), { pathToFileURL } = require('node:url');
const { source, flush } = require('./desktop-web-secure-keys-oracle.cjs');
const raw = 'var ' + source.slice(source.indexOf('Io=function'), source.indexOf(';const jo=Uo')) + ';globalThis.Owner=Uo;';
const compact = value => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error ? { name: item.name, message: item.message } : item));
function Emitter() { this.events = {}; }
Emitter.prototype.on = function(name, listener) { (this.events[name] ||= []).push(listener); };
Emitter.prototype.emit = function(name, value) { (this.events[name] || []).slice().forEach(listener => listener(value)); };
async function scenario(kind, sdk, mode) {
  const calls = [], events = []; let finish, failLogin;
  const login = new Promise((resolve, reject) => { finish = resolve; failLogin = reject; });
  const document = { cookie: mode === 'cookies' ? '_bd_ticket_crypt_doamin=2; bd_sign_version=1; bd_sign_version=2; _bd_ticket_crypt_cookie=secret' : mode === 'bad-cookie' ? 'bd_sign_version=%ZZ' : '', location: { hostname: 'synthetic.invalid' } };
  const telemetry = { setContext: value => calls.push(['context', value]), dot: value => { calls.push(['dot', value]); if (mode === 'dot-throw') throw Error('dot'); },
    log: value => calls.push(['log', value]), throw: value => calls.push(['error', value]), setEventParams: value => calls.push(['params', value]), initTicketGuard: value => calls.push(['init-ticket', value]),
    setWebId: value => calls.push(['webid', value]), setEnv: value => calls.push(['env', value]), initTea: (...args) => calls.push(['tea', args]), initDTrait: value => calls.push(['init-trait', value]) };
  const clock = { now: () => 100 }, navigator = { userAgent: mode === 'webid-electron' ? 'TTElectron' : 'synthetic' };
  let releaseTrait;
  const dtrait = { setWebId: value => calls.push(['trait-webid', value]), start: input => { calls.push(['trait-start', input]); return mode === 'dtrait-reject' ? Promise.reject(Error('trait')) : new Promise(resolve => { releaseTrait = resolve; }); } };
  let releaseTcc;
  const tcc = { getConfig: input => {
    calls.push(['tcc', input]); if (mode === 'tcc-reject') return Promise.reject(Error('tcc'));
    if (mode === 'tcc-pending') return new Promise(resolve => { releaseTcc = resolve; });
    return Promise.resolve(mode === 'tcc-merge' ? { 1128: [{ aid: 3, scene: 'one' }, { aid: 4, scene: 'two' }], 3: [{ scene: 'wrong' }] } : undefined);
  } };
  const performance = { now: () => 10 };
  let owner, window;
  if (kind === 'raw') {
    function Keys() { Emitter.call(this); } Keys.prototype = Object.create(Emitter.prototype);
    function Proxy() { Emitter.call(this); this.login = false; } Proxy.prototype = Object.create(Emitter.prototype);
    window = { navigator };
    const jr = Object.assign(function() { return telemetry; }, { _instance: telemetry });
    const context = vm.createContext({ Error, decodeURIComponent, Date: clock, Promise, Array, Object, dt: Emitter, Lr: Keys, So: Proxy, window, document, performance, ko: '3.3.5',
      jr, Yr: { _instance: dtrait }, Un: dtrait.start, p: telemetry.initDTrait, a: Object.assign, Po: tcc, l: (_name, value) => telemetry.initTicketGuard(value), o: { logWebBdTicketGuardInit: 'ticket' },
      u: { initTea: telemetry.initTea, getTea: () => ({ setEvtParams: telemetry.setEventParams }) } });
    vm.runInContext('var ' + source.slice(source.indexOf('ur=function'), source.indexOf(',lr=function')) + ';' + raw, context);
    owner = new context.Owner();
  } else {
    class Xhr { open() {} send() {} setRequestHeader() {} }
    window = { XMLHttpRequest: Xhr, Request, Headers, fetch: async () => ({ headers: new Headers() }) };
    owner = new sdk.DesktopWebSecureSdk({ document, keys: { Date: clock, crypto: {}, certificates: {}, performance }, browser: { navigator, window },
      transport: { window, XMLHttpRequest: Xhr, Request, Headers, URL, location: { href: 'https://synthetic.invalid/' } }, tcc, telemetry, dtrait });
  }
  for (const name of ['init', 'load', 'execute', 'ready', 'log', 'error']) owner.on(name, event => events.push([name, event]));
  const keys = owner.cryptoSDK, proxy = owner.secureProxy;
  for (const name of ['setType', 'setStorageNamespace', 'setAgidAndHost', 'setDisableCrossStorage', 'setDisableStorageSignData', 'setCrossStorageURL', 'setCrossStorageBackURL', 'setUpdateKeys', 'setContext', 'setEnableCache', 'setEnableEcdh', 'setAid']) keys[name] = (...args) => calls.push(['keys', name, args]);
  keys.setConfig = value => { calls.push(['keys-config', Object.keys(value)]); keys.config = value; };
  keys.isTopBrowser = () => mode === 'modern';
  keys.start = () => { calls.push(['keys-start']); if (mode === 'keys-start-throw') throw Error('keys'); return new Promise(() => {}); };
  keys.refresh = () => { calls.push(['refresh']); return mode === 'refresh-reject' ? Promise.reject(Error('refresh')) : Promise.resolve('source-refresh-result'); };
  proxy.setConfig = value => { calls.push(['proxy-config', Object.keys(value)]); proxy.config = value; };
  proxy.setType = value => calls.push(['proxy-type', value]); proxy.setLogin = value => { proxy.login = value; calls.push(['proxy-login', value]); };
  proxy.setUpdateDataWhenVerifySuccess = value => calls.push(['proxy-update', value]);
  proxy.getBdTicketGuardHeader = value => { calls.push(['manual', value]); return Promise.resolve({ headers: 'synthetic' }); };
  const entry = { aid: 1128, scene: 'web_protect', consumerPathList: ['/follow'] }; owner.setConfig(entry);
  const event = { action: 'keys', op: 'INIT', status: 'success', duration: 5, ctx: { marker: 'synthetic' }, metrics: { count: 3 }, extras: { marker: 'extra' } };
  let result;
  try {
    if (mode.startsWith('tcc') || mode === 'start' || mode === 'keys-start-throw') {
      if (mode === 'tcc-disabled') owner.disableTccConfig(true);
      const task = owner.start(); if (mode === 'tcc-pending') { await flush(); calls.push(['before-tcc', events.length]); releaseTcc({ 1128: [{ aid: 2, scene: 'remote' }] }); } result = await task;
    } else if (mode.startsWith('webid')) { owner.setWebId(mode === 'webid-undefined' ? undefined : 'synthetic', mode === 'webid-custom' ? 9 : 0, { local: true }); owner.setSlardarEnv('local'); calls.push(['owner-webid', owner.webid]); }
    else if (mode.startsWith('dtrait')) {
      owner.setWebId('owner'); if (mode === 'dtrait-listener-throw') owner.on('init', () => { throw Error('listener'); });
      result = owner.startDTrait({ aid: 1, webId: 'caller', consumerPathList: ['/custom'], urlRewriteRules: [['a', 'b']] });
      calls.push(['before-trait', result, events.length]); if (releaseTrait) releaseTrait(undefined); await flush();
    } else if (mode === 'config') { owner.setConfig(entry); owner.setConfig({}); calls.push(['same-map', owner.config === keys.config && keys.config === proxy.config, owner.config.web_protect[0] === entry]); }
    else if (mode === 'setters') {
      owner.setType({ signType: 'cert' }); owner.setNamespace('scope'); owner.setAgidAndHost(3, 'host'); owner.setDisableCrossStorage(true); owner.setDisableStorageSignData(true);
      owner.setCrossStorageURL('frame'); owner.setCrossStorageBackURL('back'); owner.setContext({}); owner.setUpdateKeys(true); owner.setEnableCache(false); owner.setEnableEcdh(false); owner.setUpdateDataWhenVerifySuccess(true);
    } else if (mode.startsWith('refresh')) result = await owner.refresh();
    else if (mode === 'manual') { const fn = owner.getBdTicketGuardHeader; result = await fn({ ticket: 'synthetic', path: '/follow' }); }
    else if (mode === 'cookies' || mode === 'bad-cookie' || mode === 'modern') result = owner.processSignCookie();
    else if (mode === 'send-event') owner.sendEvent({ name: 'metric', metrics: { count: 2 }, categories: { cookieStatus: 'override', loginStatus: 'override' } });
    else {
      if (mode.includes('login')) owner.setLoginStatus(() => login);
      if (mode === 'login-bool-later') owner.setLoginStatus(true);
      if (mode === 'keys-ready' || mode === 'keys-ready-login') keys.emit('ready', event);
      else if (mode === 'keys-load' || mode === 'keys-load-login') keys.emit('load', event);
      else if (mode === 'keys-execute' || mode === 'keys-execute-login') keys.emit('execute', event);
      else if (mode === 'keys-error' || mode === 'proxy-error') (mode === 'keys-error' ? keys : proxy).emit('error', { error: Object.assign(Error('synthetic'), { origin: 'local' }), name: 'failure' });
      else if (mode === 'keys-log') keys.emit('log', { content: 'safe', level: 'info', extra: { marker: 'synthetic' } });
      else proxy.emit('execute', { ...event, ...(mode === 'response-sign' ? { action: 'response', op: 'sign' } : {}) });
      if (mode.includes('login')) { calls.push(['before-login', events.length]); if (mode === 'login-reject') failLogin(Error('login')); else finish(false); await flush(); }
    }
  } catch (error) { result = { error: error.name, message: error.message }; }
  return compact({ calls, events, result, config: owner.config, aid: owner.aid, version: window.$SECURE_VERSION, proxyLogin: proxy.login });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-sdk.js')).href);
  const modes = ['start', 'tcc-merge', 'tcc-reject', 'tcc-disabled', 'tcc-pending', 'keys-start-throw', 'config', 'setters', 'refresh', 'refresh-reject', 'manual', 'cookies', 'bad-cookie', 'modern', 'send-event',
    'keys-ready', 'keys-load', 'keys-execute', 'keys-ready-login', 'keys-load-login', 'keys-execute-login', 'proxy', 'proxy-login', 'login-reject', 'login-bool-later', 'response-sign', 'keys-error', 'proxy-error', 'keys-log', 'dot-throw',
    'webid', 'webid-undefined', 'webid-custom', 'webid-electron', 'dtrait', 'dtrait-reject', 'dtrait-listener-throw'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', sdk, mode), mode);
  console.log(`PASS ${modes.length} raw Uo owner / SDK lifecycle and event traces (synthetic dependencies, no network)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
