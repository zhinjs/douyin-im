// Installed Desktop source only; synthetic renderer/device/message/XHR inputs.
// No network, account state, browser runtime, native library or production SDK.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';

assert(process.argv[2], 'Pass the extracted Desktop 1.2.1 directory');
function source(path, hash) {
  const bytes = readFileSync(join(process.argv[2], path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  return bytes.toString();
}
const main = source('renderer/main/main_4eaa703b51f46c257250.js',
  '8b13c3f65c721478237b1987c9233ca572e5273b16150e75159a9121d4db6a67');
const chunk = source('renderer/320/320_75874aaf00102d177b13.js',
  '701165fcaa4e60bf8017c7125fcc2e6b673e783c3046f3368eb8d6c14fa3ad3d');
const syntax = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const modules = new Map(), cache = new Map(), requests = [], failures = [], menuActions = [];
function visit(node) {
  if (ts.isPropertyAssignment(node) && ts.isNumericLiteral(node.name) && ts.isFunctionLike(node.initializer)) {
    const id = Number(node.name.text);
    assert(!modules.has(id)); modules.set(id, node.initializer.getText(syntax));
  }
  ts.forEachChild(node, visit);
}
visit(syntax);
let reply = { status: 200, data: { recognition_results: [{ text_result: 'first' }, { text_result: 'second' }] } };
class RecordingXHR {
  onloadend = null;
  status = reply.status;
  statusText = 'fixture';
  responseText = JSON.stringify(reply.data);
  headers = {};
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  getAllResponseHeaders() { return 'content-type: application/json\r\n'; }
  send(body) {
    requests.push({ method: this.method, url: this.url, headers: this.headers, body });
    queueMicrotask(() => this.onloadend());
  }
  abort() { assert.fail('Unexpected abort'); }
}
const realm = createContext({ URL, URLSearchParams, FormData, Blob, setTimeout, clearTimeout,
  XMLHttpRequest: RecordingXHR, window: { location: { protocol: 'file:' } },
  screen: { width: 1728, height: 1117 }, navigator: { language: 'zh-CN', platform: 'fixture-platform',
    appCodeName: 'Mozilla', appVersion: 'fixture-browser', onLine: true, cookieEnabled: true },
});
const providers = new Map([
  [48797, { Pv: { aid: 339757, service: 'https://imdesktop.douyin.com' }, hl: '1.2.1', OD: 'darwin', Nw: 'fixture-os' }],
  [93189, { A: { instance: () => ({ deviceId: '10002', installId: '10003', guid: 'fixture-guid', channel: '20002' }) } }],
  [385, { q() { assert.fail('Audio unexpectedly selected bigint middleware'); } }],
]);
function load(id) {
  if (providers.has(id)) return providers.get(id);
  if (cache.has(id)) return cache.get(id).exports;
  assert(modules.has(id), `Missing module ${id}`);
  const module = { exports: {} }; cache.set(id, module);
  runInContext(`(${modules.get(id)})`, realm, { timeout: 1000 })(module, module.exports, load);
  return module.exports;
}
load.d = (exports, definition) => { for (const [key, get] of Object.entries(definition)) {
  if (!Object.hasOwn(exports, key)) Object.defineProperty(exports, key, { enumerable: true, get });
} };
load.n = module => { const get = module?.__esModule ? () => module.default : () => module;
  load.d(get, { a: get }); return get; };
load.o = (object, key) => Object.hasOwn(object, key);
load.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
load.g = realm;
load.nmd = module => { module.paths = []; module.children ??= []; return module; };
const client = new (load(61604).v)({ adapter: 'xhr' });
// Original cache and MenuText function; React rendering replaced by element capture.
const cacheStart = chunk.indexOf('const Nt=[w.G.VOICE,w.G.VOICE_ENCRYPT];');
const cacheEnd = chunk.indexOf(',Et=', cacheStart);
const menuStart = chunk.indexOf('Mt=({msg:e,onClick:t})=>');
const menuEnd = chunk.indexOf(';var kt=', menuStart);
assert(cacheStart >= 0 && cacheEnd > cacheStart && menuStart >= 0 && menuEnd > menuStart);
Object.assign(realm, { w: { G: { VOICE: 17, VOICE_ENCRYPT: 109 } },
  Tt: { c: client }, Ot: load(14486), i: load(14352),
  s: { b: { instance: { error: (...args) => failures.push(args) } } },
  r: { createElement: (component, props) => props }, vt: 'fixture-menu', wt: 'fixture-show', Rt: 'fixture-hide',
  At: 'fixture-file', xt: 'MenuText', _t: { toText: 'toText' },
});
const extracted = runInContext(`(()=>{${chunk.slice(cacheStart, cacheEnd)};const ${chunk.slice(menuStart, menuEnd)};return {bt,Mt};})()`, realm);
const flush = () => new Promise(resolve => setImmediate(resolve));
let cases = 0;
for (const type of [17, 109]) {
  const message = { type, secSender: 'sender-sec', clientId: 'client-uuid', serverId: `76899999999999999${type}`,
    conversationShortId: '7688888888888888888', parsedContent: {
      resource_url: { uri: 'voice-uri', url_list: ['https://unused.invalid/voice'] },
      tkey: 'encrypted-tkey', skey: type === 109 ? 'fixture-skey' : undefined,
    } };
  let text = '';
  const listener = { onGetText: value => { text = value; }, hide: () => { text = ''; },
    canShow: () => text === '', canHide: () => text !== '' };
  extracted.bt.registeListener(message.serverId, listener);
  const menu = () => extracted.Mt({ msg: message, onClick: value => menuActions.push(value) });
  for (const status of [0, 999]) {
    reply = { status: 200, data: { status_code: status, recognition_results: [{ text_result: 'first' }, { text_result: 'second' }] } };
    assert.equal(menu().text, '转文字'); menu().onClick(); await flush();
    const request = requests.at(-1), url = new URL(request.url), headers = new Headers(request.headers);
    assert.equal(request.method, 'POST'); assert.equal(url.origin, 'https://imdesktop.douyin.com');
    assert.equal(url.pathname, '/aweme/v1/web/im/message/audio/recognition/');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('accept'), 'application/json, text/plain, */*');
    assert.equal(headers.has('bgint_json_parser'), false);
    assert.equal(url.searchParams.has('req_list'), false);
    assert.equal(url.searchParams.get('device_platform'), 'darwin');
    assert.deepEqual(JSON.parse(request.body), { req_list: [{ uri: type === 17 ? 'voice-uri' : 'encrypted-tkey',
      sec_uid: message.secSender, uuid: message.clientId, message_id: message.serverId,
      message_type: type, ...(type === 109 ? { skey: 'fixture-skey' } : {}), conv_short_id: message.conversationShortId }] });
    assert.equal(text, 'first'); assert.equal(menu().text, '收起文字');
    menu().onClick(); assert.equal(text, ''); cases++;
  }
  for (const data of [{}, { recognition_results: [] }, { recognition_results: [{ text_result: '' }] }]) {
    reply = { status: 200, data }; const before = requests.length;
    menu().onClick(); await flush(); assert.equal(text, '');
    assert.equal(requests.length, before + 1); assert.equal(menu().text, '转文字'); cases++;
  }
  reply = { status: 503, data: { recognition_results: [{ text_result: 'must not show' }] } };
  menu().onClick(); await flush(); assert.equal(text, ''); cases++;
  const before = requests.length;
  extracted.bt.receiveText(message.serverId, { text_result: 'restored' });
  extracted.bt.removeListener(message.serverId); assert.equal(menu(), undefined);
  text = ''; extracted.bt.registeListener(message.serverId, listener);
  assert.equal(text, 'restored'); assert.equal(requests.length, before); cases++;
  assert.equal(extracted.Mt({ msg: { ...message, type: 501 }, onClick() {} }), undefined); cases++;
}
assert.equal(failures.length, 6);
console.log(`Desktop audio oracle: ${cases} original menu/cache/request cases passed; ${requests.length} recording XHR requests; no network/account state.`);
