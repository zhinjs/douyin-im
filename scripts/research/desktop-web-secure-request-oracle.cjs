// Compare original uo/lo/ro/cache control flow with the built SDK; no requests are sent.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { source } = require('./desktop-web-secure-keys-oracle.cjs');
const raw = 'var ' + source.slice(source.indexOf('Nn=18e6'), source.indexOf(',qn=function')) + ';' +
  source.slice(source.indexOf('var Zn,'), source.indexOf('var oo=function')) +
  source.slice(source.indexOf('var oo=function'), source.indexOf(',so=function')) + ';var ' +
  source.slice(source.indexOf('uo=function'), source.indexOf(',ho=function')) + ';';
const compact = value => JSON.parse(JSON.stringify(value, (_key, item) => item && Object.prototype.toString.call(item) === '[object Error]' ? { name: item.name } : item));
async function scenario(kind, sdk, mode) {
  let time = 1000, counter = 0;
  const Clock = class { getTime() { return mode === 'clock' ? time++ : time; } static now() { return mode === 'clock' ? time++ : time; } };
  const info = { crypt: { ec_privateKey: 'SYNTHETIC-PRIVATE', ec_publicKey: 'PEM', ec_csr: 'CSR' }, cert: 'pub.point', sign: { ticket: 'ticket', ts_sign: 'ts.2.signature' },
    b64Cert: 'CERT64', b64Csr: 'CSR64', b64PubKey: 'PUB64', dataFrom: '2', getKeysInfoTime: 7, items: [] };
  const calls = [], events = [];
  const keys = {
    initMatch: true,
    async getKeysInfoWithOrigin(input) { calls.push(['keys', input]); if (mode === 'keys-fail') throw Error('keys'); return info; },
    async checkSignData(input) { calls.push(['md5', compact(input)]); return { match_md5_iframe: '1', match_md5_local: '-99' }; },
    getCookieCryptStatus() { calls.push(['cookie']); return true; },
    async signWithKeysInfo(input) { calls.push(['sign', compact(input)]); if (mode === 'sign-fail') throw Error('sign'); return mode === 'sign-null' ? null : { result: mode === 'sign-empty' ? '' : `SIGN-${++counter}`, times: { calTime: 1 }, algoType: mode === 'hmac' ? 'hmac' : 'ecdsa' }; },
    getStorageStatus() { calls.push(['storage']); return { isConnection: true, retryCount: 2, startTime: 3, endTime: 4, loadTime: 5 }; },
    async getUsage() { calls.push(['usage']); if (mode === 'usage-fail') throw Error('usage'); return 'system'; },
    getIframeStatus() { calls.push(['iframe']); return true; },
  };
  const match = { needProxy: true, pathname: '/follow', hostname: 'synthetic.invalid', consumerConfig: { scene: 'web_protect', certType: 'header' } };
  const request = { url: 'https://synthetic.invalid/follow?query=not-signed', method: 'POST', body: 'not-signed', headers: { keep: 'value' }, extras: { discarded: true } };
  if (mode === 'provider' || mode === 'provider-cert') { match.providerConfig = match.consumerConfig; delete match.consumerConfig; if (mode === 'provider-cert') match.initType = 'cert'; }
  if (mode === 'cookie') match.consumerConfig.certType = 'cookie';
  if (mode === 'no-proxy') match.needProxy = false;
  if (mode === 'response-only') match.onlyProxyResp = true;
  if (mode === 'no-report') match.needReport = false;
  if (mode === 'string-headers') request.headers = 'raw';
  if (mode === 'no-headers') delete request.headers;
  if (mode === 'no-ticket') delete info.sign.ticket;
  if (mode === 'no-sign-data') info.sign = {};
  if (mode === 'no-public') delete info.crypt.ec_publicKey;
  if (mode === 'no-url') delete request.url;
  if (mode === 'no-path') delete match.pathname;
  if (mode === 'old-cert') info.cert = 'CERTIFICATE';
  if (mode === 'cert-type') match.signType = 'cert';
  if (mode === 'ts1') info.sign.ts_sign = 'ts.1.signature';
  if (mode === 'ts0') info.sign.ts_sign = 'other';
  if (mode === 'ts-empty') info.sign.ts_sign = '';
  if (mode === 'ts-object') info.sign.ts_sign = {};
  if (mode === 'csr-only') { delete info.b64Cert; match.signType = 'cert'; }
  if (mode === 'rewrite') match.consumerConfig.urlRewriteRules = [['query=', '/first'], ['follow', '/last']];
  if (mode === 'rewrite-invalid') match.consumerConfig.urlRewriteRules = [['[', '/invalid']];
  if (mode === 'version-provider') match.providerConfig = { signVersion: 6 };
  if (mode === 'version-consumer') { match.consumerConfig.signVersion = 3; match.providerConfig = { signVersion: 6 }; }
  if (mode === 'version-zero') match.consumerConfig.signVersion = 0;
  if (mode.startsWith('ttl-')) match.consumerConfig.signTimeout = mode === 'ttl-string' ? '10' : 10;
  if (mode === 'stale-header') { delete info.sign.ticket; request.headers['bd-ticket-guard-client-data'] = 'PREEXISTING'; }
  let prepare;
  if (kind === 'raw') {
    const context = vm.createContext({ Date: Clock, Promise, URL, Array }); vm.runInContext(raw, context);
    prepare = () => context.uo(request, { crypt: mode === 'no-keys' ? undefined : keys }, match, {
      reportLog: event => events.push(['log', event]), reportError: event => events.push(['error', event]), reportEvent: event => events.push(['execute', event]),
    });
  } else {
    const pipeline = new sdk.DesktopWebSecureRequestPipeline({ Date: Clock, pageHref: 'https://synthetic.invalid' }, mode === 'no-keys' ? undefined : keys);
    for (const event of ['log', 'error', 'execute']) pipeline.on(event, value => events.push([event, value]));
    prepare = () => pipeline.prepare(request, match);
  }
  const first = await prepare(), results = [compact(first)]; assert.equal(first, request);
  if (mode.startsWith('cache-') || mode.startsWith('ttl-')) {
    if (mode === 'cache-new-ticket') info.sign.ticket = 'new-ticket';
    if (mode === 'cache-new-key') { info.crypt.ec_publicKey = 'other-key'; info.cert = 'pub.other'; info.sign.ts_sign = 'ts.2.other'; }
    if (mode === 'cache-expire') time += 18e6;
    if (mode.startsWith('ttl-')) { time += mode === 'ttl-before' ? 9 : 10; match.consumerConfig.signTimeout = 9000; }
    results.push(compact(await prepare()));
  }
  for (const [name, event] of events) if (name === 'log' && event.extra) {
    if (event.extra.ts_sign) event.extra.ts_sign = '[redacted]';
    if (event.content === 'process request config fail') event.extra.content = '[redacted]';
  }
  return compact({ results, calls, events });
}
async function main() {
  const sdk = await import(pathToFileURL(resolve('lib/anti-bot/desktop-web-secure-request.js')).href);
  const modes = ['clock', 'consumer', 'provider', 'provider-cert', 'cookie', 'no-proxy', 'response-only', 'no-report', 'no-keys', 'no-headers', 'string-headers',
    'no-ticket', 'no-sign-data', 'no-public', 'no-url', 'no-path', 'old-cert', 'cert-type', 'ts1', 'ts0', 'ts-empty', 'ts-object', 'csr-only', 'hmac',
    'rewrite', 'rewrite-invalid', 'version-provider', 'version-consumer', 'version-zero', 'stale-header', 'keys-fail', 'sign-fail', 'sign-null', 'sign-empty', 'usage-fail',
    'cache-hit', 'cache-new-ticket', 'cache-new-key', 'cache-expire', 'ttl-before', 'ttl-boundary', 'ttl-string'];
  for (const mode of modes) assert.deepStrictEqual(await scenario('sdk', sdk, mode), await scenario('raw', sdk, mode), mode);
  console.log(`PASS ${modes.length} raw uo/lo/ro/Fn/Wn/Jn request traces (synthetic key owner, no network; log credentials redacted)`);
  const responses = ['namespace', 'sync', 'no-scene', 'no-ticket', 'array-ticket', 'bad-json', 'bad-base64', 'mixed-case', 'no-headers', 'string-config', 'no-config',
    'no-proxy', 'no-report', 'write-false', 'write-reject', 'usage-reject', 'cookie-repair', 'cookie-no-update', 'cookie-zero', 'cookie-number', 'cookie-no-result',
    'cookie-empty-items', 'cookie-bad-key', 'cookie-wrong-url', 'header-repair', 'unknown-certType', 'null-extras', 'no-finish'];
  for (const mode of responses) assert.deepStrictEqual(await responseScenario('sdk', sdk, mode), await responseScenario('raw', sdk, mode), mode);
  console.log(`PASS ${responses.length} raw ho/po response ticket/storage traces (synthetic key owner, no network; telemetry extras redacted)`);
}

