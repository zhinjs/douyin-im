// Installed WebInterfaceSDK response handlers with synthetic Axios responses only.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
if (!process.argv[2]) throw new Error('Usage: node scripts/research/desktop-passport-response-oracle.cjs /path/to/92.js');
const source = readFileSync(process.argv[2], 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'),
  'e09879e27fb28e3a53b962a048cc51318295b6f067f1fec6a395bde2be661889', 'Re-audit changed source first');
const tableStart = source.indexOf('Ol={web:{respHandler:');
const tableEnd = source.indexOf(',El=function', tableStart);
assert(tableStart >= 0 && tableEnd > tableStart);
function extract(marker) {
  const start = source.indexOf(marker);
  const end = source.indexOf('}(e,t)', start);
  assert(start >= 0 && end > start);
  return source.slice(start, end + 1);
}
const fulfilled = extract('function(t,e){var n,r,o,a,c,s,u,l,f=t.config.params.account_sdk_source');
const rejected = extract('function(t,e){var n,r,o,a,c,s,u,l=(null===(n=null==t?void 0:t.config)');
const context = vm.createContext({
  // Native helpers use Object.assign and array spreading for these plain dense fixtures.
  _l: Object.assign, wl: (left, right) => left.concat(right), i: () => undefined,
});
vm.runInContext(`var ${source.slice(tableStart, tableEnd)};globalThis.fulfilled=(${fulfilled});globalThis.rejected=(${rejected});`, context, { timeout: 1000 });
const config = { url: '/passport/token/beat/web/', params: { account_sdk_source: 'web' }, startTime: Date.now() };
async function outcome(body) {
  const response = { data: body, config, headers: { 'x-tt-logid': 'offline-log' }, status: 200 };
  try { return { ok: true, value: await context.fulfilled(response, {}) }; }
  catch (value) { return { ok: false, value }; }
}
(async () => {
  const cases = [
    ['success', { message: 'success', data: { uid: 'fixture' } }, true, undefined],
    ['success with contradictory code', { message: 'success', data: { error_code: 401 } }, true, 401],
    ['success without data', { message: 'success' }, true, undefined],
    ['success null data', { message: 'success', data: null }, true, undefined],
    ['numeric business 401', { message: 'error', data: { error_code: 401 } }, false, 401],
    ['string business 401', { message: 'error', data: { error_code: '401' } }, false, '401'],
    ['outer 401 is diagnostic only', { message: 'error', error_code: 401 }, false, undefined],
    ['zero code is not success', { message: 'error', data: { error_code: 0 } }, false, 0],
    ['case-sensitive message', { message: 'Success', data: {} }, false, undefined],
    ['missing message', { status_code: 0, data: {} }, false, undefined],
    ['string JSON body', '{"message":"success","data":{"uid":"fixture"}}', true, undefined],
    ['malformed JSON body', '{broken', false, undefined],
  ];
  for (const [label, input, ok, code] of cases) {
    const result = await outcome(input);
    assert.equal(result.ok, ok, label);
    assert.equal(result.value.error_code, code, label);
    assert.equal(result.value.log_id, 'offline-log', label);
    console.log('PASS', label);
  }
  const challenge = { error_code: 1105, verify_center_decision_conf: '{"scene":"fixture"}', description: 'verify' };
  const challenged = await outcome({ message: 'error', data: challenge });
  assert.equal(challenged.ok, false);
  for (const [key, value] of Object.entries(challenge)) assert.equal(challenged.value[key], value);
  console.log('PASS business challenge survives normalization');
  const metadata = await outcome({ message: 'success', data: { log_id: 'body-log', respHeader: 'body-header' } });
  assert.equal(metadata.value.log_id, 'offline-log');
  assert.equal(metadata.value.respHeader['x-tt-logid'], 'offline-log');
  console.log('PASS actual response metadata replaces body collisions');
  for (const code of ['ERR_BAD_REQUEST', 'ECONNABORTED']) {
    let error;
    try { await context.rejected({ code, message: 'offline fixture', config,
      response: { status: 401, headers: { 'x-tt-logid': 'http-log' } } }, {}); }
    catch (value) { error = value; }
    assert(error);
    assert.equal(error.error_code, code); assert.equal(error.is_network_error, true);
    assert.equal(error.log_id, 'http-log'); assert.notEqual(error.error_code, 401);
    console.log('PASS transport failure is not numeric Passport 401:', code);
  }
  console.log('16 response assertions passed; no network, UI, or account state accessed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
