// Offline source oracle; build the SDK first. Reads explicitly supplied source snapshots.
// Executes extracted functions and built transport with fixtures; no native, accounts or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { parse as parseUrl } from 'node:url';
import { ApiConnection } from '../../lib/desktop/api-connection.js';
import { createVerificationRequests } from '../../lib/sdk/auth/verification-request.js';

const [root, secondVerifyPath] = process.argv.slice(2);
assert(root && secondVerifyPath,
  'Usage: node scripts/research/desktop-fetchsec-oracle.mjs <extracted-desktop-directory> <official-second-valid-web.js>');

function readSource(path, expectedHash) {
  const bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash,
    `Source snapshot changed: ${path}`);
  return bytes.toString('utf8');
}

function extract(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `Source function boundary missing: ${startMarker}`);
  return source.slice(start, end);
}

const source = readSource(join(root, 'renderer/955/955_28fe0c6f9275a89ab79d.js'),
  'f91ceceb60de0eb144e5ef60f907efe480e946b8cb0199e5eade4d92a6ce0197');
const dynamicSource = readSource(secondVerifyPath,
  '6816fcb4011904b38331f73643f3cc11d4bb095651ccb0d90978efc21818007b');
const plain = value => JSON.parse(JSON.stringify(value));

// C955 SecondVerify passes this raw concatenation to Al/script.src, rather than
// parsing the address or re-encoding event parameters. These vectors also run
// through the generated SDK page in browser-verification.test.ts.
const scriptExpression = extract(source, 'return (v =', '? [', source.indexOf('(u = $l($l({}, e), h))'))
  .slice('return '.length).trim();
const originalScriptUrl = runInContext(
  `(function(u) { var v, a, c, s; return ${scriptExpression}; })`, createContext({}), { timeout: 1000 });
const scriptCases = [
  ['https://verify.example/script.js', {}, '?aid=339757&verify_reason=&verify_scene='],
  ['https://verify.example/script.js?token=a%20b&aid=old', {}, '?aid=339757&verify_reason=&verify_scene='],
  ['https://verify.example/script.js#fragment', {}, '?aid=339757&verify_reason=&verify_scene='],
  ['https://verify.example/script.js', { verify_reason: 'a b+%&x=1', verify_scene: '扫码/确认' }, '?aid=339757&verify_reason=a b+%&x=1&verify_scene=扫码/确认'],
  ['https://verify.example/script.js', { verify_reason: 0, verify_scene: false }, '?aid=339757&verify_reason=&verify_scene='],
  ['https://verify.example/script.js', { verify_reason: 42, verify_scene: ['a', 'b'] }, '?aid=339757&verify_reason=42&verify_scene=a,b'],
];
for (const [url, event_params, suffix] of scriptCases) {
  assert.equal(originalScriptUrl.call({ initProps: { aid: 339757 } }, { url, event_params }), url + suffix);
}
console.log(`C955 original SecondVerify script address: ${scriptCases.length} page regression vectors passed.`);

let rendered;
let initialized;
const replays = [];
const resultContext = { data: { message: 'success' } };
const wrapper = {
  init: (...args) => { initialized = args; },
  render: options => { rendered = options; },
  getFp: async () => 'verify_source_fixture',
};
const context = createContext({ o: wrapper });
runInContext(
  extract(source, '      function Ye(e)', '      function Ze(e)')
    + extract(source, '      var tl,', '      var pl =')
    + '\nglobalThis.subject = dl;',
  context, { timeout: 1000 },
);
context.subject.init({
  request: { originRequest: async config => { replays.push(config); return resultContext; } },
  commonOptions: { aid: 339757, did: 123, iid: 456 },
});
assert.deepEqual(plain(initialized[0].commonOptions), { aid: 339757, did: '123', iid: '456' });

const originalConfig = {
  url: '/fixture', params: { fp: 'old', x: 1 },
  data: 'type=ENCODED&obj=%7B%22x%22%3A1%7D', header: { a: 'b' },
};
const originalContext = { config: originalConfig, data: { message: 'error' }, status: 200 };

