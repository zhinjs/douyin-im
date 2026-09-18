// Offline default transport status projection against pinned Desktop source.
// No network, account state or native runtime. Build the SDK first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { parseJsonResponse, DouyinResponseError } from '../../lib/http/response.js';

assert(process.argv[2], 'Pass the extracted Desktop 1.2.1 directory');
const bytes = readFileSync(join(process.argv[2], 'renderer/321/321_32eb617b8bb29d30a181.js'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),
  '5948467b5caf5e7a5d99ae65eff814d6a5c1961e293d763a1c2253a102e97919');
const source = ts.createSourceFile('321.js', bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function unique(predicate) {
  const matches = [];
  function visit(node) { if (predicate(node)) matches.push(node); ts.forEachChild(node, visit); }
  visit(source); assert.equal(matches.length, 1); return matches[0];
}
const defaultValidation = unique(node => ts.isPropertyAssignment(node) && node.name.getText(source) === 'validateStatus'
  && node.initializer.getText(source).includes('t >= 200 && t < 300'));
const validateStatus = runInNewContext(`(${defaultValidation.initializer.getText(source)})`);
const settleModule = unique(node => ts.isPropertyAssignment(node) && node.name.getText(source) === '92420');
// Only the error container is replaced. Execute the original branch/validation,
// not a reconstruction of settle. Error class formatting is outside this oracle.
class FixtureAxiosError extends Error {
  static ERR_BAD_REQUEST = 'ERR_BAD_REQUEST';
  static ERR_BAD_RESPONSE = 'ERR_BAD_RESPONSE';
  constructor(message, code, config, request, response) {
    super(message); Object.assign(this, { code, config, request, response });
  }
}
const module = { exports: undefined };
runInNewContext(`(${settleModule.initializer.getText(source)})(module, {}, loader)`, {
  module, loader: id => { assert.equal(id, 66099); return FixtureAxiosError; },
});
const payloads = [
  { text: '{"message":"success","data":{}}', headers: {} },
  { text: '{"message":"error","data":{"error_code":2046}}', headers: {} },
  { text: '', headers: {} },
  { text: '', headers: { 'x-vc-bdturing-parameters': 'fixture-secret' } },
  { text: '<html>fixture-secret</html>', headers: { 'x-tt-verify-passport-decision': '{"ticket":"fixture-secret"}' } },
  { text: '<script>__ac_nonce="fixture-secret"</script>', headers: {} },
];
let checked = 0;
for (const status of [200, 204, 302, 401, 429, 503]) for (const payload of payloads) {
  const context = { status, config: { validateStatus }, data: payload.text, headers: payload.headers };
  let accepted = false, rejected;
  module.exports(() => { accepted = true; }, error => { rejected = error; }, context);
  let result, error;
  try {
    result = parseJsonResponse({ status, ok: status >= 200 && status < 300,
      headers: new Headers(payload.headers), rawText: payload.text, data: payload.text },
    'https://imdesktop.douyin.com/passport/web/user/login/?token=fixture-secret');
  } catch (failure) { error = failure; }
  if (!accepted) {
    assert.equal(rejected.response, context);
    assert(error instanceof DouyinResponseError); assert.equal(error.kind, 'http');
    assert.equal(error.status, status); assert.equal(String(error).includes('fixture-secret'), false);
  } else {
    assert.equal(rejected, undefined);
    // Transport acceptance does not imply valid JSON or business/login success.
    if (payload.text.startsWith('{')) assert.deepEqual(result, JSON.parse(payload.text));
    else { assert(error instanceof DouyinResponseError); assert.notEqual(error.kind, 'http'); }
  }
  checked++;
}
console.log(`Desktop default HTTP status oracle: ${checked} status/body/header cases passed; no network or account state.`);
