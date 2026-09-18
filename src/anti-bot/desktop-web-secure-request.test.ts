import { webcrypto } from 'node:crypto';
import { DesktopWebSecureRequestPipeline, type DesktopWebSecureRequest, type DesktopWebSecureResponse } from './desktop-web-secure-request.js';
import { DesktopWebSecureKeys, type DesktopWebSecureKeysInfo } from './desktop-web-secure-keys.js';
import { DesktopWebSecureSystemCrypto } from './desktop-web-secure-crypto.js';
import type { DesktopWebSecureMatch } from './desktop-web-secure-config.js';

function fixture() {
  let now = 1000;
  const Clock = class { getTime() { return now; } static now() { return now; } };
  const keys = new DesktopWebSecureKeys({ Date: Clock, crypto: new DesktopWebSecureSystemCrypto(webcrypto.subtle), certificates: { get: async () => ({ cert: '', sn: '' }) } });
  const info: DesktopWebSecureKeysInfo = { crypt: { ec_publicKey: 'public', ec_privateKey: 'private' }, cert: 'pub.point', sign: { ticket: 'ticket', ts_sign: 'ts.2.synthetic' }, b64PubKey: 'point', b64Cert: 'cert64', b64Csr: 'csr64', items: [] };
  const read = jest.spyOn(keys, 'getKeysInfoWithOrigin').mockResolvedValue(info);
  jest.spyOn(keys, 'checkSignData').mockResolvedValue({ match_md5_local: '-99', match_md5_iframe: '1' });
  const sign = jest.spyOn(keys, 'signWithKeysInfo').mockResolvedValue({ result: 'signature', times: { calTime: 1 }, algoType: 'hmac' });
  const asyncWrite = jest.spyOn(keys, 'setSignValueAsync').mockResolvedValue(true), syncWrite = jest.spyOn(keys, 'setSignValue').mockReturnValue(true);
  const repair = jest.spyOn(keys, 'setKeysAndValues').mockImplementation(() => {});
  const pipeline = new DesktopWebSecureRequestPipeline({ Date: Clock, pageHref: 'https://synthetic.invalid' }, keys);
  const events: Array<[string, unknown]> = []; for (const event of ['execute', 'error', 'log']) pipeline.on(event, value => { events.push([event, value]); });
  const match: DesktopWebSecureMatch = { needProxy: true, pathname: '/follow', hostname: 'synthetic.invalid', consumerConfig: { scene: 'web_protect', certType: 'header' } };
  const request: DesktopWebSecureRequest = { url: 'https://synthetic.invalid/follow?q=not-signed', headers: { keep: 'value' }, method: 'POST', body: 'not-signed' };
  return { keys, info, read, sign, asyncWrite, syncWrite, repair, pipeline, events, match, request, advance: (ms: number) => { now += ms; } };
}
afterEach(() => jest.restoreAllMocks());

it('manual entry replaces only sign snapshot, uses explicit path verbatim and does not write a ticket', async () => {
  const f = fixture(), input = { ticket: 'explicit-ticket', ts_sign: 'ts.1.explicit', path: '/follow?literal=query' };
  const output = await f.pipeline.createTicketGuardHeaders({ signData: input });
  expect(f.read).toHaveBeenCalledWith({ certType: 'header', scene: 'web_protect' });
  expect(f.sign).toHaveBeenCalledWith({ sign_data: 'ticket=explicit-ticket&path=/follow?literal=query&timestamp=1', req_content: 'ticket,path,timestamp', timestamp: 1,
    certType: 'header', scene: 'web_protect', keysInfo: { ...f.info, sign: { ticket: input.ticket, ts_sign: input.ts_sign } } });
  expect(f.sign.mock.calls[0]![0]).not.toHaveProperty('isNewCert');
  expect(f.info.sign!.ticket).toBe('ticket'); expect(f.asyncWrite).not.toHaveBeenCalled(); expect(f.syncWrite).not.toHaveBeenCalled();
  expect(output.bdTicketGuardHeaders).toEqual(expect.objectContaining({ 'bd-ticket-guard-web-version': 1, 'bd-ticket-guard-web-sign-type': 1, 'bd-ticket-guard-client-data': 'signature' }));
  expect(output.timeCollect).toEqual({ duration: '0', signTime: 0, getKeysInfoTime: 0, calTime: 1 });
  expect(output.extras).toEqual({ cache: '0', server_data: '1', algoType: 'hmac', path: input.path, isPubKeySign: 'ts.1' });
  expect(f.events).toEqual([]);
});

