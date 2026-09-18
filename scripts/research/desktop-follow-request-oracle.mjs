// Execute installed request wrapper, Axios transforms and XHR adapter with a
// recording XHR. Synthetic renderer/device only; no browser, account or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

assert(process.argv[2], 'Pass the extracted Desktop 1.2.1 directory');
const bytes = readFileSync(join(process.argv[2], 'renderer/main/main_4eaa703b51f46c257250.js'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),
  '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
const source = ts.createSourceFile('main.js', bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const modules = new Map(), cache = new Map(), requests = [];
function visit(node) {
  if (ts.isPropertyAssignment(node) && ts.isNumericLiteral(node.name) && ts.isFunctionLike(node.initializer)) {
    const id = Number(node.name.text);
    assert(!modules.has(id), `Duplicate module ${id}`);
    modules.set(id, node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
let reply = { status: 200, text: '{"status_code":0,"follow_status":1}', headers: {} };
class RecordingXHR {
  onloadend = null;
  status = reply.status;
  statusText = 'OK';
  responseText = reply.text;
  responseHeaders = { ...reply.headers };
  headers = {};
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  getAllResponseHeaders() {
    return Object.entries({ 'content-type': 'application/json', ...this.responseHeaders })
      .map(([name, value]) => `${name}: ${value}\r\n`).join('');
  }
  send(body) {
    requests.push({ method: this.method, url: this.url, headers: this.headers, body });
    queueMicrotask(() => this.onloadend());
  }
  abort() { assert.fail('Unexpected XHR abort'); }
}
const realm = createContext({ URL, URLSearchParams, FormData, Blob, setTimeout, clearTimeout,
  XMLHttpRequest: RecordingXHR,
  window: { location: { protocol: 'file:' } },
  navigator: { language: 'zh-CN', platform: 'fixture-platform', appCodeName: 'Mozilla',
    appVersion: 'fixture-version', onLine: true, cookieEnabled: true },
  screen: { width: 1728, height: 1117 },
});
// These are input providers, not request/encoding implementations.
const providers = new Map([
  [48797, { Pv: { aid: 339757, service: 'https://imdesktop.douyin.com' }, hl: '1.2.1', OD: 'PC', Nw: 'fixture-os' }],
  [93189, { A: { instance: () => ({ deviceId: '10002', installId: '10003', guid: 'fixture-guid', channel: '20002' }) } }],
  // The module starts a worker at import, but follow is not in its selected
  // endpoint list. Keep the original matcher and fail if this branch is used.
  [385, { q() { assert.fail('Follow unexpectedly entered the big-integer worker middleware'); } }],
]);
function load(id) {
  if (providers.has(id)) return providers.get(id);
  if (cache.has(id)) return cache.get(id).exports;
  assert(modules.has(id), `Missing bundled module ${id}`);
  const module = { exports: {} };
  cache.set(id, module);
  runInContext(`(${modules.get(id)})`, realm, { timeout: 1000 })(module, module.exports, load);
  return module.exports;
}
load.d = (exports, definition) => {
  for (const [key, get] of Object.entries(definition)) if (!Object.hasOwn(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get });
};
load.n = module => {
  const getter = module?.__esModule ? () => module.default : () => module;
  load.d(getter, { a: getter }); return getter;
};
load.o = (value, key) => Object.hasOwn(value, key);
load.r = exports => { Object.defineProperty(exports, '__esModule', { value: true }); };
load.g = realm;
const client = new (load(61604).v)({ adapter: 'xhr' });
for (const type of [1, 0]) {
  const response = await client.nativePost('/aweme/v1/web/commit/follow/user/', '', {
    user_id: '10004', secUid: 'fixture-peer', type, tag: 'frienddetail', verifyFp: 'verify_10002',
  });
  assert.equal(response.data.status_code, 0);
  const request = requests.at(-1), url = new URL(request.url), headers = new Headers(request.headers);
  assert.equal(request.method, 'POST'); assert.equal(request.body, null, 'XHR adapter sends empty string as null');
  assert.equal(headers.get('accept'), 'application/json, text/plain, */*');
  assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(headers.has('bgint_json_parser'), false);
  assert.equal(url.searchParams.get('type'), String(type));
  assert.equal(url.searchParams.get('user_id'), '10004'); assert.equal(url.searchParams.get('secUid'), 'fixture-peer');
  assert.equal(url.searchParams.get('iid'), '10003'); assert.equal(url.searchParams.get('verifyFp'), 'verify_10002');
  assert.equal(url.searchParams.has('sec_user_id'), false);
}
let responseCases = 0;
for (const status of [200, 503]) for (const text of ['', '{broken', 'null', 'false', '0', '"text"', '{}', '[]']) {
  for (const headers of [{}, { 'bdturing-verify': 'fixture-captcha' },
    { 'x-tt-verify-passport-decision': '{"code":20000}' },
    { 'bdturing-verify': 'fixture-captcha', 'x-tt-verify-passport-decision': '{"code":20000}' }]) {
    reply = { status, text, headers };
    let response, error;
    try { response = await client.nativePost('/aweme/v1/web/commit/follow/user/', '', { user_id: '10004' }); }
    catch (failure) { error = failure; }
    if (status !== 200) {
      assert.equal(error?.name, 'AxiosError'); assert.equal(error.response.status, status);
    } else if (headers['bdturing-verify'] && !['null', '{}', '[]'].includes(text)) {
      assert.equal(error?.name, 'TypeError', 'Assigning verifyData to a primitive fails before the follow handler');
    } else {
      assert.equal(error, undefined);
      if (text === 'null') assert.equal(response.data, null, 'Temporary fallback object is not written back to response.data');
      if (['{}', '[]'].includes(text)) assert.equal(response.data.verifyData, headers['bdturing-verify']);
      assert.equal(response.headers['x-tt-verify-passport-decision'], headers['x-tt-verify-passport-decision']);
    }
    responseCases++;
  }
}
assert.equal(requests.length, 2 + responseCases);
console.log(`Desktop follow oracle: 2 original request and ${responseCases} response middleware cases passed; recording XHR only, no network or account state.`);