let task = context.subject.show({ responseContext: originalContext, verifyData: '{"code":10000}' });
await rendered.captchaOptions.successCb({ fp: 'IGNORE_CALLBACK_FP' });
assert.equal(await task, resultContext);
assert.equal(replays[0].params.fp, 'verify_source_fixture');
assert.equal(replays[0].data, originalConfig.data);
assert.deepEqual(plain(replays[0].encryptFields), []);

task = context.subject.show({ responseContext: originalContext, verifyData: '{}' });
await rendered.secondVerifyWebOptions.callBack({ status: false, ticket: 'IGNORE_CALLBACK_TICKET' });
assert.equal(await task, resultContext);
assert.equal(replays[1].data, originalConfig.data);
assert.equal(replays[1].params, originalConfig.params);

task = context.subject.show({
  responseContext: originalContext, verifyData: '{}', requestData: { sms_code_key: 'NEW+KEY' },
});
await rendered.secondVerifyWebOptions.callBack('IGNORE_CALLBACK_RESULT');
await task;
assert.equal(replays[2].data, 'type=ENCODED&obj=%7B%22x%22%3A1%7D&sms_code_key=NEW%2BKEY');

task = context.subject.show({ responseContext: originalContext, verifyData: 'malformed' });
const rejection = task.catch(error => error);
assert.deepEqual(plain(rendered.verify_data), {});
rendered.captchaOptions.closeCb();
assert.equal((await rejection).errorHandled, true);
assert.equal((await rejection).config, originalConfig);
assert.equal(replays.length, 3);

// Exercise the original secondary callback and form-header middleware together.
// Transport stays recorded: this does not load official UI or contact Passport.
runInContext('var ht = Object.assign;'
  + extract(source, '      function Xe(e, t, n)', '      function Ye(e)')
  + extract(source, '      function vt(e)', '\n      var ', source.indexOf('      function vt(e)'))
  + ';globalThis.prepareForm = vt;', context, { timeout: 1000 });
let secondaryComparisons = 0;
for (const data of [undefined, null, false, 0, '',
  'flag&empty=&=anonymous&value=a=b',
  'obj=%7B%22a%22%3A1%7D&bad=%7Bbroken%7D&plus=a+b']) {
  for (const smsKey of [undefined, 'fixture+key']) {
    const config = { url: '/fixture', method: 'POST', data, header: {}, needFormData: true };
    const originalTask = context.subject.show({ responseContext: { config }, verifyData: '{}',
      ...(smsKey ? { requestData: { sms_code_key: smsKey } } : {}) });
    await rendered.secondVerifyWebOptions.callBack({ ticket: 'must-not-enter-body' });
    await originalTask;
    const replay = await context.prepareForm(replays.at(-1));
    const outgoing = [];
    const api = createVerificationRequests({ origin: 'https://imdesktop.douyin.com',
      transport: async request => {
        outgoing.push(request);
        return { status: 200, statusText: 'fixture', headers: {}, rawText: JSON.stringify(outgoing.length === 1
          ? { message: 'error', data: { verify_center_secondary_decision_conf: '{}', error_code: 2046, sms_code_key: smsKey } }
          : { message: 'success' }) };
      }, verify: challenge => challenge.retry('secondary') });
    await api.fetchSec(config);
    assert.equal(outgoing.length, 2);
    assert.equal(outgoing[1].body, replay.data || null, 'Secondary callback body must match original');
    assert.deepEqual(outgoing[1].headers, plain(replay.header), 'Secondary form headers must match original');
    secondaryComparisons++;
  }
}
console.log(`C955 original secondary callback and form middleware: ${secondaryComparisons} built SDK comparisons passed.`);