it.each(['ticket', 'path', 'publicKey', 'all'])('manual entry without %s still reads keys and builds initial headers', async missing => {
  const f = fixture(), cookie = jest.spyOn(f.keys, 'getCookieCryptStatus');
  const input = { ticket: missing === 'ticket' ? '' : 'explicit', path: missing === 'path' ? '' : '/follow' };
  if (missing === 'publicKey') delete f.info.crypt!.ec_publicKey;
  const output = await f.pipeline.createTicketGuardHeaders({ signData: missing === 'all' ? null : input });
  expect(f.read).toHaveBeenCalledTimes(1); expect(cookie).toHaveBeenCalledTimes(1); expect(f.sign).not.toHaveBeenCalled();
  expect(output.bdTicketGuardHeaders).not.toHaveProperty('bd-ticket-guard-client-data');
  expect(output.bdTicketGuardHeaders['bd-ticket-guard-version']).toBe(2);
});

it.each(['keys', 'sign', 'cookie'])('manual %s rejection escapes without automatic-request error conversion', async stage => {
  const f = fixture();
  if (stage === 'keys') f.read.mockRejectedValue(Error('synthetic failure'));
  else if (stage === 'sign') f.sign.mockRejectedValue(Error('synthetic failure'));
  else jest.spyOn(f.keys, 'getCookieCryptStatus').mockImplementation(() => { throw Error('synthetic failure'); });
  await expect(f.pipeline.createTicketGuardHeaders({ signData: { ticket: 'explicit', path: '/follow' } })).rejects.toThrow('synthetic failure');
  expect(f.events).toEqual([]);
});

it.each(['auto-first', 'manual-first'])('shares signatures between manual and automatic entry: %s', async direction => {
  const f = fixture(), manual = () => f.pipeline.createTicketGuardHeaders({ signData: { ticket: 'ticket', ts_sign: 'ts.2.explicit', path: '/follow' } });
  if (direction === 'auto-first') { await f.pipeline.prepare(f.request, f.match); expect((await manual()).extras.cache).toBe('1'); }
  else { await manual(); await f.pipeline.prepare(f.request, f.match); }
  expect(f.sign).toHaveBeenCalledTimes(1);
  f.advance(18e6); expect((await manual()).extras.cache).toBe('0'); expect(f.sign).toHaveBeenCalledTimes(2);
});

it('manual entry does not infer isNewCert=false from legacy certificate and preserves lower timing overrides', async () => {
  const f = fixture(); f.info.cert = 'legacy certificate';
  f.sign.mockResolvedValue({ result: 'signed', algoType: 'ecdsa', times: Object.assign({ calTime: 7 }, { duration: 9, signTime: 11, getKeysInfoTime: 13 }) });
  const output = await f.pipeline.createTicketGuardHeaders({ signData: { ticket: 'ticket', path: '/follow' }, certType: 'cookie' });
  expect(output.bdTicketGuardHeaders).toHaveProperty('bd-ticket-guard-client-cert', 'cert64');
  expect(f.sign.mock.calls[0]![0]).not.toHaveProperty('isNewCert');
  expect(output.timeCollect).toEqual({ calTime: 7, duration: 9, signTime: 11, getKeysInfoTime: 13 });
});

