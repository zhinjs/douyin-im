// Original Web TCC / built SDK differential with in-memory storage and fake XHR.
// No network, real browser, account storage or credentials are used.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/desktop-web-secure-tcc-oracle.cjs /path/to/860.js');
const source = readFileSync(resolve(process.argv[2]), 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '8a22bf7595809b30e00a8037471f0f74df0338c798b52b8722224032fe3f2d61');
const code = source.slice(source.indexOf('var To='), source.indexOf('const Po=Ko;'));
const cacheKey = 'ztsdk_tcc_config';
const query = { tccPsm: 'ucenter.fe.ztsdk', zone: 'default', key: 'ztsdk_config' };
const encode = data => JSON.stringify({ data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, JSON.stringify(value)])) });
const decoded = { ztsdk_config: { '339757': [{ aid: 339757, scene: 'login', providerPathList: ['/passport'] }] } };

function fixture(options = {}) {
  let now = 1000;
  const trace = [], requests = [], storage = new Map();
  if ('cache' in options) storage.set(cacheKey, options.cache);
  class Xhr {
    readyState = 0; status = options.status ?? 200; response = options.response ?? encode(decoded);
    onreadystatechange = null;
    constructor() { trace.push(['new']); if (options.failure === 'new') throw Error('new'); requests.push(this); }
    open(...args) { trace.push(['open', ...args, this.onreadystatechange]); if (options.failure === 'open') throw Error('open'); }
    send() { trace.push(['send']); if (options.failure === 'send') throw Error('send'); if (!options.hold) this.finish(); }
    finish() { this.readyState = 4; this.onreadystatechange?.(); }
  }
  const localStorage = {
    getItem(key) { trace.push(['get', key]); if (options.readError) throw Error('get'); return storage.get(key) ?? null; },
    setItem(key, value) { trace.push(['set', key, value]); if (options.writeError) throw Error('set'); storage.set(key, value); },
  };
  const context = { window: { XMLHttpRequest: options.missingXhr ? null : Xhr, localStorage },
    XMLHttpRequest: Xhr, Date: class { getTime() { return now; } } };
  return { context, trace, requests, storage, advance(value) { now = value; } };
}