// First business pack uses Ul -> Request.fetch -> lt/pt/vt, not normal Passport.
const packContext = createContext({ document: { cookie: '' }, ql: config => config });
runInContext(extract(source, '      var We =', '      function Qe(e)')
  + extract(source, '      function Xe(e, t, n)', '      var et =')
  + extract(source, '      var ct =', '      var mt =')
  + '\nvar ' + extract(source, 'Ml = function (e, t)', '        ql = function').trim().replace(/,$/, ';')
  + '\nvar ' + extract(source, 'Ul = function (e, t)', '        Dl = function').trim().replace(/,$/, ';')
  + '\nglobalThis.packInput = Ul; globalThis.middleware = [lt, pt, vt];', packContext, { timeout: 1000 });
const csrfCases = ['', 'passport_csrf_token=;', 'passport_csrf_token=primary',
  'passport_csrf_token=; passport_csrf_token_default=fallback',
  'passport_csrf_token=primary; passport_csrf_token_default=fallback',
  'passport_csrf_token=a%2Bb%25c', 'passport_csrf_token=%u0041%ZZ'];
let firstPackComparisons = 0;
const fetchBeforePack = globalThis.fetch;
try {
  for (const cookie of csrfCases) {
    for (const decision of [{ verify_from: 'verify_center', is_login: true },
      { aid: 339757, device_id: 'wrong', code: '\u0001😀1', detail: { key: 'a b' }, is_login: false }]) {
      packContext.document.cookie = cookie;
      let expected = packContext.packInput({ aid: 339757, ...decision,
        device_id: 'did', iid: 'iid', version_code: '1.2.1', device_platform: process.platform },
      { host: 'https://imdesktop.douyin.com' });
      expected = { ...expected, needFormData: true };
      for (const step of packContext.middleware) expected = await step(expected);
      let actual;
      globalThis.fetch = async (url, init) => {
        actual = { url, ...init };
        return Response.json({ message: 'success', data: {} });
      };
      await new ApiConnection({ deviceId: 'did', installId: 'iid', initialCookies: cookie }).packActionVerification(decision);
      assert.equal(actual.url, expected.baseURL + expected.url);
      assert.equal(actual.method, expected.method);
      assert.equal(actual.body, expected.data);
      const headers = new Headers(actual.headers);
      for (const name of ['Accept', 'Content-Type', 'x-tt-passport-csrf-token']) {
        assert.equal(headers.get(name), expected.header[name] ?? null, `First pack header ${name}`);
      }
      firstPackComparisons++;
    }
  }
} finally { globalThis.fetch = fetchBeforePack; }
console.log(`C955 first business pack versus built HTTP request: ${firstPackComparisons} comparisons passed.`);

const responseMarker = 'responseMiddleware: [\n            at,\n            function (e)';
const responseStart = source.indexOf(responseMarker);
assert(responseStart >= 0, 'fetchSec response middleware missing');
const responseFunction = extract(source, 'function (e)', '\n          ],\n        }),\n        Sl',
  responseStart + responseMarker.indexOf('function'));
runInContext(`globalThis.middleware = ${responseFunction.trim().replace(/,$/, '')};`, context,
  { timeout: 1000 });
let shown;
context.subject.show = options => { shown = options; return Promise.resolve('fixture challenge'); };
const clean = { data: { message: 'success' } };
assert.equal(await context.middleware(clean), clean);
await context.middleware({
  data: {
    data: { verify_center_decision_conf: 'nested', error_code: 2046, sms_code_key: 'nested-key' },
    verify_center_decision_conf: 'outer',
  },
});
assert.equal(shown.verifyData, 'nested');
assert.deepEqual(plain(shown.requestData), { sms_code_key: 'nested-key' });
await context.middleware({
  data: { verify_center_secondary_decision_conf: 'secondary', error_code: '2046', sms_code_key: 'key' },
});
assert.equal(shown.requestData, undefined);
await context.middleware({
  data: { verify_center_secondary_decision_conf: 'secondary', error_code: 2046, sms_code_key: '' },
});
assert.equal(shown.requestData, undefined);