it('classifies then prepares the same request with exact ticket/path/timestamp and guard headers', async () => {
  const f = fixture(), route = f.pipeline.classify(f.request, { web: [{ scene: 'web_protect', consumerPathList: ['/follow'] }] });
  expect(await f.pipeline.prepare(f.request, route)).toBe(f.request);
  expect(f.sign).toHaveBeenCalledWith(expect.objectContaining({ sign_data: 'ticket=ticket&path=/follow&timestamp=1', req_content: 'ticket,path,timestamp', timestamp: 1, isNewCert: true }));
  expect(f.request.headers).toEqual({ keep: 'value', 'bd-ticket-guard-ree-public-key': 'point', 'bd-ticket-guard-web-version': 2, 'bd-ticket-guard-web-sign-type': 1,
    'bd-ticket-guard-version': 2, 'bd-ticket-guard-iteration-version': 1, 'bd-ticket-guard-client-data': 'signature' });
  expect(f.request.extras?.crypt).toBe(f.info.crypt);
});

it.each(['response-only', 'no-proxy', 'no-headers', 'string-headers'])('bypasses %s without reading keys', async mode => {
  const f = fixture(); if (mode === 'response-only') f.match.onlyProxyResp = true;
  if (mode === 'no-proxy') f.match.needProxy = false;
  if (mode === 'no-headers') delete f.request.headers;
  if (mode === 'string-headers') f.request.headers = 'raw';
  expect(await f.pipeline.prepare(f.request, f.match)).toBe(f.request); expect(f.read).not.toHaveBeenCalled();
});

it.each(['pubKey', 'cert'])('provider-only %s initializes headers without signing or deleting existing client-data', async initType => {
  const f = fixture(); f.match.providerConfig = { scene: 'provider' }; delete f.match.consumerConfig; f.match.initType = initType;
  f.request.headers = { 'bd-ticket-guard-client-data': 'pre-existing' };
  await f.pipeline.prepare(f.request, f.match); expect(f.sign).not.toHaveBeenCalled();
  expect(f.request.headers).toEqual(expect.objectContaining({ 'bd-ticket-guard-client-data': 'pre-existing', [initType === 'cert' ? 'bd-ticket-guard-client-cert' : 'bd-ticket-guard-ree-public-key']: initType === 'cert' ? 'cert64' : 'point' }));
});

it.each(['ts.1.a', 'ts.2.a', 'legacy', ''])('selects consumer headers from ts_sign=%s, not a generic algorithm default', async ts => {
  const f = fixture(); f.info.sign!.ts_sign = ts; await f.pipeline.prepare(f.request, f.match);
  if (ts === 'legacy') expect(f.request.headers).toEqual(expect.objectContaining({ 'bd-ticket-guard-client-cert': 'cert64' }));
  else expect(f.request.headers).toEqual(expect.objectContaining({ 'bd-ticket-guard-web-version': ts.startsWith('ts.1') ? 1 : 2 }));
});

it('uses the last matching full-URL rewrite and does not sign body or query as separate fields', async () => {
  const f = fixture(); f.match.consumerConfig!.urlRewriteRules = [['q=', '/first'], ['follow', '/final']]; await f.pipeline.prepare(f.request, f.match);
  expect(f.sign.mock.calls[0]![0].sign_data).toBe('ticket=ticket&path=/final&timestamp=1');
});

it('invalid rewrite reports then passes empty input to the existing ticket fallback', async () => {
  const f = fixture(); f.match.consumerConfig!.urlRewriteRules = [['[', 'bad']]; await f.pipeline.prepare(f.request, f.match);
  expect(f.sign.mock.calls[0]![0]).toEqual(expect.objectContaining({ req_content: '', sign_data: '' }));
  expect(f.events).toContainEqual(['error', expect.objectContaining({ name: 'request process sign data fail' })]);
});

it('reuses path+ticket cache despite key/ts_sign changes, but not for a different ticket', async () => {
  const f = fixture(); await f.pipeline.prepare(f.request, f.match);
  f.info.crypt!.ec_publicKey = 'new-public'; f.info.sign!.ts_sign = 'ts.2.new'; await f.pipeline.prepare(f.request, f.match);
  expect(f.sign).toHaveBeenCalledTimes(1); f.info.sign!.ticket = 'new-ticket'; await f.pipeline.prepare(f.request, f.match); expect(f.sign).toHaveBeenCalledTimes(2);
});