async function responseScenario(kind, sdk, mode) {
  const calls = [], events = [], Clock = class { getTime() { return 1000; } static now() { return 1000; } };
  const keys = { initMatch: true,
    async getUsage() { calls.push(['usage']); if (mode === 'usage-reject') throw Error('usage'); return 'system'; },
    getStorageStatus() { calls.push(['storage']); return { isConnection: true, retryCount: 2, startTime: 3, endTime: 4, loadTime: 5 }; },
    getIframeStatus() { calls.push(['iframe']); return true; },
    b642str(value) { calls.push(['decode', value]); return new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))); },
    async setSignValueAsync(value) { calls.push(['async-write', value]); if (mode === 'write-reject') throw Error('write'); return mode !== 'write-false'; },
    setSignValue(value) { calls.push(['sync-write', value]); return true; },
    setKeysAndValues(...args) { calls.push(['repair', ...args]); },
  };
  const ticket = { ticket: 'ticket', ts_sign: 'ts.2.synthetic', client_cert: 'pub.point' };
  if (mode === 'no-ticket') ticket.ticket = 0;
  if (mode === 'array-ticket') ticket.ticket = [];
  const response = { config: { url: 'https://synthetic.invalid/aweme/v1/web/commit/follow/user/', headers: {}, extras: { certType: mode.startsWith('cookie-') ? 'cookie' : 'header',
    items: [{ key: 's_sdk_crypt_sdk', value: 'key', from: '2', origin: 'synthetic' }, { key: 'empty', value: '' }], dataFrom: '2', match_md5_iframe: '1', match_md5_local: '-99', lost: '0', is_pubkey_ts_sign: 'ts.2', is_new_cert: '1', isPubKeyInit: '1' } },
    headers: { 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify(ticket)).toString('base64'), 'bd-ticket-guard-result': mode.startsWith('cookie-') || mode === 'header-repair' ? '-99' : '7', 'x-tt-logid': 'log-id' },
    reqHeaders: { 'bd-ticket-guard-version': 2, 'bd-ticket-guard-iteration-version': 1, 'bd-ticket-guard-client-data': 'signature' }, status: 200 };
  const match = { needProxy: true, pathname: '/follow', hostname: 'synthetic.invalid', providerConfig: { scene: 'provider', namespace: 'ns' }, consumerConfig: { scene: 'consumer' } };
  if (mode === 'sync') delete match.providerConfig.namespace;
  if (mode === 'no-scene') delete match.providerConfig.scene;
  if (mode === 'bad-json') response.headers['bd-ticket-guard-server-data'] = Buffer.from('{').toString('base64');
  if (mode === 'bad-base64') response.headers['bd-ticket-guard-server-data'] = '%%%';
  if (mode === 'mixed-case') response.headers = { 'Bd-Ticket-Guard-Server-Data': response.headers['bd-ticket-guard-server-data'] };
  if (mode === 'no-headers') delete response.headers;
  if (mode === 'string-config') response.config.headers = 'raw';
  if (mode === 'no-config') delete response.config;
  if (mode === 'no-proxy') match.needProxy = false;
  if (mode === 'no-report') match.needReport = false;
  if (mode === 'cookie-zero') response.headers['bd-ticket-guard-result'] = '0';
  if (mode === 'cookie-number') response.headers['bd-ticket-guard-result'] = -99;
  if (mode === 'cookie-no-result') delete response.headers['bd-ticket-guard-result'];
  if (mode === 'cookie-empty-items') response.config.extras.items = [];
  if (mode === 'cookie-bad-key') response.config.extras.items = [{ value: 'invalid' }];
  if (mode === 'cookie-wrong-url') response.config.url = '/other';
  if (mode === 'unknown-certType') response.config.extras.certType = 'other';
  if (mode === 'null-extras') response.config.extras = null;
  if (mode === 'no-finish') delete response.reqHeaders['bd-ticket-guard-version'];
  let result, failure;
  try {
  if (kind === 'raw') {
    const context = vm.createContext({ Date: Clock, Promise, URL, Array });
    vm.runInContext(raw + ';var ' + source.slice(source.indexOf('ho=function', 178000), source.indexOf(',vo=function', 182000)) + ';', context);
    result = await context.ho(response, { crypt: keys }, match, mode !== 'cookie-no-update', false, {
      reportLog: event => events.push(['log', event]), reportError: event => events.push(['error', event]), reportEvent: event => events.push(['execute', event]),
    });
  } else {
    const pipeline = new sdk.DesktopWebSecureRequestPipeline({ Date: Clock, pageHref: 'https://synthetic.invalid' }, keys);
    for (const event of ['log', 'error', 'execute']) pipeline.on(event, value => events.push([event, value]));
    result = await pipeline.complete(response, match, mode !== 'cookie-no-update');
  }
  } catch (error) { failure = error; }
  if (!failure) assert.equal(result, response);
  for (const [name, event] of events) {
    if (name === 'execute' && 'extras' in event) event.extras = '[redacted]';
    if (name === 'error' && event.name.startsWith('response headers')) event.error = '[redacted]';
  }
  return compact({ result, failure, calls, events });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