const packRequests = [];
let failPack = false;
const packResponse = { verified: 'fixture' };
const dynamicContext = createContext({
  window: { location: { hostname: 'imdesktop.douyin.com' } },
  console: { log() {} },
  A: {
    thunk: name => config => {
      packRequests.push({ name, config });
      return failPack ? Promise.reject('fixture error') : Promise.resolve(packResponse);
    },
  },
});
const dynamicStart = dynamicSource.indexOf('Request.fetchSec');
assert(dynamicStart >= 0, 'Dynamic fetchSec registration missing');
runInContext('var '
  + extract(dynamicSource, 'cn=function(e,t,n,r)', ',dn=function', dynamicStart)
  + ';globalThis.pack=fn;', dynamicContext, { timeout: 1000 });
const success = await dynamicContext.pack({ is_login: true, aid: 339757 });
assert.equal(success[0], null);
assert.equal(success[1], packResponse);
assert.equal(packRequests[0].name, 'Request.fetchSec');
assert.equal(packRequests[0].config.url,
  'https://imdesktop.douyin.com/passport/safe/pack_verify_ways_data/');
assert.equal(packRequests[0].config.data.is_login, undefined);
assert.equal(packRequests[0].config.method, 'POST');
await dynamicContext.pack({ is_login: false, aid: 339757 });
assert.equal(packRequests[1].config.url,
  'https://verify.zijieapi.com/passport/safe/pack_verify_ways_data/');
failPack = true;
const failure = await dynamicContext.pack({});
assert.equal(failure[0], 'fixture error');
assert.equal(failure[1], null);

console.log('Desktop fetchSec source oracle passed (C955 init/show/response continuation + official SV pack).');
console.log('Offline only: fixture UI and transport; no network, native modules or account state.');

// Official direct SecondVerify calls bypass AccountSDK's normal login signer.
// Extract the API object and reqwest wrapper; do not execute UI or token scripts.
const directRequests = [];
const directContext = createContext({ a: Object.assign, _n: () => 'fixture-csrf',
  Nr: () => config => { directRequests.push(config); config.success({ error_code: 0 }); },
});
runInContext('var ' + extract(dynamicSource, 'jn="/passport/web/send_code/"', ',Zn=0', 660000) + ';var '
  + extract(dynamicSource, 'Br=function(e,t,n)', ',Ur=qr', 668000) + ';globalThis.api=new qr({aid:339757});',
  directContext, { timeout: 1000 });
const directCases = [
  ['sendMobileCode', 'send_code'], ['sendVoiceMobileCode', 'send_voice_code'], ['validateMobileCode', 'validate_code'],
  ['sendEmailCode', 'email/send_code'], ['validateEmailCode', 'email/check_code'], ['validateEmailCodeHasSession', 'email/verify'],
  ['accountGenVerifyTicket', '../account/gen_verify_ticket'], ['accountVerify', 'account/verify'],
  ['upsmsGenVerifyTicket', '../upsms/gen_verify_ticket'], ['upsmsVerify', '../upsms/verify'],
  ['getTicket', '../safe/get_auth_ticket'], ['getQrCode', 'get_qrcode'], ['getQrCode', 'get_face_verify_qrcode', true],
  ['validateByQrCode', 'validate_by_qrcode'], ['validateByQrCode', 'validate_by_face_qrcode', true],
  ['getUserInfo', '../account/info/v2'],
];
for (const [method, suffix, face = false] of directCases) {
  await directContext.api[method]({}, face);
  const request = directRequests.at(-1);
  assert.equal(new URL(request.url, 'https://imdesktop.douyin.com').pathname,
    new URL(`${suffix}/`, 'https://imdesktop.douyin.com/passport/web/').pathname);
  assert.equal(request.method, method === 'sendVoiceMobileCode' ? 'post' : 'get');
  assert.equal(request.withCredentials, true);
  assert.deepEqual(plain(request.headers), method === 'sendVoiceMobileCode'
    ? { 'x-tt-passport-csrf-token': 'fixture-csrf' }
    : { 'x-tt-passport-csrf-token': 'fixture-csrf', 'x-use-secondary-verify-sdk': 1 });
}
console.log(`Official SV direct reqwest methods: ${directCases.length} source header/path cases passed; no network.`);