it('cache timeout uses first truthy configuration and expires at equality', async () => {
  const f = fixture(); f.match.consumerConfig!.signTimeout = 10; await f.pipeline.prepare(f.request, f.match);
  f.match.consumerConfig!.signTimeout = 90000; f.advance(9); await f.pipeline.prepare(f.request, f.match); expect(f.sign).toHaveBeenCalledTimes(1);
  f.advance(1); await f.pipeline.prepare(f.request, f.match); expect(f.sign).toHaveBeenCalledTimes(2);
});

it('separate account pipelines do not reuse signatures even with the same path and ticket', async () => {
  const first = fixture(), second = fixture(); await first.pipeline.prepare(first.request, first.match); await second.pipeline.prepare(second.request, second.match);
  expect(first.sign).toHaveBeenCalledTimes(1); expect(second.sign).toHaveBeenCalledTimes(1);
});

it('post-header observer/usage failure returns already-mutated request without raw configuration logs', async () => {
  const f = fixture(); jest.spyOn(f.keys, 'getUsage').mockRejectedValue(Error('synthetic usage failure'));
  expect(await f.pipeline.prepare(f.request, f.match)).toBe(f.request); expect(f.request.headers).toEqual(expect.objectContaining({ 'bd-ticket-guard-client-data': 'signature' }));
  const logs = JSON.stringify(f.events); expect(logs).toContain('[redacted]'); expect(logs).not.toContain('private'); expect(logs).not.toContain('ts.2.synthetic');
});

function responseFixture() {
  const f = fixture(), ticket = { ticket: 'new-ticket', ts_sign: 'ts.2.new', client_cert: 'pub.new' };
  f.match.providerConfig = { scene: 'provider-scene', namespace: 'provider-namespace' };
  const response: DesktopWebSecureResponse = { config: { ...f.request, extras: { certType: 'header', scene: 'consumer-scene' } },
    headers: { 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify(ticket)).toString('base64'), 'bd-ticket-guard-result': '7', 'x-tt-logid': 'synthetic-log-id' },
    reqHeaders: { 'bd-ticket-guard-version': 2 }, status: 200, body: { unchanged: true } };
  return { ...f, response, ticket };
}

it('saves provider-scoped response ticket before reporting rejection, without clearing or retrying', async () => {
  const f = responseFixture(), clear = jest.spyOn(f.keys, 'clearSignData');
  expect(await f.pipeline.complete(f.response, f.match)).toBe(f.response);
  expect(f.asyncWrite).toHaveBeenCalledWith({ sign: f.ticket, scene: 'provider-scene', namespace: 'provider-namespace', logCtx: { url: '/follow', logId: 'synthetic-log-id' } });
  expect(f.syncWrite).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled();
  expect(f.response['body']).toEqual({ unchanged: true });
  expect(f.events).toContainEqual(['log', expect.objectContaining({ content: 'response verify error' })]);
  expect(f.events).toContainEqual(['execute', expect.objectContaining({ action: 'response', op: 'init', status: 'success' })]);
});

it('awaits namespace writes but ignores false results', async () => {
  const f = responseFixture(); let release!: (value: boolean) => void;
  f.asyncWrite.mockReturnValue(new Promise(resolve => { release = resolve; })); let done = false;
  const result = f.pipeline.complete(f.response, f.match).then(() => { done = true; }); await Promise.resolve(); await Promise.resolve();
  expect(done).toBe(false); release(false); await result; expect(done).toBe(true);
});

it('non-namespaced provider uses non-awaited scheduler input and never consumer.scene', async () => {
  const f = responseFixture(); delete f.match.providerConfig!['namespace']; await f.pipeline.complete(f.response, f.match);
  expect(f.syncWrite).toHaveBeenCalledWith(expect.objectContaining({ scene: 'provider-scene' })); expect(f.asyncWrite).not.toHaveBeenCalled();
});