function track(promise) {
  const state = { kind: 'pending' };
  promise.then(value => Object.assign(state, { kind: 'fulfilled', value }),
    error => Object.assign(state, { kind: 'rejected', message: error.message }));
  return state;
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
async function run(factory, scenario) {
  const options = { ...scenario.options };
  const f = fixture(options), loader = factory(f.context);
  const results = [track(loader.getConfig(query))];
  if (scenario.mode === 'concurrent') {
    results.push(track(loader.getConfig(query)));
    f.requests[1].response = encode({ ztsdk_config: { second: true } });
    f.requests[1].finish(); await flush();
    f.requests[0].finish(); await flush();
    f.storage.clear(); results.push(track(loader.getConfig(query)));
  }
  await flush();
  if (scenario.mode === 'memory') {
    f.advance(30_000_000); results.push(track(loader.getConfig(query))); await flush();
    f.storage.set(cacheKey, JSON.stringify({ value: { ztsdk_config: { newCache: true } }, expire: 40_000_000 }));
    results.push(track(loader.getConfig(query)));
  }
  if (scenario.mode === 'retry') {
    delete options.failure; results.push(track(loader.getConfig(query)));
  }
  if (scenario.mode === 'cross-psm') {
    results.push(track(loader.getConfig({ ...query, tccPsm: 'other.psm', zone: 'other' }))); await flush();
    f.storage.clear(); results.push(track(loader.getConfig({ ...query, tccPsm: 'other.psm', zone: 'other' })));
  }
  await flush();
  return structuredClone({ results, trace: f.trace, storage: [...f.storage] });
}

void (async () => {
  const { DesktopWebSecureTcc } = await import(pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-tcc.js')).href);
  const original = context => {
    const sandbox = vm.createContext(context);
    vm.runInContext('"use strict";' + code + ';globalThis.tcc=Ko;', sandbox);
    return sandbox.tcc;
  };
  const scenarios = [
    { name: 'network', options: {} }, { name: 'memory', mode: 'memory' }, { name: 'cross-psm', mode: 'cross-psm' },
    { name: 'concurrent', mode: 'concurrent', options: { hold: true } },
    ...[999, 1000, '1000', undefined, 'invalid'].map(expire => ({ name: `cache-${expire}`,
      options: { cache: JSON.stringify({ value: decoded, expire }) } })),
    { name: 'invalid-cache', options: { cache: 'bad' } },
    { name: 'storage-errors', options: { readError: true, writeError: true }, mode: 'memory' },
    ...['new', 'open', 'send'].map(failure => ({ name: failure, options: { failure }, mode: 'retry' })),
    { name: 'missing-xhr', options: { missingXhr: true } }, { name: 'non-200', options: { status: 503 } },
    ...['bad', '{}', '{"data":{}}', '{"data":{"ztsdk_config":"bad"}}'].map(response => ({ name: `bad-body-${response}`, options: { response } })),
    ...[null, false, '', 0].map(value => ({ name: `key-fallback-${value}`, options: { response: encode({ ztsdk_config: value, other: true }) } })),
  ];
  for (const scenario of scenarios) {
    const expected = await run(original, scenario);
    const actual = await run(context => new DesktopWebSecureTcc(context), scenario);
    assert.deepEqual(actual, expected, scenario.name);
    console.log('PASS original / SDK TCC', scenario.name);
  }
  console.log(`PASS ${scenarios.length} TCC lifecycle scenarios`);

  // Public, unauthenticated observation: retain exact response bytes (except
  // the fixture file's final LF). Never install this snapshot as SDK defaults.
  const observed = readFileSync(resolve(__dirname, 'fixtures/web-secure-tcc-2026-09-13.json'), 'utf8').trimEnd();
  assert.equal(createHash('sha256').update(observed).digest('hex'),
    '678fd9618a0de31bb39db46d17e670de1d5201f37ebab21008bb4c17215ef131');
  const observedScenario = { options: { response: observed } };
  const originalLoad = await run(original, observedScenario);
  const sdkLoad = await run(context => new DesktopWebSecureTcc(context), observedScenario);
  assert.deepEqual(sdkLoad, originalLoad);
  assert.equal(originalLoad.results[0].kind, 'fulfilled');
  const selected = originalLoad.results[0].value;
  assert.deepEqual(Object.keys(selected), ['2906', '6383']);

  const { DesktopWebSecureConfiguration, classifyDesktopWebSecureRequest } = await import(
    pathToFileURL(resolve(__dirname, '../../lib/anti-bot/desktop-web-secure-config.js')).href);
  const { desktopTicketPolicy, ticketSessionPathMatches } = await import(
    pathToFileURL(resolve(__dirname, '../../lib/desktop/ticket-guard-config.js')).href);
  const page = 'file:///Applications/Test.app/renderer/main/index.html';
  const selectionStart = source.indexOf('(t=r.sent())&&this.aid');
  const selectionEnd = source.indexOf(',[3,4];case 3:', selectionStart);
  assert(selectionStart > 199218 && selectionEnd > selectionStart);
  const sandbox = vm.createContext({ URL, window: { location: { href: page } } });
  vm.runInContext('var ' + source.slice(166675, 167258) + ';var ' + source.slice(168897, 169107)
    + ';var ' + source.slice(170463, 172452) + ';this.classify=so;'
    + 'this.applyRemote=function(r){var t,e=this;return ' + source.slice(selectionStart, selectionEnd) + ';};', sandbox);
  const paths = [
    '/passport/web/get_qrcode/', '/passport/web/check_qrconnect/', '/passport/web/send_code/',
    '/passport/web/send_voice_code/', '/passport/web/sms_login/', '/passport/web/user/login/',
    '/passport/account/info/v2/', '/passport/token/beat/web/', '/aweme/v1/web/commit/follow/user/',
    // Positive controls prove the remote data/classifier were actually consumed.
    '/aweme/v1/web/comment/list/', '/aweme/v1/web/comment/publish/',
  ];
  let observedChecks = 0;
  for (const aid of [339757, 2906, 6383]) {
    sandbox.n = { cryptoSDK: { setConfig() {}, setAid() {} }, secureProxy: { setConfig() {} }, emit() {} };
    vm.runInContext(source.slice(201051, 201411), sandbox);
    const initial = { aid, scene: 'login', certType: 'header' };
    sandbox.n.setConfig(initial);
    sandbox.applyRemote.call(sandbox.n, { sent: () => selected });
    const state = new DesktopWebSecureConfiguration(); state.setConfig(initial); state.applyRemoteConfig(selected);
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.n.config)), state.config);
    for (const path of paths) {
      const request = { url: `https://imdesktop.douyin.com${path}` };
      const expected = sandbox.classify(request, sandbox.n.config, 'pubKey', 'cert');
      const actual = classifyDesktopWebSecureRequest(request, state.config, page, 'pubKey', 'cert');
      assert.deepEqual(Object.fromEntries(Object.entries(expected)), actual);
      assert.equal(actual.needProxy, aid === 2906 && path.endsWith('/comment/publish/')
        || aid === 6383 && path.endsWith('/comment/list/'));
      observedChecks++;
    }
  }
  // Lack of a Web config cannot disable the independent native Session guard.
  const native = desktopTicketPolicy();
  assert.equal(native.enabled, true);
  for (const path of paths.slice(6, 9)) assert.equal(ticketSessionPathMatches(native.session, path), true);
  console.log(`PASS observed public TCC load/selection and ${observedChecks} original / SDK path classifications; native policy remains independent`);
})().catch(error => { console.error(error); process.exitCode = 1; });