// Main's native hook is shared by all renderer pipelines and does not depend on
// BDTicket being enabled. Compare it to the built SDK's final transport headers.
const main = readSource(join(root, 'index.js'), '5103dc3c67df781c04396b7494207804999f793f8fccf815638a52a4a8e42a45');
const beforeSend = extract(main, 'async (e, n) => {', '),\n            t.webRequest.onHeadersReceived',
  main.indexOf('t.webRequest.onBeforeSendHeaders'));
let headerChecks = 0;
const savedFetch = globalThis.fetch;
try {
  for (const enabled of [false, true]) for (const pipeline of ['raw', 'fetch', 'fetchSec', 'xhr']) {
    const scope = createContext({ URL, ea: () => ({ parse: parseUrl }), u: { service: 'https://imdesktop.douyin.com' },
      $s: enabled, t: { cookies: { get: async () => [] } }, na: new Map(),
      Ks: () => ({ handleRequest: () => ({ headers: {} }) }),
      Uo: { error: (...args) => { throw new Error(`Unexpected original hook failure: ${args.length}`); } }, ta: 'fixture',
    });
    runInContext(`globalThis.hook=${beforeSend};`, scope, { timeout: 1000 });
    const url = 'https://imdesktop.douyin.com/passport/web/validate_code/';
    let original;
    await scope.hook({ url, id: 1, requestHeaders: { referer: 'http://127.0.0.1/fixture' } }, value => { original = value.requestHeaders; });
    assert.equal(original.referer, 'https://imdesktop.douyin.com');
    let actual;
    globalThis.fetch = async (target, init) => {
      if (String(target).includes('/get_client_cert/')) {
        assert.equal(new Headers(init.headers).has('referer'), false, 'plain certificate fetch is outside the renderer hook');
        return Response.json({ message: 'success', data: {} });
      }
      actual = new Headers(init.headers);
      return Response.json({ message: 'success' });
    };
    const connection = new ApiConnection();
    if (enabled) connection.enableTicketGuard(() => undefined);
    await connection.requestVerificationRaw(url, { method: 'GET', headers: { referer: 'http://127.0.0.1/fixture' } }, 'login', pipeline);
    assert.equal(actual.get('referer'), original.referer, `Main hook parity: ${pipeline}, guard=${enabled}`);
    assert.equal(actual.has('x-tt-passport-aid-sign'), false);
    headerChecks++;
  }
} finally { globalThis.fetch = savedFetch; }
console.log(`Main before-send hook versus built verification transport: ${headerChecks} cases passed; no network.`);

const projectionContext = createContext({});
runInContext(extract(source, '      const ot = function (e)', '      var ct =')
  + ';globalThis.project=async value=>ot(await at({data:JSON.stringify(value)}));', projectionContext, { timeout: 1000 });
const packCases = [
  { message: 'success', data: { url: 'https://verify.example/fixture.js' } },
  { message: 'success', data: { error_code: 99, url: 'https://verify.example/fixture.js' } },
  { message: 'success', error_code: 99, url: 'https://verify.example/fixture.js' },
  { message: 'success', data: null, url: 'https://verify.example/fixture.js' },
  { message: 'error', data: { url: 'https://verify.example/fixture.js' } },
  { message: 'error', data: { error_code: 0, url: 'https://verify.example/fixture.js' } },
  { error_code: 0, data: { url: 'https://verify.example/fixture.js' } },
  { data: { url: 'https://verify.example/fixture.js' } },
  { message: true, data: {} }, { message: 'SUCCESS', data: {} },
];
try {
  for (const value of packCases) {
    const sourceResult = await projectionContext.project(value).then(data => ({ accepted: true, data: data.data || data }),
      () => ({ accepted: false }));
    globalThis.fetch = async () => Response.json(value);
    const sdkResult = await new ApiConnection().packActionVerification({ verify_from: 'verify_center' })
      .then(data => ({ accepted: true, data }), () => ({ accepted: false }));
    assert.deepEqual(plain(sdkResult), plain(sourceResult));
  }
} finally { globalThis.fetch = savedFetch; }
console.log(`C955 Passport response projection versus business pack: ${packCases.length} cases passed; no network.`);