it.each(['missing-scene', 'falsy-ticket', 'mixed-case', 'no-proxy'])('does not write response ticket for %s', async mode => {
  const f = responseFixture();
  if (mode === 'missing-scene') delete f.match.providerConfig;
  if (mode === 'falsy-ticket') f.response.headers!['bd-ticket-guard-server-data'] = Buffer.from('{"ticket":0}').toString('base64');
  if (mode === 'mixed-case') f.response.headers = { 'Bd-Ticket-Guard-Server-Data': f.response.headers!['bd-ticket-guard-server-data'] };
  if (mode === 'no-proxy') f.match.needProxy = false;
  await f.pipeline.complete(f.response, f.match); expect(f.asyncWrite).not.toHaveBeenCalled(); expect(f.syncWrite).not.toHaveBeenCalled();
});

it.each(['bad-json', 'bad-base64', 'write-reject'])('preserves original response after %s and skips later verify logging', async mode => {
  const f = responseFixture(); if (mode === 'write-reject') f.asyncWrite.mockRejectedValue(Error('synthetic write failure'));
  else f.response.headers!['bd-ticket-guard-server-data'] = mode === 'bad-json' ? Buffer.from('{').toString('base64') : '%%%';
  expect(await f.pipeline.complete(f.response, f.match)).toBe(f.response);
  expect(f.events).toContainEqual(['execute', expect.objectContaining({ op: 'init', status: 'fail' })]);
  expect(f.events).not.toContainEqual(['log', expect.objectContaining({ content: 'response verify error' })]);
});

it.each([undefined, '-99', -99, '0', '7'])('Cookie repair only on string -99/missing result (%s)', async result => {
  const f = responseFixture(); f.response.config!.url = 'https://synthetic.invalid/aweme/v1/web/commit/follow/user/';
  f.response.config!.extras = { certType: 'cookie', items: [{ key: 's_sdk_crypt_sdk', value: 'synthetic-key', from: '2', origin: 'synthetic' }, { key: 'empty', value: '' }] };
  if (result === undefined) delete f.response.headers!['bd-ticket-guard-result']; else f.response.headers!['bd-ticket-guard-result'] = result;
  await f.pipeline.complete(f.response, f.match, true);
  if (result === undefined || result === '-99') expect(f.repair).toHaveBeenCalledWith(['s_sdk_crypt_sdk'], ['synthetic-key']);
  else expect(f.repair).not.toHaveBeenCalled();
});

it('needReport=false suppresses only init telemetry, not writes, finish events or rejection logs', async () => {
  const f = responseFixture(); f.match.needReport = false; await f.pipeline.complete(f.response, f.match);
  expect(f.asyncWrite).toHaveBeenCalledTimes(1); expect(f.events).toContainEqual(['execute', expect.objectContaining({ op: 'sign', status: 'finish' })]);
  expect(f.events).not.toContainEqual(['execute', expect.objectContaining({ op: 'init', status: 'success' })]);
  expect(JSON.stringify(f.events)).not.toContain('new-ticket');
});

it('an error observer throwing from catch can reject, instead of falsely promising all errors are swallowed', async () => {
  const f = responseFixture(); f.asyncWrite.mockRejectedValue(Error('write'));
  f.pipeline.on('error', () => { throw Error('observer'); }); await expect(f.pipeline.complete(f.response, f.match)).rejects.toThrow('observer');
});

it('preserves missing-config rejection, distinct from a present config with missing headers', async () => {
  const f = responseFixture();
  await expect(f.pipeline.complete({}, f.match)).rejects.toThrow(TypeError);
  const response = { config: { url: '/follow' } }; expect(await f.pipeline.complete(response, f.match)).toBe(response);
  expect(f.events).toContainEqual(['error', expect.objectContaining({ name: 'response headers is empty' })]);
});
